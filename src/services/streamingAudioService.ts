// streaming audio service
// handles efficient audio streaming with parallel caching to the blob store

import { storeBlob } from "@freqhole/api-client/storage";
import type { Song } from "../types/playlist.js";

interface StreamingDownloadResult {
  blobUrl: string;
  downloadPromise: Promise<boolean>;
}

interface DownloadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

type ProgressCallback = (progress: DownloadProgress) => void;

// downloads audio file with streaming, providing immediate url for playback
// while simultaneously caching to the blob store
export async function streamAudioWithCaching(
  song: Song,
  standaloneFilePath: string,
  onProgress?: ProgressCallback
): Promise<StreamingDownloadResult> {
  try {
    // for http/https urls, return the direct url for immediate streaming
    const blobUrl = standaloneFilePath;

    // start background download and caching
    const downloadPromise = downloadAndCacheAudio(
      song,
      standaloneFilePath,
      onProgress
    );

    return {
      blobUrl,
      downloadPromise,
    };
  } catch (error) {
    console.error("error in streamaudiowithcaching:", error);
    throw error;
  }
}

// downloads and caches audio file in the blob store
export async function downloadAndCacheAudio(
  song: Song,
  standaloneFilePath: string,
  onProgress?: ProgressCallback
): Promise<boolean> {
  try {
    // if the song already has a sha, check the blob store.
    // a failed check is non-fatal - proceed with the download.
    if (song.sha ?? song.sha256) {
      try {
        const { getBlobMetadata } = await import(
          "@freqhole/api-client/storage"
        );
        const existing = await getBlobMetadata((song.sha ?? song.sha256)!);
        if (existing) {
          return true; // already cached
        }
      } catch (error) {
        console.error("error checking blob store cache status:", error);
      }
    }

    const response = await fetch(standaloneFilePath);

    if (!response.ok) {
      throw new Error(
        `failed to fetch: ${response.status} ${response.statusText}`
      );
    }

    const contentLength = response.headers.get("content-length");
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("response body is not readable");
    }

    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (value) {
        loaded += value.length;
        chunks.push(value);

        if (onProgress && total > 0) {
          onProgress({
            loaded,
            total,
            percentage: Math.round((loaded / total) * 100),
          });
        }
      }
    }

    // combine chunks into a blob
    const mimeType =
      song.mimeType || response.headers.get("content-type") || "audio/mpeg";
    const audioBlob = new Blob(chunks as BlobPart[], { type: mimeType });

    // store in blob store - the sha256 hash is computed by storeBlob
    await storeBlob(audioBlob, mimeType);

    return true;
  } catch (error) {
    console.error(`error downloading and caching audio for ${song.id}:`, error);
    return false;
  }
}

// tracks active downloads to prevent duplicates
const activeDownloads = new Map<string, Promise<boolean>>();

export function isSongDownloading(songId: string): boolean {
  return activeDownloads.has(songId);
}

// wrapper that tracks active downloads to prevent duplicates
export async function downloadSongIfNeeded(
  song: Song,
  standaloneFilePath: string,
  onProgress?: ProgressCallback
): Promise<boolean> {
  const existingDownload = activeDownloads.get(song.id);
  if (existingDownload) {
    return existingDownload;
  }

  // check if already cached in blob store
  if (song.sha ?? song.sha256) {
    try {
      const { getBlobMetadata } = await import("@freqhole/api-client/storage");
      const existing = await getBlobMetadata((song.sha ?? song.sha256)!);
      if (existing) {
        return true;
      }
    } catch (error) {
      console.error("error checking blob store cache status:", error);
    }
  }

  const downloadPromise = downloadAndCacheAudio(
    song,
    standaloneFilePath,
    onProgress
  );

  activeDownloads.set(song.id, downloadPromise);

  downloadPromise.finally(() => {
    activeDownloads.delete(song.id);
  });

  return downloadPromise;
}
