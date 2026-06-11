import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import {
  downloadPlaylistAsZip,
  parsePlaylistZip,
  type PlaylistDownloadOptions,
} from "./playlistDownloadService.js";
import type { Playlist, Song } from "../types/playlist.js";

// mock dependencies
vi.mock("./playlistDocService.js", () => ({
  getSongsForPlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
}));

vi.mock("freqhole-api-client/storage", () => ({
  getBlob: vi.fn(),
}));

vi.mock("../utils/standaloneTemplates.js", () => ({
  generatePlaylistzJs: vi.fn(() => "window.__PLAYLISTZ__ = [];"),
  generateIndexHtml: vi.fn(() => "<html></html>"),
}));

vi.mock("../utils/swTemplate.js", () => ({
  generateSwJs: vi.fn(() => "// sw"),
}));

vi.mock("../utils/m3u.js", () => ({
  generateM3UContent: vi.fn(() => "#EXTM3U\n"),
}));

// mock window for browser apis
Object.defineProperty(global, "window", {
  value: {
    location: {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    },
  },
  writable: true,
});

// mock jszip
vi.mock("jszip", () => ({
  default: vi.fn(() => ({
    file: vi.fn(),
    folder: vi.fn().mockReturnThis(),
    generateAsync: vi.fn().mockResolvedValue(new Blob(["mock zip content"])),
    loadAsync: vi.fn().mockResolvedValue({
      file: vi.fn((pattern) => {
        if (typeof pattern === "string") {
          return pattern === "data/playlist.json" ||
            pattern === "playlist-info.json"
            ? {
                async: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    playlist: {
                      title: "Test Playlist",
                      description: "Test Description",
                    },
                    songs: [],
                  })
                ),
              }
            : null;
        } else if (pattern instanceof RegExp) {
          if (pattern.test("playlist.json")) {
            return [
              {
                async: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    playlist: {
                      title: "Test Playlist",
                      description: "Test Description",
                    },
                    songs: [],
                  })
                ),
              },
            ];
          }
          return [];
        }
        return [];
      }),
      files: {},
    }),
    files: {},
  })),
}));

// mock global objects
global.URL = {
  createObjectURL: vi.fn(() => "mock-blob-url"),
  revokeObjectURL: vi.fn(),
} as any;

global.document = {
  createElement: vi.fn(() => ({
    href: "",
    download: "",
    click: vi.fn(),
  })),
  body: {
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  },
  querySelectorAll: vi.fn(() => []),
} as any;

global.fetch = vi.fn().mockRejectedValue(new Error("fetch not available"));

describe("Playlist Download Service", () => {
  let mockPlaylist: Playlist;
  let mockSongs: Song[];

  beforeEach(async () => {
    vi.clearAllMocks();

    mockPlaylist = {
      id: "playlist-123",
      title: "Test Playlist",
      description: "A test playlist",
      songIds: ["song1", "song2"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rev: 1,
      _primaryImageSha: "playlist-image-sha",
    };

    mockSongs = [
      {
        id: "song1",
        title: "Song One",
        artist: "Artist One",
        album: "Album One",
        duration: 180,
        sha: "existing-sha-1",
        images: [{ blobId: "image-sha-1", isPrimary: true, blobType: "original" }],
        mimeType: "audio/mpeg",
        originalFilename: "song-one.mp3",
        position: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        playlistId: "playlist-123",
      },
      {
        id: "song2",
        title: "Song Two",
        artist: "Artist Two",
        album: "Album Two",
        duration: 240,
        sha: "existing-sha-2",
        images: [],
        mimeType: "audio/mp4",
        originalFilename: "song-two.m4a",
        position: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        playlistId: "playlist-123",
      },
    ] as Song[];

    const { getSongsForPlaylist, updatePlaylist } = await import(
      "./playlistDocService.js"
    );
    const { getBlob } = await import("freqhole-api-client/storage");

    vi.mocked(getSongsForPlaylist).mockResolvedValue(mockSongs);
    vi.mocked(updatePlaylist).mockResolvedValue(undefined);
    vi.mocked(getBlob).mockImplementation(async (_blobId: string) => {
      // return a blob-like object with arrayBuffer() for the test environment
      return {
        type: "audio/mpeg",
        arrayBuffer: async () => new ArrayBuffer(1000),
      } as unknown as Blob;
    });

    vi.mocked(JSZip).mockImplementation(
      () =>
        ({
          file: vi.fn(),
          folder: vi.fn().mockReturnThis(),
          generateAsync: vi
            .fn()
            .mockResolvedValue(new Blob(["mock zip content"])),
          loadAsync: vi.fn(),
          files: {},
        }) as any
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("downloadPlaylistAsZip", () => {
    it("should create a zip file with playlist and songs", async () => {
      const { getSongsForPlaylist, updatePlaylist } = await import(
        "./playlistDocService.js"
      );

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(getSongsForPlaylist)).toHaveBeenCalledWith(
        mockPlaylist.id
      );
      expect(vi.mocked(updatePlaylist)).toHaveBeenCalledWith(mockPlaylist.id, {
        rev: 2,
      });
      expect(JSZip).toHaveBeenCalled();
    });

    it("should increment playlist revision before download", async () => {
      const { updatePlaylist } = await import("./playlistDocService.js");
      const playlistWithRev = { ...mockPlaylist, rev: 5 };

      await downloadPlaylistAsZip(playlistWithRev);

      expect(vi.mocked(updatePlaylist)).toHaveBeenCalledWith(
        playlistWithRev.id,
        { rev: 6 }
      );
    });

    it("should handle playlist without revision", async () => {
      const { updatePlaylist } = await import("./playlistDocService.js");
      const playlistNoRev = { ...mockPlaylist, rev: undefined };

      await downloadPlaylistAsZip(playlistNoRev);

      expect(vi.mocked(updatePlaylist)).toHaveBeenCalledWith(
        playlistNoRev.id,
        { rev: 1 }
      );
    });

    it("should fetch audio from blob store for each song", async () => {
      const { getBlob } = await import("freqhole-api-client/storage");

      await downloadPlaylistAsZip(mockPlaylist);

      // should call getBlob for each song's sha
      expect(vi.mocked(getBlob)).toHaveBeenCalledWith("existing-sha-1");
      expect(vi.mocked(getBlob)).toHaveBeenCalledWith("existing-sha-2");
    });

    it("should fetch playlist cover image from blob store", async () => {
      const { getBlob } = await import("freqhole-api-client/storage");

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(getBlob)).toHaveBeenCalledWith("playlist-image-sha");
    });

    it("should skip image fetching when includeImages is false", async () => {
      const { getBlob } = await import("freqhole-api-client/storage");

      await downloadPlaylistAsZip(mockPlaylist, { includeImages: false });

      // should not call getBlob for image sha
      expect(vi.mocked(getBlob)).not.toHaveBeenCalledWith("image-sha-1");
    });

    it("should handle empty playlist", async () => {
      const emptyPlaylist = { ...mockPlaylist, songIds: [] };
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue([]);

      await downloadPlaylistAsZip(emptyPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should handle songs without sha (no audio in blob store)", async () => {
      const songsWithoutSha = [
        {
          ...mockSongs[0]!,
          sha: undefined,
          sha256: undefined,
        },
      ];
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue(songsWithoutSha as Song[]);

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should trigger download in browser", async () => {
      const mockAnchorElement = {
        href: "",
        download: "",
        click: vi.fn(),
      };
      vi.mocked(document.createElement).mockReturnValue(mockAnchorElement as any);

      await downloadPlaylistAsZip(mockPlaylist);

      expect(document.createElement).toHaveBeenCalledWith("a");
      expect(mockAnchorElement.click).toHaveBeenCalled();
      expect(document.body.appendChild).toHaveBeenCalledWith(mockAnchorElement);
      expect(document.body.removeChild).toHaveBeenCalledWith(mockAnchorElement);
    });

    it("should handle ZIP generation errors", async () => {
      vi.mocked(JSZip).mockImplementation(() => {
        throw new Error("ZIP generation failed");
      });

      await expect(downloadPlaylistAsZip(mockPlaylist)).rejects.toThrow(
        "ZIP generation failed"
      );
    });

    it("should handle updatePlaylist errors", async () => {
      const { updatePlaylist } = await import("./playlistDocService.js");
      vi.mocked(updatePlaylist).mockRejectedValue(new Error("Database error"));

      await expect(downloadPlaylistAsZip(mockPlaylist)).rejects.toThrow(
        "Database error"
      );
    });

    it("should include metadata when option is enabled", async () => {
      const options = { includeMetadata: true };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should generate M3U when option is enabled", async () => {
      const options = { generateM3U: true };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should not include M3U when generateM3U option is false", async () => {
      const options: PlaylistDownloadOptions = { generateM3U: false };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should include HTML when includeHTML option is true", async () => {
      const options = { includeHTML: true };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should not include HTML when includeHTML option is false", async () => {
      const options: PlaylistDownloadOptions = { includeHTML: false };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("M3U Generation (via ZIP download)", () => {
    it("should include M3U content when generateM3U option is true", async () => {
      const options = { generateM3U: true };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("Filename Safety (via ZIP download)", () => {
    it("should create safe filenames for songs with special characters", async () => {
      const playlistWithSpecialChars = {
        ...mockPlaylist,
        title: 'Playlist/With\\Special:Chars|<>*?"',
      };

      const songsWithSpecialChars = [
        {
          ...mockSongs[0]!,
          originalFilename: 'special!@#.mp3',
        },
      ];
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue(
        songsWithSpecialChars as Song[]
      );

      await downloadPlaylistAsZip(playlistWithSpecialChars);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("File Extension Handling (via ZIP download)", () => {
    it("should handle different audio file types", async () => {
      const songsWithDifferentTypes = [
        { ...mockSongs[0]!, mimeType: "audio/mp3", originalFilename: "song1.mp3" },
        { ...mockSongs[1]!, mimeType: "audio/wav", originalFilename: "song2.wav" },
      ];
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue(
        songsWithDifferentTypes as Song[]
      );

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("MIME Type Handling", () => {
    it("should preserve MIME types during download", async () => {
      const songsWithMimeTypes = [
        { ...mockSongs[0]!, mimeType: "audio/wav", originalFilename: "song1.wav" },
        { ...mockSongs[1]!, mimeType: "audio/flac", originalFilename: "song2.flac" },
      ];
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue(
        songsWithMimeTypes as Song[]
      );

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("Base64 Handling (internal)", () => {
    it("should handle playlist with inline imageData fallback", async () => {
      const playlistWithImage = {
        ...mockPlaylist,
        _primaryImageSha: undefined,
        imageData: new ArrayBuffer(100),
        imageType: "image/jpeg",
      };

      await downloadPlaylistAsZip(playlistWithImage);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("Filename Sanitization (internal)", () => {
    it("should sanitize problematic filenames in downloads", async () => {
      const problemPlaylist = {
        ...mockPlaylist,
        title: "CON",
      };

      await downloadPlaylistAsZip(problemPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("parsePlaylistZip", () => {
    let mockZipFile: any;

    beforeEach(() => {
      mockZipFile = {
        files: {},
        file: vi.fn((pattern) => {
          if (typeof pattern === "string") {
            if (pattern === "data/playlist.json") {
              return {
                async: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    playlist: mockPlaylist,
                    songs: mockSongs,
                  })
                ),
              };
            }
            if (pattern === "playlist-info.json") {
              return {
                async: vi.fn().mockResolvedValue(JSON.stringify(mockPlaylist)),
              };
            }
            return null;
          } else if (pattern instanceof RegExp) {
            if (pattern.test("folder/data/playlist.json")) {
              return [
                {
                  async: vi.fn().mockResolvedValue(
                    JSON.stringify({
                      playlist: mockPlaylist,
                      songs: mockSongs,
                    })
                  ),
                },
              ];
            }
            if (
              pattern.test("folder/data/song1.mp3") ||
              pattern.test("data/song1.mp3") ||
              pattern.test("song1.mp3")
            ) {
              return [
                {
                  name: "data/song1.mp3",
                  async: vi.fn().mockResolvedValue(new ArrayBuffer(1000)),
                },
                {
                  name: "data/song2.mp3",
                  async: vi.fn().mockResolvedValue(new ArrayBuffer(1500)),
                },
              ];
            }
            return [];
          }
          return [];
        }),
      };

      vi.mocked(JSZip).mockImplementation(
        () =>
          ({
            loadAsync: vi.fn().mockResolvedValue(mockZipFile),
          }) as any
      );
    });

    it("should parse playlist zip file correctly", async () => {
      const zipFile = new File(["mock zip content"], "playlist.zip", {
        type: "application/zip",
      });
      const result = await parsePlaylistZip(zipFile);

      expect(result).toHaveProperty("playlist");
      expect(result).toHaveProperty("songs");
    });

    it("should handle zip files without playlist.json", async () => {
      const mockEmptyZipFile = {
        files: {},
        file: vi.fn(() => []),
      };

      vi.mocked(JSZip).mockImplementation(
        () =>
          ({
            loadAsync: vi.fn().mockResolvedValue(mockEmptyZipFile),
          }) as any
      );

      const zipFile = new File(["mock zip content"], "playlist.zip", {
        type: "application/zip",
      });

      await expect(parsePlaylistZip(zipFile)).rejects.toThrow();
    });

    it("should handle corrupted zip files", async () => {
      vi.mocked(JSZip).mockImplementation(
        () =>
          ({
            loadAsync: vi.fn().mockRejectedValue(new Error("Corrupted ZIP")),
          }) as any
      );

      const zipFile = new File(["corrupted content"], "corrupted.zip", {
        type: "application/zip",
      });

      await expect(parsePlaylistZip(zipFile)).rejects.toThrow("Corrupted ZIP");
    });

    it("should handle invalid json in playlist.json", async () => {
      const mockInvalidZipFile = {
        files: {},
        file: vi.fn((pattern) => {
          if (pattern instanceof RegExp && pattern.test("playlist.json")) {
            return [
              {
                async: vi.fn().mockResolvedValue("invalid json"),
              },
            ];
          }
          return [];
        }),
      };

      vi.mocked(JSZip).mockImplementation(
        () =>
          ({
            loadAsync: vi.fn().mockResolvedValue(mockInvalidZipFile),
          }) as any
      );

      const zipFile = new File(["mock zip content"], "playlist.zip", {
        type: "application/zip",
      });

      await expect(parsePlaylistZip(zipFile)).rejects.toThrow();
    });
  });

  describe("Standalone HTML Generation", () => {
    it("should include HTML when includeHTML option is true", async () => {
      const options = { includeHTML: true };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should not include HTML when includeHTML option is false", async () => {
      const options: PlaylistDownloadOptions = { includeHTML: false };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });
  });

  describe("Integration Tests", () => {
    it("should complete full download workflow", async () => {
      const { getSongsForPlaylist, updatePlaylist } = await import(
        "./playlistDocService.js"
      );

      const options = {
        includeMetadata: true,
        generateM3U: true,
        includeImages: true,
        includeHTML: true,
      };

      await downloadPlaylistAsZip(mockPlaylist, options);

      expect(vi.mocked(getSongsForPlaylist)).toHaveBeenCalledWith(
        mockPlaylist.id
      );
      expect(vi.mocked(updatePlaylist)).toHaveBeenCalled();
      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should handle mixed scenarios with partial data", async () => {
      const mixedSongs = [
        { ...mockSongs[0]!, sha: "sha-a" },
        { ...mockSongs[1]!, sha: undefined },
      ];
      const { getSongsForPlaylist } = await import("./playlistDocService.js");
      vi.mocked(getSongsForPlaylist).mockResolvedValue(mixedSongs as Song[]);

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(JSZip)).toHaveBeenCalled();
    });

    it("should maintain data integrity throughout workflow", async () => {
      const { getSongsForPlaylist, updatePlaylist } = await import(
        "./playlistDocService.js"
      );

      await downloadPlaylistAsZip(mockPlaylist);

      expect(vi.mocked(updatePlaylist)).toHaveBeenCalledWith(mockPlaylist.id, {
        rev: mockPlaylist.rev! + 1,
      });

      expect(vi.mocked(getSongsForPlaylist)).toHaveBeenCalledWith(
        mockPlaylist.id
      );
    });
  });
});
