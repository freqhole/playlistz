// tests for the streaming audio service (blob-store backed).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Song } from "../types/playlist.js";

// mock the shared blob store
vi.mock("@freqhole/api-client/storage", () => ({
  storeBlob: vi.fn(),
  getBlobMetadata: vi.fn(),
}));

// mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  streamAudioWithCaching,
  downloadAndCacheAudio,
  downloadSongIfNeeded,
  isSongDownloading,
} from "./streamingAudioService.js";
import { storeBlob, getBlobMetadata } from "@freqhole/api-client/storage";

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: "test-song-1",
    title: "test song",
    artist: "test artist",
    album: "test album",
    duration: 180,
    position: 0,
    mimeType: "audio/mpeg",
    originalFilename: "test.mp3",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playlistId: "test-playlist",
    ...overrides,
  };
}

// build a mock fetch response streaming the given chunks
function makeStreamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string | null> = {}
) {
  let i = 0;
  return {
    ok: true,
    headers: {
      get: vi.fn((name: string) => headers[name] ?? null),
    },
    body: {
      getReader: vi.fn(() => ({
        read: vi.fn(async () => {
          if (i < chunks.length) {
            return { done: false, value: chunks[i++] };
          }
          return { done: true, value: undefined };
        }),
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBlobMetadata).mockResolvedValue(null);
  vi.mocked(storeBlob).mockResolvedValue("mock-sha256");
});

describe("streamAudioWithCaching", () => {
  it("returns the streaming url immediately and a download promise", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1, 2, 3])], {
        "content-length": "3",
        "content-type": "audio/mpeg",
      })
    );

    const result = await streamAudioWithCaching(
      makeSong(),
      "https://example.com/audio.mp3"
    );

    expect(result.blobUrl).toBe("https://example.com/audio.mp3");
    await expect(result.downloadPromise).resolves.toBe(true);
    expect(storeBlob).toHaveBeenCalledTimes(1);
  });
});

describe("downloadAndCacheAudio", () => {
  it("downloads and stores audio in the blob store", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
        "content-length": "4",
        "content-type": "audio/mpeg",
      })
    );

    const result = await downloadAndCacheAudio(
      makeSong(),
      "https://example.com/audio.mp3"
    );

    expect(result).toBe(true);
    expect(storeBlob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeBlob).mock.calls[0]![1]).toBe("audio/mpeg");
  });

  it("returns true without fetching when the sha is already in the blob store", async () => {
    vi.mocked(getBlobMetadata).mockResolvedValue({
      blob_id: "abc",
      storage_type: "opfs",
      storage_path: "/blobs/abc",
      mime_type: "audio/mpeg",
      file_size: 4,
      created_at: Date.now(),
    });

    const result = await downloadAndCacheAudio(
      makeSong({ sha: "abc" }),
      "https://example.com/audio.mp3"
    );

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(storeBlob).not.toHaveBeenCalled();
  });

  it("reports progress when content-length is present", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
        "content-length": "4",
      })
    );
    const onProgress = vi.fn();

    await downloadAndCacheAudio(
      makeSong(),
      "https://example.com/audio.mp3",
      onProgress
    );

    expect(onProgress).toHaveBeenCalledWith({
      loaded: 4,
      total: 4,
      percentage: 100,
    });
  });

  it("handles a missing content-length header (no progress callbacks)", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1, 2, 3])], {})
    );
    const onProgress = vi.fn();

    const result = await downloadAndCacheAudio(
      makeSong(),
      "https://example.com/audio.mp3",
      onProgress
    );

    expect(result).toBe(true);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("falls back to the response content-type when the song has no mime type", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1])], {
        "content-type": "audio/ogg",
      })
    );

    await downloadAndCacheAudio(
      makeSong({ mimeType: "" }),
      "https://example.com/audio.ogg"
    );

    expect(vi.mocked(storeBlob).mock.calls[0]![1]).toBe("audio/ogg");
  });

  it("returns false when the fetch fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: "nope" });

    const result = await downloadAndCacheAudio(
      makeSong(),
      "https://example.com/missing.mp3"
    );

    expect(result).toBe(false);
  });
});

describe("downloadSongIfNeeded", () => {
  it("downloads when not cached", async () => {
    mockFetch.mockResolvedValue(
      makeStreamResponse([new Uint8Array([1, 2, 3])], {})
    );

    const result = await downloadSongIfNeeded(
      makeSong(),
      "https://example.com/audio.mp3"
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("returns true without downloading when the sha is cached", async () => {
    vi.mocked(getBlobMetadata).mockResolvedValue({
      blob_id: "cached",
      storage_type: "opfs",
      storage_path: "/blobs/cached",
      mime_type: "audio/mpeg",
      file_size: 1,
      created_at: Date.now(),
    });

    const result = await downloadSongIfNeeded(
      makeSong({ sha256: "cached" }),
      "https://example.com/audio.mp3"
    );

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("proceeds with download when the cache check throws", async () => {
    vi.mocked(getBlobMetadata).mockRejectedValue(new Error("idb broke"));
    mockFetch.mockResolvedValue(makeStreamResponse([new Uint8Array([1])], {}));

    const result = await downloadSongIfNeeded(
      makeSong({ sha: "whatever" }),
      "https://example.com/audio.mp3"
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("dedupes concurrent downloads for the same song", async () => {
    let resolveRead: (() => void) | undefined;
    const gate = new Promise<void>((r) => (resolveRead = r));
    mockFetch.mockImplementation(async () => {
      await gate;
      return makeStreamResponse([new Uint8Array([1])], {});
    });

    const song = makeSong();
    const p1 = downloadSongIfNeeded(song, "https://example.com/a.mp3");
    const p2 = downloadSongIfNeeded(song, "https://example.com/a.mp3");

    expect(isSongDownloading(song.id)).toBe(true);
    resolveRead?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("clears the active download tracker when finished", async () => {
    mockFetch.mockResolvedValue(makeStreamResponse([new Uint8Array([1])], {}));

    const song = makeSong();
    await downloadSongIfNeeded(song, "https://example.com/a.mp3");
    // allow the .finally cleanup microtask to run
    await Promise.resolve();

    expect(isSongDownloading(song.id)).toBe(false);
  });
});
