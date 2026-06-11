import JSZip from "jszip";
import type { Playlist, Song } from "../types/playlist.js";
import {
  getSongsForPlaylist,
  updatePlaylist,
} from "./playlistDocService.js";
import { getBlob } from "freqhole-api-client/storage";
import {
  generatePlaylistzJs,
  generateIndexHtml,
} from "../utils/standaloneTemplates.js";
import { generateSwJs } from "../utils/swTemplate.js";
import { generateM3UContent } from "../utils/m3u.js";

export interface PlaylistDownloadOptions {
  includeMetadata?: boolean;
  includeImages?: boolean;
  generateM3U?: boolean;
  includeHTML?: boolean;
}

// downloads a playlist as a zip file containing all songs, metadata, and images.
// audio and image bytes are fetched from the blob store keyed by sha256.
export async function downloadPlaylistAsZip(
  playlist: Playlist,
  options: PlaylistDownloadOptions = {
    includeMetadata: true,
    includeImages: true,
    generateM3U: true,
    includeHTML: true,
  }
): Promise<void> {
  try {
    const zip = new JSZip();

    // increment playlist revision before generating the zip
    const currentRev = playlist.rev || 0;
    const newRev = currentRev + 1;
    await updatePlaylist(playlist.id, { rev: newRev });
    const updatedPlaylist = { ...playlist, rev: newRev };

    // get all songs from the doc
    const playlistSongs = await getSongsForPlaylist(playlist.id);

    // create root folder with playlist name
    const rootFolderName = createSafeFileName("", updatedPlaylist.title);
    const rootFolder = zip.folder(rootFolderName);
    const dataFolder = rootFolder!.folder("data");

    // fetch playlist cover image from blob store
    let playlistImageData: ArrayBuffer | undefined;
    let playlistImageType: string | undefined;
    const primaryImageSha = updatedPlaylist._primaryImageSha;
    if (options.includeImages && primaryImageSha) {
      const blob = await getBlob(primaryImageSha);
      if (blob) {
        playlistImageData = await blob.arrayBuffer();
        playlistImageType =
          blob.type || updatedPlaylist.imageType || "image/jpeg";
      }
    } else if (options.includeImages && updatedPlaylist.imageData) {
      // legacy fallback for playlists with inline imageData
      playlistImageData = updatedPlaylist.imageData;
      playlistImageType = updatedPlaylist.imageType;
    }

    // fetch audio and image bytes for each song from the blob store
    const songsWithBytes = await Promise.all(
      playlistSongs.map(async (song) => {
        let audioData: ArrayBuffer | undefined;
        let imageData: ArrayBuffer | undefined;
        let imageType: string | undefined;

        // get audio bytes from blob store
        if (song.sha) {
          const audioBlob = await getBlob(song.sha);
          if (audioBlob) {
            audioData = await audioBlob.arrayBuffer();
          }
        }

        // get song cover image from blob store
        const primaryImageRef =
          song.images?.find((i) => i.isPrimary) ?? song.images?.[0];
        if (options.includeImages && primaryImageRef) {
          const imageBlob = await getBlob(primaryImageRef.blobId);
          if (imageBlob) {
            imageData = await imageBlob.arrayBuffer();
            imageType = imageBlob.type || "image/jpeg";
          }
        } else if (options.includeImages && song.imageData) {
          // legacy fallback
          imageData = song.imageData;
          imageType = song.imageType;
        }

        return { song, audioData, imageData, imageType };
      })
    );

    // build playlist entry for the playlistz.js data file
    const playlistCoverExtension = playlistImageType
      ? getFileExtensionFromMimeType(playlistImageType)
      : undefined;

    const playlistEntry = {
      playlist: {
        id: updatedPlaylist.id,
        title: updatedPlaylist.title,
        description: updatedPlaylist.description,
        rev: updatedPlaylist.rev,
        imageMimeType: playlistImageType || undefined,
        imageFilePath: playlistCoverExtension
          ? `data/playlist-cover${playlistCoverExtension}`
          : undefined,
        safeFilename: createSafeFileName("", updatedPlaylist.title),
        bgFilterEnabled: updatedPlaylist.bgFilterEnabled,
        bgFilterBlur: updatedPlaylist.bgFilterBlur,
        bgFilterContrast: updatedPlaylist.bgFilterContrast,
        bgFilterBrightness: updatedPlaylist.bgFilterBrightness,
        coverFilterEnabled: updatedPlaylist.coverFilterEnabled,
        coverFilterBlur: updatedPlaylist.coverFilterBlur,
      },
      songs: songsWithBytes.map(({ song, audioData, imageData: imgData, imageType: imgType }) => {
        const songImageExt = imgData
          ? getFileExtensionFromMimeType(imgType || "image/jpeg")
          : undefined;
        const safeName = song.originalFilename
          ? sanitizeFilename(song.originalFilename)
          : "";
        const safeBase = safeName.replace(/\.[^.]+$/, "");
        return {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          duration: song.duration || 0,
          originalFilename: song.originalFilename || "",
          safeFilename: safeName,
          fileSize: song.fileSize || audioData?.byteLength || 0,
          mimeType: song.mimeType || "audio/mpeg",
          sha: song.sha,
          imageMimeType: imgType || undefined,
          imageFilePath: songImageExt
            ? `data/${safeBase}-cover${songImageExt}`
            : undefined,
        };
      }),
    };

    // add playlistz.js data file to root folder
    rootFolder!.file("playlistz.js", generatePlaylistzJs([playlistEntry]));

    // add playlist cover image to data folder if available
    if (playlistImageData && playlistImageType) {
      const ext = getFileExtensionFromMimeType(playlistImageType);
      dataFolder!.file(`playlist-cover${ext}`, playlistImageData);
    }

    // add all audio files and their cover images to data folder
    const songFileNames: string[] = [];

    for (const { song, audioData, imageData: imgData, imageType: imgType } of songsWithBytes) {
      if (audioData && song.originalFilename) {
        const safeFileName = sanitizeFilename(song.originalFilename);
        const baseName = safeFileName.replace(/\.[^.]+$/, "");

        dataFolder!.file(safeFileName, audioData);
        songFileNames.push(safeFileName);

        if (options.includeImages && imgData && imgType) {
          const imageExtension = getFileExtensionFromMimeType(imgType);
          dataFolder!.file(`${baseName}-cover${imageExtension}`, imgData);
        }
      }
    }

    // generate m3u8 playlist file
    if (options.generateM3U) {
      const m3uContent = generateM3UContent(
        updatedPlaylist,
        songsWithBytes.map(({ song }) => song),
        songFileNames,
        getFileExtensionFromMimeType
      );
      dataFolder!.file(
        `${createSafeFileName("", updatedPlaylist.title)}.m3u8`,
        m3uContent
      );
    }

    // generate static shell files
    if (options.includeHTML) {
      rootFolder!.file("index.html", generateIndexHtml());
      rootFolder!.file("sw.js", generateSwJs());

      try {
        const scriptEl = Array.from(
          document.querySelectorAll("script[src]")
        ).find(
          (el) => (el as HTMLScriptElement).src.includes("freqhole-playlistz.js")
        ) as HTMLScriptElement | undefined;
        const bundleUrl =
          scriptEl?.src ?? `${window.location.origin}/freqhole-playlistz.js`;
        const appBundleResponse = await fetch(bundleUrl);
        if (appBundleResponse.ok) {
          rootFolder!.file(
            "freqhole-playlistz.js",
            await appBundleResponse.arrayBuffer()
          );
        } else {
          console.warn(
            "could not fetch freqhole-playlistz.js for zip bundle:",
            appBundleResponse.status
          );
        }
      } catch (err) {
        console.warn("could not include freqhole-playlistz.js in zip:", err);
      }

      try {
        const cliResponse = await fetch(
          `${window.location.origin}/freqhole-playlistz-cli.mjs`
        );
        if (cliResponse.ok) {
          rootFolder!.file(
            "freqhole-playlistz-cli.mjs",
            await cliResponse.arrayBuffer()
          );
        } else {
          console.warn(
            "could not fetch freqhole-playlistz-cli.mjs for zip bundle:",
            cliResponse.status
          );
        }
      } catch (err) {
        console.warn(
          "could not include freqhole-playlistz-cli.mjs in zip:",
          err
        );
      }
    }

    // generate and trigger the zip download
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `${rootFolderName}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("error downloading playlist:", error);
    if (
      error instanceof Error &&
      (error.message.includes("ZIP generation failed") ||
        error.message.includes("Database error") ||
        error.message.includes("SHA calculation failed"))
    ) {
      throw error;
    }
    throw new Error("Failed to download playlist");
  }
}

// creates a safe filename from artist and title
function createSafeFileName(artist: string, title: string): string {
  const combined =
    artist && title ? `${artist} - ${title}` : title || artist || "untitled";
  return combined
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 100);
}

// maps a MIME type to a file extension
function getFileExtensionFromMimeType(mimeType: string): string {
  const extensions: { [key: string]: string } = {
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };

  return extensions[mimeType] || ".bin";
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

// sanitizes filenames for cross-platform compatibility
function sanitizeFilename(filename: string): string {
  return (
    filename
      .replace(/\$/g, "_DOLLAR_")
      .replace(/\[/g, "_LBRACKET_")
      .replace(/\]/g, "_RBRACKET_")
      .replace(/\(/g, "_LPAREN_")
      .replace(/\)/g, "_RPAREN_")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
  );
}
