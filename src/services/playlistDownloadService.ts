import type { Playlist, Song } from "../types/playlist.js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getSongsForPlaylist,
  updatePlaylist,
  docToPlaylist,
} from "./playlistDocService.js";
import { findPlaylistDoc } from "./automergeRepo.js";
import { parsePlaylistDoc } from "@freqhole/api-client/playlistz";
import JSZip from "jszip";
import { getBlob } from "@freqhole/api-client/storage";
import { buildPlaylistZip, cleanupOpfsTempFile } from "../zip-bundle/zipBuilder.js";
import type { PlaylistZipEntry, PlaylistZipOptions } from "../zip-bundle/types.js";

export type PlaylistDownloadOptions = PlaylistZipOptions;

// fetches a blob from IDB by sha256 key.
async function idbBlobFetcher(sha256: string): Promise<ArrayBuffer | undefined> {
  const blob = await getBlob(sha256);
  return blob?.arrayBuffer();
}

// builds a PlaylistZipEntry from a Playlist and its songs.
function toZipEntry(playlist: Playlist, songs: Song[]): PlaylistZipEntry {
  return {
    playlist: {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      rev: playlist.rev,
      imageSha: playlist._primaryImageSha,
      imageType: playlist.imageType,
      bgFilterEnabled: playlist.bgFilterEnabled,
      bgFilterBlur: playlist.bgFilterBlur,
      bgFilterContrast: playlist.bgFilterContrast,
      bgFilterBrightness: playlist.bgFilterBrightness,
      coverFilterEnabled: playlist.coverFilterEnabled,
      coverFilterBlur: playlist.coverFilterBlur,
    },
    songs: songs.map((song) => {
      const primaryImage =
        song.images?.find((i) => i.isPrimary) ?? song.images?.[0];
      return {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration ?? 0,
        originalFilename: song.originalFilename ?? "",
        mimeType: song.mimeType ?? "audio/mpeg",
        fileSize: song.fileSize,
        sha: song.sha ?? song.sha256,
        imageSha: primaryImage?.blobId,
        imageType: song.imageType,
      };
    }),
  };
}

// triggers a browser file download for the given blob, then cleans up any
// OPFS temp file that buildPlaylistZip may have used as its write target.
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // revoke after a tick so the browser has time to start the download
  setTimeout(() => {
    URL.revokeObjectURL(url);
    // if blob is an OPFS File, clean up the temp entry by name
    if ("name" in blob && typeof (blob as File).name === "string") {
      void cleanupOpfsTempFile((blob as File).name);
    }
  }, 1000);
}

// downloads a playlist as a zip file containing all songs, metadata, and images.
// audio and image bytes are fetched from the blob store keyed by sha256.
export async function downloadPlaylistAsZip(
  playlist: Playlist,
  options: PlaylistDownloadOptions = {
    includeImages: true,
    generateM3U: true,
    includeHTML: true,
  }
): Promise<void> {
  // increment revision so reimports can detect updates
  const newRev = (playlist.rev ?? 0) + 1;
  await updatePlaylist(playlist.id, { rev: newRev });

  // re-read _primaryImageSha from the live doc - the signal state may be stale
  // if the cover was just set and selectPlaylist was called with raw imageData
  // (which lacks _primaryImageSha)
  const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
  const raw = handle.doc();
  const docPlaylist = raw ? docToPlaylist(playlist.id, parsePlaylistDoc(raw)) : null;
  const updatedPlaylist = {
    ...playlist,
    rev: newRev,
    _primaryImageSha: docPlaylist?._primaryImageSha ?? playlist._primaryImageSha,
    imageType: playlist.imageType ?? docPlaylist?.imageType,
  };

  const songs = await getSongsForPlaylist(playlist.id);
  const entry = toZipEntry(updatedPlaylist, songs);

  // find the embedded bundle url for the standalone app shell
  const scriptEl = Array.from(document.querySelectorAll("script[src]")).find(
    (el) => (el as HTMLScriptElement).src.includes("freqhole-playlistz.js")
  ) as HTMLScriptElement | undefined;
  const appBundleUrl =
    scriptEl?.src ?? `${window.location.origin}/freqhole-playlistz.js`;

  const zipBlob = await buildPlaylistZip(entry, idbBlobFetcher, {
    ...options,
    appBundleUrl,
  });

  const safeTitle = entry.playlist.title.replace(/[^a-zA-Z0-9_-]/g, "_") || "playlist";
  triggerDownload(zipBlob, `${safeTitle}.zip`);
}

// types for imported playlist data that may not match our exact schema
interface ImportedPlaylistData {
  playlist?: {
    id?: string;
    title?: string;
    description?: string;
    imageData?: ArrayBuffer;
    thumbnailData?: ArrayBuffer;
    imageType?: string;
    createdAt?: string;
    updatedAt?: string;
    rev?: number;
    songCount?: number;
    totalDuration?: number;
    imageExtension?: string | null;
    imageMimeType?: string | null;
    imageBase64?: string;
  };
  songs?: ImportedSongMetadata[];
}

interface ImportedSongMetadata {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  originalFilename?: string;
  safeFilename?: string;
  fileSize?: number;
  mimeType?: string;
  position?: number;
  imageData?: ArrayBuffer;
  thumbnailData?: ArrayBuffer;
  imageType?: string;
  imageMimeType?: string | null;
  imageBase64?: string;
  createdAt?: number;
  updatedAt?: number;
  playlistId?: string;
  standaloneFilePath?: string;
  sha?: string;
}

// parses an uploaded zip file and extracts playlist data.
// returns metadata and song objects with inline audioData for the caller to store.
export async function parsePlaylistZip(file: File): Promise<{
  playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt">;
  songs: Omit<Song, "id" | "createdAt" | "updatedAt" | "playlistId">[];
}> {
  try {
    const zip = new JSZip();
    const zipContent = await zip.loadAsync(file);

    let playlistInfo: ImportedPlaylistData["playlist"] | null = null;
    let playlistImageData: ArrayBuffer | undefined;
    let playlistImageType: string | undefined;
    const songs: Omit<Song, "id" | "createdAt" | "updatedAt" | "playlistId">[] =
      [];

    // parse playlist metadata - try new format first, then fall back to old
    let playlistData: ImportedPlaylistData | null = null;
    let playlistJsonFiles = zipContent.file(/^[^/]+\/data\/playlist\.json$/i);
    if (playlistJsonFiles.length === 0) {
      const playlistJsonFile = zipContent.file("data/playlist.json");
      if (playlistJsonFile) {
        playlistJsonFiles = [playlistJsonFile];
      }
    }

    if (playlistJsonFiles.length > 0) {
      const playlistContent = await playlistJsonFiles[0]!.async("string");
      playlistData = JSON.parse(playlistContent);
      playlistInfo = playlistData?.playlist || null;
    } else {
      const playlistInfoFile = zipContent.file("playlist-info.json");
      if (playlistInfoFile) {
        const infoContent = await playlistInfoFile.async("string");
        playlistInfo = JSON.parse(infoContent);
      }
    }

    // find playlist cover image
    let coverFiles = zipContent.file(
      /^[^/]+\/data\/playlist-cover\.(jpg|jpeg|png|gif|webp)$/i
    );
    if (coverFiles.length === 0) {
      coverFiles = zipContent.file(
        /^data\/playlist-cover\.(jpg|jpeg|png|gif|webp)$/i
      );
    }
    if (coverFiles.length === 0) {
      coverFiles = zipContent.file(
        /^playlist-cover\.(jpg|jpeg|png|gif|webp)$/i
      );
    }
    if (coverFiles.length > 0) {
      playlistImageData = await coverFiles[0]!.async("arraybuffer");
      playlistImageType = getMimeTypeFromExtension(coverFiles[0]!.name);
    } else if (playlistData && playlistData.playlist?.imageBase64) {
      playlistImageData = base64ToArrayBuffer(
        playlistData.playlist.imageBase64
      );
      playlistImageType = playlistData.playlist.imageMimeType || undefined;
    }

    // parse m3u file if present (for song order metadata)
    const m3uFiles = zipContent.file(/\.m3u8?$/i);
    if (m3uFiles.length > 0) {
      await m3uFiles[0]!.async("string");
    }

    // extract audio files from data folder or root
    let songFiles = zipContent.file(
      /^[^/]+\/data\/[^/]+\.(mp3|m4a|wav|flac|ogg|webm)$/i
    );
    if (songFiles.length === 0) {
      songFiles = zipContent.file(
        /^data\/[^/]+\.(mp3|m4a|wav|flac|ogg|webm)$/i
      );
    }
    if (songFiles.length === 0) {
      songFiles = zipContent.file(/^[^/]+\.(mp3|m4a|wav|flac|ogg|webm)$/i);
    }

    for (const songFile of songFiles) {
      const audioData = await songFile.async("arraybuffer");
      const fileName = songFile.name.split("/").pop() || "";
      const baseName = fileName.replace(/\.[^.]+$/, "");

      // look up metadata from playlist.json
      let songMetadata: Partial<ImportedSongMetadata> = {};
      if (playlistData && playlistData.songs) {
        const songData = playlistData.songs.find(
          (s: ImportedSongMetadata) =>
            s.safeFilename === fileName || s.originalFilename === fileName
        );
        if (songData) {
          songMetadata = {
            id: songData.id,
            title: songData.title,
            artist: songData.artist,
            album: songData.album,
            duration: songData.duration,
            originalFilename: songData.originalFilename,
            imageBase64: songData.imageBase64,
            imageMimeType: songData.imageMimeType,
          };
        }
      } else {
        const metadataFile = zipContent.file(`${baseName}-metadata.json`);
        if (metadataFile) {
          const metadataContent = await metadataFile.async("string");
          songMetadata = JSON.parse(metadataContent);
        }
      }

      // find cover image for this song
      let imageData: ArrayBuffer | undefined;
      let imageType: string | undefined;

      if (songMetadata.imageBase64) {
        imageData = base64ToArrayBuffer(songMetadata.imageBase64);
        imageType = songMetadata.imageMimeType || undefined;
      } else {
        let imageFiles = zipContent.file(
          new RegExp(
            `^[^/]+/data/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-cover\\.(jpg|jpeg|png|gif|webp)$`,
            "i"
          )
        );
        if (imageFiles.length === 0) {
          imageFiles = zipContent.file(
            new RegExp(
              `^data/${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-cover\\.(jpg|jpeg|png|gif|webp)$`,
              "i"
            )
          );
        }
        if (imageFiles.length === 0) {
          imageFiles = zipContent.file(
            new RegExp(
              `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-cover\\.(jpg|jpeg|png|gif|webp)$`,
              "i"
            )
          );
        }
        if (imageFiles.length > 0) {
          imageData = await imageFiles[0]!.async("arraybuffer");
          imageType = getMimeTypeFromExtension(imageFiles[0]!.name);
        }
      }

      const [artist, title] = baseName.includes(" - ")
        ? baseName.split(" - ", 2)
        : ["Unknown Artist", baseName];

      const song: Omit<Song, "id" | "createdAt" | "updatedAt" | "playlistId"> =
        {
          audioData,
          mimeType: getMimeTypeFromExtension(fileName),
          originalFilename: songMetadata.originalFilename || fileName,
          title: songMetadata.title || title!.replace(/_/g, " "),
          artist: songMetadata.artist || artist!.replace(/_/g, " "),
          album: songMetadata.album || "Unknown Album",
          duration: songMetadata.duration || 0,
          position: songs.length,
          imageData,
          imageType,
        };

      songs.push(song);
    }

    const resultPlaylist: Omit<Playlist, "id" | "createdAt" | "updatedAt"> = {
      title: playlistInfo?.title || file.name.replace(/\.zip$/i, ""),
      description: playlistInfo?.description || "",
      imageData: playlistImageData,
      imageType: playlistImageType,
      songIds: [],
    };

    return { playlist: resultPlaylist, songs };
  } catch (error) {
    console.error("error parsing playlist zip:", error);
    if (
      error instanceof Error &&
      (error.message.includes("Corrupted ZIP") ||
        error.message.includes("Invalid JSON") ||
        error.message.includes("Missing playlist"))
    ) {
      throw error;
    }
    throw new Error("Failed to parse playlist ZIP file");
  }
}

// gets mime type from file extension
function getMimeTypeFromExtension(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop();
  const mimeTypes: { [key: string]: string } = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    webm: "audio/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };

  return mimeTypes[extension || ""] || "application/octet-stream";
}

// converts a base64 string to an ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
