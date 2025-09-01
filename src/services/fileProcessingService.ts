// file processing service for audio filez
// can handle file validation, metadata extraction, and processing!

import { extractAlbumArt, processPlaylistCover } from "./imageService.js";
import type {
  AudioMetadata,
  FileUploadResult,
  Song,
} from "../types/playlist.js";

// check if file is a supported audio format
export function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/");
}

// validate file size (default 100MB limit)
export function validateFileSize(file: File, maxSizeMB = 100): boolean {
  const maxBytes = maxSizeMB * 1024 * 1024;
  return file.size <= maxBytes;
}

// extract basic metadata from file name
function extractMetadataFromFilename(filename: string): Partial<AudioMetadata> {
  // Remove file extension
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");

  // Common patterns: "Artist - Title", "Artist - Album - Title", "Title"
  const dashSplit = nameWithoutExt.split(" - ");

  if (dashSplit.length === 2) {
    return {
      artist: dashSplit[0]?.trim(),
      title: dashSplit[1]?.trim(),
    };
  } else if (dashSplit.length === 3) {
    return {
      artist: dashSplit[0]?.trim(),
      album: dashSplit[1]?.trim(),
      title: dashSplit[2]?.trim(),
    };
  } else {
    return {
      title: nameWithoutExt.trim(),
    };
  }
}

// Extract audio duration using Web Audio API
async function extractDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    try {
      const audio = new Audio();
      const url = URL.createObjectURL(file);

      audio.addEventListener("loadedmetadata", () => {
        URL.revokeObjectURL(url);
        resolve(audio.duration || 0);
      });

      audio.addEventListener("error", (e) => {
        URL.revokeObjectURL(url);
        console.warn("could not extract duration from audio file:", e);
        resolve(0); // Don't reject, just return 0
      });

      audio.src = url;
    } catch (error) {
      console.warn("failed to create blob URL for duration extraction:", error);
      resolve(0); // Return 0 duration if blob URL creation fails
    }
  });
}

// Extract cover art from file using ID3 tags and create both thumbnail and full-size versions
async function extractCoverArt(
  file: File
): Promise<
  | { fullSizeData: ArrayBuffer; thumbnailData: ArrayBuffer; type: string }
  | undefined
> {
  try {
    const result = await extractAlbumArt(file);
    if (result.success && result.albumArt) {
      // Convert blob URL to File object for processing
      const response = await fetch(result.albumArt);
      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: "image/jpeg" });
      const imageFile = new File([blob], "albumart.jpg", {
        type: "image/jpeg",
      });

      // Clean up the blob URL
      URL.revokeObjectURL(result.albumArt);

      // Process the image to create both full-size and thumbnail versions
      const processResult = await processPlaylistCover(imageFile);

      if (
        processResult.success &&
        processResult.imageData &&
        processResult.thumbnailData
      ) {
        return {
          fullSizeData: processResult.imageData,
          thumbnailData: processResult.thumbnailData,
          type: processResult.metadata?.format || "image/jpeg",
        };
      }

      // Fallback: if processing fails, use original as both
      return {
        fullSizeData: arrayBuffer,
        thumbnailData: arrayBuffer,
        type: "image/jpeg",
      };
    }
    return undefined;
  } catch (error) {
    console.warn(
      `o noz! could not extract album art from ${file.name}:`,
      error
    );
    return undefined;
  }
}

// Main metadata extraction function
export async function extractMetadata(file: File): Promise<AudioMetadata> {
  const filenameMetadata = extractMetadataFromFilename(file.name);

  try {
    const duration = await extractDuration(file);
    const coverArt = await extractCoverArt(file);

    return {
      title: filenameMetadata.title || "unknown title",
      artist: filenameMetadata.artist || "unknown artist",
      album: filenameMetadata.album || "unknown album",
      duration,
      coverArtData: coverArt?.fullSizeData,
      coverArtThumbnailData: coverArt?.thumbnailData,
      coverArtType: coverArt?.type,
    };
  } catch (error) {
    console.error("Error extracting metadata:", error);
    return {
      title: filenameMetadata.title || "unknown title",
      artist: filenameMetadata.artist || "unknown artist",
      album: filenameMetadata.album || "unknown album",
      duration: 0,
    };
  }
}

// Process single file upload
export async function processAudioFile(file: File): Promise<FileUploadResult> {
  try {
    // Validate file type
    if (!isAudioFile(file)) {
      return {
        success: false,
        error: `unsupported file type: ${file.type}. Please upload an audio file.`,
      };
    }

    // Validate file size
    if (!validateFileSize(file)) {
      return {
        success: false,
        error: `file too large: ${Math.round(file.size / 1024 / 1024)}MB. maximum size is 100MB.`,
      };
    }

    // Extract metadata
    const metadata = await extractMetadata(file);

    // Create blob URL for audio playback with error handling
    let blobUrl: string | undefined;
    try {
      blobUrl = URL.createObjectURL(file);
    } catch (error) {
      console.warn("Failed to create blob URL for file:", file.name, error);
      // Continue without blob URL - it can be created later when needed
    }

    return {
      success: true,
      song: {
        id: "", // Will be set by the database service
        file,
        blobUrl,
        title: metadata.title || "unknown title",
        artist: metadata.artist || "unknown artist",
        album: metadata.album || "unknown album",
        duration: metadata.duration || 0,
        position: 0, // Will be set when adding to playlist
        imageData: metadata.coverArtData,
        thumbnailData: metadata.coverArtThumbnailData,
        imageType: metadata.coverArtType,
        fileSize: file.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        playlistId: "", // Will be set when adding to playlist
      } as Song,
    };
  } catch (error) {
    console.error("onoz! error processing audio file:", error);
    return {
      success: false,
      error: `error processing file: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

// Process multiple files
export async function processAudioFiles(
  files: FileList | File[]
): Promise<FileUploadResult[]> {
  const fileArray = Array.from(files);
  const results: FileUploadResult[] = [];

  // Process files in parallel but limit concurrency to avoid overwhelming the browser
  const BATCH_SIZE = 3;

  for (let i = 0; i < fileArray.length; i += BATCH_SIZE) {
    const batch = fileArray.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((file) => processAudioFile(file))
    );
    results.push(...batchResults);
  }

  return results;
}

// Filter files to only include audio files
export function filterAudioFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(isAudioFile);
}
