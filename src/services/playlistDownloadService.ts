import JSZip from "jszip";
import type { Playlist, Song } from "../types/playlist.js";
import {
  getSongsWithAudioData,
  updatePlaylist,
  updateSong,
} from "./indexedDBService.js";
import { calculateSHA256 } from "../utils/hashUtils.js";
import {
  generatePlaylistzJs,
  generateIndexHtml,
} from "../utils/standaloneTemplates.js";
import { generateSwJs } from "../utils/swTemplate.js";
import { generateM3UContent } from "../utils/m3u.js";

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

export interface PlaylistDownloadOptions {
  includeMetadata?: boolean;
  includeImages?: boolean;
  generateM3U?: boolean;
  includeHTML?: boolean;
}

/**
 * Downloads a playlist as a ZIP file containing all songs, metadata, and images
 */
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

    // increment playlist revision before download
    const currentRev = playlist.rev || 0;
    const newRev = currentRev + 1;

    // update playlist with new revision
    await updatePlaylist(playlist.id, { rev: newRev });

    const updatedPlaylist = { ...playlist, rev: newRev };

    // get all songs for this playlist with audio data
    const playlistSongs = await getSongsWithAudioData(playlist.songIds);

    // calculate sha for songs that don't have it yet (legacy support)
    const songsWithSHA = await Promise.all(
      playlistSongs.map(async (song) => {
        if (!song.sha && song.audioData) {
          try {
            const sha = await calculateSHA256(song.audioData);
            // update the song in indexeddb with the calculated sha
            await updateSong(song.id, { sha });
            return { ...song, sha };
          } catch (error) {
            console.warn(
              `Failed to calculate SHA for song ${song.title}:`,
              error
            );
            return song;
          }
        }
        return song;
      })
    );

    // audio data is now always stored in indexeddb during initialization

    // create root folder with playlist name
    const rootFolderName = createSafeFileName("", updatedPlaylist.title);
    const rootFolder = zip.folder(rootFolderName);

    // create data folder inside root folder
    const dataFolder = rootFolder!.folder("data");

    // build playlist entry for the playlistz.js data file
    const playlistEntry = {
      playlist: {
        id: updatedPlaylist.id,
        title: updatedPlaylist.title,
        description: updatedPlaylist.description,
        rev: updatedPlaylist.rev,
        imageExtension: updatedPlaylist.imageData
          ? getFileExtensionFromMimeType(
              updatedPlaylist.imageType || "image/jpeg"
            )
          : undefined,
        imageMimeType: updatedPlaylist.imageType || undefined,
        safeFilename: createSafeFileName("", updatedPlaylist.title),
      },
      songs: songsWithSHA.map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration || 0,
        originalFilename: song.originalFilename || "",
        safeFilename: song.originalFilename
          ? sanitizeFilename(song.originalFilename)
          : "",
        fileSize: song.fileSize || song.audioData?.byteLength || 0,
        mimeType: song.mimeType || "audio/mpeg",
        sha: song.sha,
        imageExtension: song.imageData
          ? getFileExtensionFromMimeType(song.imageType || "image/jpeg")
          : undefined,
        imageMimeType: song.imageType || undefined,
      })),
    };

    // add playlistz.js data file to root folder
    rootFolder!.file("playlistz.js", generatePlaylistzJs([playlistEntry]));

    // add playlist cover image to data folder if it exists
    if (
      options.includeImages &&
      updatedPlaylist.imageData &&
      updatedPlaylist.imageType
    ) {
      const extension = getFileExtensionFromMimeType(updatedPlaylist.imageType);
      dataFolder!.file(`playlist-cover${extension}`, updatedPlaylist.imageData);
    }

    // add all audio files to data folder
    const songFileNames: string[] = [];

    for (const song of songsWithSHA) {
      if (song.audioData && song.originalFilename) {
        // create safe filename for zip while keeping original in metadata
        const safeFileName = sanitizeFilename(song.originalFilename);
        const baseName = safeFileName.replace(/\.[^.]+$/, "");

        dataFolder!.file(safeFileName, song.audioData);
        songFileNames.push(safeFileName);

        // add song cover art if it exists
        if (options.includeImages && song.imageData && song.imageType) {
          const imageExtension = getFileExtensionFromMimeType(song.imageType);
          const imageFileName = `${baseName}-cover${imageExtension}`;
          dataFolder!.file(imageFileName, song.imageData);
        }

        // add individual song metadata
        // metadata is now included in the main playlist.json file
      }
    }

    // generate m3u8 playlist file in data folder
    if (options.generateM3U) {
      const m3uContent = generateM3UContent(
        updatedPlaylist,
        songsWithSHA,
        songFileNames,
        getFileExtensionFromMimeType
      );
      dataFolder!.file(
        `${createSafeFileName("", updatedPlaylist.title)}.m3u8`,
        m3uContent
      );
    }

    // generate static shell files in root folder
    if (options.includeHTML) {
      rootFolder!.file("index.html", generateIndexHtml());
      rootFolder!.file("sw.js", generateSwJs());
    }

    // generate and download the zip file
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = `${rootFolderName}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // clean up the url
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Error downloading playlist:", error);
    // Preserve original error message if it's descriptive
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

/**
/**
 * Creates a safe filename from artist and title
 */
function createSafeFileName(artist: string, title: string): string {
  const combined =
    artist && title ? `${artist} - ${title}` : title || artist || "untitled";
  return combined
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .substring(0, 100); // Limit length
}

/**
 * Gets file extension from MIME type
 */
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

/**
 * Parses an uploaded ZIP file and extracts playlist data
 */
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

    // Parse playlist metadata - try new format first, then fall back to old format
    let playlistData: ImportedPlaylistData | null = null;
    // Try with root folder first
    let playlistJsonFiles = zipContent.file(/^[^/]+\/data\/playlist\.json$/i);
    if (playlistJsonFiles.length === 0) {
      // Fall back to direct data folder
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
      // Fall back to old format
      const playlistInfoFile = zipContent.file("playlist-info.json");
      if (playlistInfoFile) {
        const infoContent = await playlistInfoFile.async("string");
        playlistInfo = JSON.parse(infoContent);
      }
    }

    // Find playlist cover image - try data folder first, then root
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
      // Use embedded base64 image from playlist.json
      playlistImageData = base64ToArrayBuffer(
        playlistData.playlist.imageBase64
      );
      playlistImageType = playlistData.playlist.imageMimeType || undefined;
    }

    // Parse M3U file if present to get song order and metadata
    const m3uFiles = zipContent.file(/\.m3u8?$/i);
    if (m3uFiles.length > 0) {
      await m3uFiles[0]!.async("string");
    }

    // Extract songs from data folder first, then fall back to root directory
    // Account for root playlist folder in ZIP structure
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

      // Get metadata from playlist.json if available, otherwise try individual metadata file
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
        // Fall back to old individual metadata files
        const metadataFile = zipContent.file(`${baseName}-metadata.json`);
        if (metadataFile) {
          const metadataContent = await metadataFile.async("string");
          songMetadata = JSON.parse(metadataContent);
        }
      }

      // Try to find corresponding cover image - first check for embedded base64, then files
      let imageData: ArrayBuffer | undefined;
      let imageType: string | undefined;

      if (songMetadata.imageBase64) {
        imageData = base64ToArrayBuffer(songMetadata.imageBase64);
        imageType = songMetadata.imageMimeType || undefined;
      } else {
        // Check for image files in data folder first, then root
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

      // Extract basic info from filename if no metadata
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

    // Create playlist object
    const playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt"> = {
      title: playlistInfo?.title || file.name.replace(/\.zip$/i, ""),
      description: playlistInfo?.description || "",
      imageData: playlistImageData,
      imageType: playlistImageType,
      songIds: [], // Will be populated when songs are saved
    };

    return { playlist, songs };
  } catch (error) {
    console.error("Error parsing playlist ZIP:", error);
    // Preserve original error message if it's descriptive
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

/**
 * Gets MIME type from file extension
 */
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

/**
 * Helper function to convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Sanitizes filenames for better cross-platform compatibility
 */
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

