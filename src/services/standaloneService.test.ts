import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSong } from "../utils/mockData.js";

// mock dependencies using factory pattern
vi.mock("./indexedDBService.js", () => ({
  saveSetting: vi.fn().mockResolvedValue(undefined),
  loadSetting: vi.fn().mockResolvedValue(null),
  DB_NAME: "musicPlaylistDB",
  PLAYLISTS_STORE: "playlists",
  SONGS_STORE: "songs",
}));

vi.mock("./automergeRepo.js", () => ({
  createPlaylistDoc: vi.fn().mockReturnValue({
    docId: "automerge:test123",
    handle: {
      change: vi.fn(),
      doc: vi.fn().mockReturnValue({}),
    },
  }),
  findPlaylistDoc: vi.fn().mockReturnValue({
    change: vi.fn(),
    doc: vi.fn().mockReturnValue({}),
  }),
}));

vi.mock("./docIndexService.js", () => ({
  addDocIndexEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./playlistDocService.js", () => ({
  docToPlaylist: vi.fn().mockReturnValue({
    id: "automerge:test123",
    title: "test",
    songIds: [],
    createdAt: 0,
    updatedAt: 0,
  }),
  setSongCoverImage: vi.fn().mockResolvedValue(undefined),
  setPlaylistCoverImage: vi.fn().mockResolvedValue(undefined),
  getSongsForPlaylist: vi.fn().mockResolvedValue([]),
  getSongById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../types/playlistz", () => ({
  emptyPlaylistDoc: vi.fn().mockReturnValue({}),
  upsertSong: vi.fn(),
  setMetadata: vi.fn(),
  parsePlaylistDoc: vi.fn().mockReturnValue({
    title: "",
    order: [],
    songs: {},
    images: [],
    description: "",
  }),
}));

vi.mock("@freqhole/api-client/storage", () => ({
  getBlobMetadata: vi.fn().mockResolvedValue(null),
}));

vi.mock("./streamingAudioService.js", () => ({
  downloadSongIfNeeded: vi.fn().mockResolvedValue(true),
}));

vi.mock("./songReactivity.js", () => ({
  triggerSongUpdateWithOptions: vi.fn(),
}));

// import after mocks are set up
import {
  standaloneLoadingProgress,
  setStandaloneLoadingProgress,
  initializeStandalonePlaylist,
  initializeAllStandalonePlaylists,
  loadStandaloneSongAudioData,
  songNeedsAudioData,
  clearStandaloneLoadingProgress,
  registerStandalonePath,
  clearStandaloneRegistry,
} from "./standaloneService.js";
import { loadSetting, saveSetting } from "./indexedDBService.js";
import { createPlaylistDoc, findPlaylistDoc } from "./automergeRepo.js";
import { addDocIndexEntry } from "./docIndexService.js";
import { getSongsForPlaylist, getSongById } from "./playlistDocService.js";
import { getBlobMetadata } from "@freqhole/api-client/storage";
import { downloadSongIfNeeded } from "./streamingAudioService.js";

// mock solid-js
vi.mock("solid-js", () => {
  let currentProgress: any = null;

  return {
    createSignal: vi.fn(() => [
      () => currentProgress,
      (value: any) => {
        currentProgress = value;
      },
    ]),
  };
});

// mock global objects
global.fetch = vi.fn();

describe("Standalone Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStandaloneRegistry();

    // default: no existing setting (first boot)
    vi.mocked(loadSetting).mockResolvedValue(null);
    vi.mocked(saveSetting).mockResolvedValue(undefined);
    vi.mocked(getSongsForPlaylist).mockResolvedValue([]);
    vi.mocked(getSongById).mockResolvedValue(null);
    vi.mocked(getBlobMetadata).mockResolvedValue(null);
    vi.mocked(downloadSongIfNeeded).mockResolvedValue(true);
    vi.mocked(createPlaylistDoc).mockReturnValue({
      docId: "automerge:test123",
      handle: { change: vi.fn(), doc: vi.fn().mockReturnValue({}) },
    } as any);
    vi.mocked(findPlaylistDoc).mockReturnValue({
      change: vi.fn(),
      doc: vi.fn().mockReturnValue({}),
    } as any);
    vi.mocked(addDocIndexEntry).mockResolvedValue(undefined);

    // reset progress
    setStandaloneLoadingProgress(null);

    // default window location to https
    Object.defineProperty(window, "location", {
      value: { protocol: "https:", origin: "https://localhost:3000" },
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Loading Progress Management", () => {
    it("should initialize with null progress", () => {
      expect(standaloneLoadingProgress()).toBeNull();
    });

    it("should update loading progress", () => {
      const progress = {
        current: 5,
        total: 10,
        currentSong: "Song Title",
        phase: "updating" as const,
      };

      setStandaloneLoadingProgress(progress);
      expect(standaloneLoadingProgress()).toEqual(progress);
    });

    it("should clear loading progress", () => {
      setStandaloneLoadingProgress({
        current: 5,
        total: 10,
        currentSong: "Song Title",
        phase: "updating",
      });

      setStandaloneLoadingProgress(null);
      expect(standaloneLoadingProgress()).toBeNull();
    });

    it("should handle different loading phases", () => {
      const phases = [
        "initializing",
        "checking",
        "updating",
        "complete",
        "reloading",
      ] as const;

      phases.forEach((phase) => {
        setStandaloneLoadingProgress({
          current: 1,
          total: 1,
          currentSong: "Test Song",
          phase,
        });

        expect(standaloneLoadingProgress()?.phase).toBe(phase);
      });
    });
  });

  describe("initializeStandalonePlaylist", () => {
    let mockPlaylistData: any;
    let mockCallbacks: any;

    beforeEach(() => {
      mockPlaylistData = {
        playlist: {
          id: "standalone-playlist",
          title: "Standalone Playlist",
          description: "A test playlist",
          rev: 1,
        },
        songs: [
          {
            id: "song1",
            title: "Song One",
            artist: "Artist One",
            album: "Album One",
            duration: 180,
            originalFilename: "song1.mp3",
            fileSize: 1000000,
          },
          {
            id: "song2",
            title: "Song Two",
            artist: "Artist Two",
            album: "Album Two",
            duration: 240,
            originalFilename: "song2.mp3",
            fileSize: 1500000,
          },
        ],
      };

      mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };
    });

    it("should initialize standalone playlist successfully on first boot", async () => {
      // first boot: no existing setting
      vi.mocked(loadSetting).mockResolvedValue(null);

      await initializeStandalonePlaylist(mockPlaylistData, mockCallbacks);

      expect(loadSetting).toHaveBeenCalledWith(
        "standalone:standalone-playlist"
      );
      expect(createPlaylistDoc).toHaveBeenCalled();
      expect(addDocIndexEntry).toHaveBeenCalled();
      expect(saveSetting).toHaveBeenCalledWith(
        "standalone:standalone-playlist",
        expect.objectContaining({ rev: 1, docId: "automerge:test123" })
      );
      expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
      expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
    });

    it("should use existing doc when rev is unchanged", async () => {
      vi.mocked(loadSetting).mockResolvedValue({
        rev: 1,
        docId: "automerge:existing",
      });

      await initializeStandalonePlaylist(mockPlaylistData, mockCallbacks);

      expect(createPlaylistDoc).not.toHaveBeenCalled();
      expect(saveSetting).not.toHaveBeenCalled();
      expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
      expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
    });

    it("should update existing doc when rev increases", async () => {
      vi.mocked(loadSetting).mockResolvedValue({
        rev: 0,
        docId: "automerge:existing",
      });

      await initializeStandalonePlaylist(mockPlaylistData, mockCallbacks);

      expect(createPlaylistDoc).not.toHaveBeenCalled();
      expect(saveSetting).toHaveBeenCalledWith(
        "standalone:standalone-playlist",
        expect.objectContaining({ rev: 1, docId: "automerge:existing" })
      );
      expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
      expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
    });

    it("should handle database errors gracefully", async () => {
      vi.mocked(loadSetting).mockRejectedValue(
        new Error("Database setup failed")
      );

      await initializeStandalonePlaylist(mockPlaylistData, mockCallbacks);

      expect(mockCallbacks.setError).toHaveBeenCalledWith(
        expect.stringContaining("failed to load")
      );
    });

    it("should handle invalid playlist data", async () => {
      const invalidData = {} as any;

      await initializeStandalonePlaylist(invalidData, mockCallbacks);

      expect(mockCallbacks.setError).toHaveBeenCalled();
    });

    it("should handle missing callbacks gracefully", async () => {
      const partialCallbacks = {
        setSelectedPlaylist: vi.fn(),
        // missing other callbacks
      };

      await expect(
        initializeStandalonePlaylist(mockPlaylistData, partialCallbacks as any)
      ).rejects.toThrow("callbacks.setError is not a function");
    });

    it("should populate songs with standaloneFilePath", async () => {
      vi.mocked(loadSetting).mockResolvedValue(null);

      await initializeStandalonePlaylist(mockPlaylistData, mockCallbacks);

      const calledSongs = mockCallbacks.setPlaylistSongs.mock.calls[0][0];
      expect(calledSongs[0].standaloneFilePath).toBe("data/song1.mp3");
      expect(calledSongs[1].standaloneFilePath).toBe("data/song2.mp3");
    });
  });

  describe("initializeAllStandalonePlaylists", () => {
    it("should call initializeStandalonePlaylist for each entry", async () => {
      const mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };

      vi.mocked(loadSetting).mockResolvedValue(null);

      const entry = (id: string) => ({
        playlist: {
          id,
          title: `playlist ${id}`,
          description: "test",
          rev: 1,
        },
        songs: [
          {
            id: `${id}-song1`,
            title: "song one",
            artist: "artist",
            album: "album",
            duration: 180,
            originalFilename: "song1.mp3",
            fileSize: 1000000,
            sha: "abc123",
          },
        ],
      });

      await initializeAllStandalonePlaylists(
        [entry("pl-a"), entry("pl-b")],
        mockCallbacks
      );

      // each playlist entry triggers setSelectedPlaylist and setPlaylistSongs
      expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalledTimes(2);
      expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadStandaloneSongAudioData", () => {
    beforeEach(() => {
      clearStandaloneRegistry();
    });

    it("should return true for file:// protocol", async () => {
      Object.defineProperty(window, "location", {
        value: { protocol: "file:" },
        writable: true,
      });

      const result = await loadStandaloneSongAudioData("any-song");
      expect(result).toBe(true);
      expect(downloadSongIfNeeded).not.toHaveBeenCalled();
    });

    it("should return false when song has no registered path", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const result = await loadStandaloneSongAudioData("unregistered-song");

      expect(result).toBe(false);
      expect(downloadSongIfNeeded).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should load audio data for registered song successfully", async () => {
      registerStandalonePath("test-song", "data/test.mp3");
      vi.mocked(getSongById).mockResolvedValue(
        createMockSong({ id: "test-song", sha: "abc123" })
      );
      vi.mocked(downloadSongIfNeeded).mockResolvedValue(true);

      const result = await loadStandaloneSongAudioData("test-song");

      expect(downloadSongIfNeeded).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("should handle fetch errors gracefully", async () => {
      registerStandalonePath("test-song", "data/test.mp3");
      vi.mocked(downloadSongIfNeeded).mockRejectedValue(
        new Error("Network error")
      );

      const result = await loadStandaloneSongAudioData("test-song");

      expect(result).toBe(false);
    });

    it("should handle database errors", async () => {
      registerStandalonePath("test-song", "data/test.mp3");
      vi.mocked(getSongById).mockRejectedValue(new Error("Database error"));

      const result = await loadStandaloneSongAudioData("test-song");

      expect(result).toBe(false);
    });

    it("should skip loading for file:// protocol without checking path", async () => {
      Object.defineProperty(window, "location", {
        value: { protocol: "file:" },
        writable: true,
      });

      const result = await loadStandaloneSongAudioData("file-protocol-song");

      expect(result).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should build minimal song object when getSongById returns null", async () => {
      registerStandalonePath("orphan-song", "data/orphan.mp3");
      vi.mocked(getSongById).mockResolvedValue(null);
      vi.mocked(downloadSongIfNeeded).mockResolvedValue(true);

      const result = await loadStandaloneSongAudioData("orphan-song");

      expect(downloadSongIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ id: "orphan-song" }),
        "data/orphan.mp3"
      );
      expect(result).toBe(true);
    });
  });

  describe("songNeedsAudioData", () => {
    it("should return false for file:// protocol", async () => {
      Object.defineProperty(window, "location", {
        value: { protocol: "file:" },
        writable: true,
      });

      const mockSong = createMockSong({
        id: "test-song",
        sha: "some-sha",
      });

      const result = await songNeedsAudioData(mockSong);

      expect(result).toBe(false);
      expect(getBlobMetadata).not.toHaveBeenCalled();
    });

    it("should return true for song without sha", async () => {
      const mockSong = createMockSong({
        id: "test-song",
        sha: undefined,
      });

      const result = await songNeedsAudioData(mockSong as any);

      expect(result).toBe(true);
      expect(getBlobMetadata).not.toHaveBeenCalled();
    });

    it("should return false for song with blob in store", async () => {
      vi.mocked(getBlobMetadata).mockResolvedValue({ size: 1000 } as any);

      const mockSong = createMockSong({
        id: "test-song",
        sha: "sha-in-store",
      });

      const result = await songNeedsAudioData(mockSong);

      expect(getBlobMetadata).toHaveBeenCalledWith("sha-in-store");
      expect(result).toBe(false);
    });

    it("should return true for song not in blob store", async () => {
      vi.mocked(getBlobMetadata).mockResolvedValue(null);

      const mockSong = createMockSong({
        id: "test-song",
        sha: "missing-sha",
      });

      const result = await songNeedsAudioData(mockSong);

      expect(getBlobMetadata).toHaveBeenCalledWith("missing-sha");
      expect(result).toBe(true);
    });

    it("should return true on blob store error", async () => {
      vi.mocked(getBlobMetadata).mockRejectedValue(new Error("storage error"));

      const mockSong = createMockSong({
        id: "test-song",
        sha: "error-sha",
      });

      const result = await songNeedsAudioData(mockSong);

      expect(result).toBe(true);
    });

    it("should use sha256 field as fallback when sha is absent", async () => {
      vi.mocked(getBlobMetadata).mockResolvedValue(null);

      const mockSong = {
        ...createMockSong({ id: "test-song" }),
        sha: undefined,
        sha256: "fallback-sha",
      };

      const result = await songNeedsAudioData(mockSong as any);

      expect(getBlobMetadata).toHaveBeenCalledWith("fallback-sha");
      expect(result).toBe(true);
    });
  });

  describe("clearStandaloneLoadingProgress", () => {
    it("should clear loading progress", () => {
      setStandaloneLoadingProgress({
        current: 5,
        total: 10,
        currentSong: "Test Song",
        phase: "updating",
      });

      expect(standaloneLoadingProgress()).not.toBeNull();

      clearStandaloneLoadingProgress();

      expect(standaloneLoadingProgress()).toBeNull();
    });

    it("should handle clearing when already null", () => {
      setStandaloneLoadingProgress(null);
      expect(standaloneLoadingProgress()).toBeNull();

      expect(() => {
        clearStandaloneLoadingProgress();
      }).not.toThrow();

      expect(standaloneLoadingProgress()).toBeNull();
    });
  });

  describe("Integration with other services", () => {
    it("should properly integrate with doc creation on first boot", async () => {
      vi.mocked(loadSetting).mockResolvedValue(null);

      const mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };

      const playlistData = {
        playlist: {
          id: "integration-pl",
          title: "integration playlist",
          description: "test",
          rev: 0,
        },
        songs: [
          {
            id: "integration-song",
            title: "integration song",
            artist: "artist",
            album: "album",
            duration: 180,
            originalFilename: "integration.mp3",
            fileSize: 1000000,
          },
        ],
      };

      await initializeStandalonePlaylist(playlistData, mockCallbacks);

      expect(createPlaylistDoc).toHaveBeenCalled();
      expect(getSongsForPlaylist).toHaveBeenCalledWith("automerge:test123");
      expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
    });

    it("should handle progress updates correctly", () => {
      const progressStates = [
        { phase: "initializing", current: 0, total: 5 },
        { phase: "checking", current: 1, total: 5 },
        { phase: "updating", current: 3, total: 5 },
        { phase: "complete", current: 5, total: 5 },
      ] as const;

      progressStates.forEach((state) => {
        setStandaloneLoadingProgress({
          ...state,
          currentSong: "Test Song",
        });

        const currentProgress = standaloneLoadingProgress();
        expect(currentProgress?.phase).toBe(state.phase);
        expect(currentProgress?.current).toBe(state.current);
        expect(currentProgress?.total).toBe(state.total);
      });
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle malformed playlist data", async () => {
      const malformedData = {
        songs: [],
      };

      const mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };

      await initializeStandalonePlaylist(malformedData as any, mockCallbacks);

      expect(mockCallbacks.setError).toHaveBeenCalled();
    });

    it("should handle very large song datasets", async () => {
      registerStandalonePath("large-song", "data/large.mp3");
      vi.mocked(downloadSongIfNeeded).mockResolvedValue(true);

      const result = await loadStandaloneSongAudioData("large-song");

      expect(result).toBe(true);
    });

    it("should handle network timeouts gracefully", async () => {
      registerStandalonePath("timeout-song", "data/timeout.mp3");
      vi.mocked(downloadSongIfNeeded).mockRejectedValue(
        new Error("Network timeout")
      );

      const result = await loadStandaloneSongAudioData("timeout-song");

      expect(result).toBe(false);
    });

    it("should handle concurrent song loading", async () => {
      const songIds = ["song1", "song2", "song3"];
      songIds.forEach((id) => registerStandalonePath(id, `data/${id}.mp3`));
      vi.mocked(downloadSongIfNeeded).mockResolvedValue(true);

      const promises = songIds.map((songId) =>
        loadStandaloneSongAudioData(songId)
      );
      const results = await Promise.all(promises);

      expect(results.every((result) => result === true)).toBe(true);
    });
  });

  describe("Performance Considerations", () => {
    it("should handle rapid progress updates efficiently", async () => {
      const startTime = performance.now();

      for (let i = 0; i < 1000; i++) {
        setStandaloneLoadingProgress({
          current: i,
          total: 1000,
          currentSong: `Song ${i}`,
          phase: "updating",
        });
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(50);
      expect(standaloneLoadingProgress()?.current).toBe(999);
    });

    it("should handle audio data checking efficiently", async () => {
      vi.mocked(getBlobMetadata).mockResolvedValue(null);

      const startTime = performance.now();

      const songs = Array.from({ length: 100 }, (_, i) =>
        createMockSong({ id: `song${i}`, title: `song ${i}`, sha: `sha-${i}` })
      );

      const promises = songs.map((song) => songNeedsAudioData(song));
      await Promise.all(promises);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(200);
    });
  });

  describe("Advanced Playlist Scenarios", () => {
    describe("initializeStandalonePlaylist with existing data", () => {
      it("should handle playlist revision updates", async () => {
        vi.mocked(loadSetting).mockResolvedValue({
          rev: 1,
          docId: "automerge:old",
        });

        const playlistData = {
          playlist: {
            id: "existing-playlist",
            title: "updated playlist",
            description: "test description",
            rev: 2,
          },
          songs: [
            {
              id: "existing-song",
              title: "updated song",
              artist: "test artist",
              album: "test album",
              duration: 180,
              sha: "new-sha",
              originalFilename: "updated.mp3",
              fileSize: 1024,
            },
          ],
        };

        const mockCallbacks = {
          setSelectedPlaylist: vi.fn(),
          setPlaylistSongs: vi.fn(),
          setSidebarCollapsed: vi.fn(),
          setError: vi.fn(),
        };

        await initializeStandalonePlaylist(playlistData, mockCallbacks);

        expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
        expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
        expect(saveSetting).toHaveBeenCalledWith(
          "standalone:existing-playlist",
          expect.objectContaining({ rev: 2, docId: "automerge:old" })
        );
      });

      it("should skip update when revision is same", async () => {
        vi.mocked(loadSetting).mockResolvedValue({
          rev: 1,
          docId: "automerge:same",
        });

        const playlistData = {
          playlist: {
            id: "same-rev-playlist",
            title: "same rev playlist",
            rev: 1,
          },
          songs: [
            {
              id: "song1",
              title: "song one",
              artist: "test artist",
              album: "test album",
              duration: 180,
              originalFilename: "song1.mp3",
              fileSize: 1024,
              sha: "same-sha",
            },
          ],
        };

        const mockCallbacks = {
          setSelectedPlaylist: vi.fn(),
          setPlaylistSongs: vi.fn(),
          setSidebarCollapsed: vi.fn(),
          setError: vi.fn(),
        };

        await initializeStandalonePlaylist(playlistData, mockCallbacks);

        expect(createPlaylistDoc).not.toHaveBeenCalled();
        expect(saveSetting).not.toHaveBeenCalled();
        expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
        expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
      });

      it("should create new playlist when none exists", async () => {
        vi.mocked(loadSetting).mockResolvedValue(null);

        const playlistData = {
          playlist: {
            id: "brand-new-playlist",
            title: "Brand New Playlist",
            description: "A completely new playlist",
            rev: 0,
          },
          songs: [
            {
              id: "new-song",
              title: "new song",
              artist: "test artist",
              album: "test album",
              duration: 180,
              originalFilename: "new.mp3",
              fileSize: 1024,
              sha: "new-sha",
            },
          ],
        };

        const mockCallbacks = {
          setSelectedPlaylist: vi.fn(),
          setPlaylistSongs: vi.fn(),
          setSidebarCollapsed: vi.fn(),
          setError: vi.fn(),
        };

        await initializeStandalonePlaylist(playlistData, mockCallbacks);

        expect(createPlaylistDoc).toHaveBeenCalled();
        expect(mockCallbacks.setSelectedPlaylist).toHaveBeenCalled();
        expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
      });
    });

    describe("loadStandaloneSongAudioData edge cases", () => {
      it("should skip loading for file:// protocol", async () => {
        Object.defineProperty(window, "location", {
          value: { protocol: "file:" },
          writable: true,
        });

        const result = await loadStandaloneSongAudioData("file-protocol-song");

        expect(result).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      });

      it("should return false when song has no registered standalone path", async () => {
        const consoleSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});

        const result = await loadStandaloneSongAudioData("no-path-song");

        expect(result).toBe(false);
        consoleSpy.mockRestore();
      });
    });

    describe("songNeedsAudioData advanced scenarios", () => {
      it("should return true for song with zero-length sha", async () => {
        vi.mocked(getBlobMetadata).mockResolvedValue(null);

        const mockSong = createMockSong({ id: "zero-sha-song", sha: "" });

        // empty string is falsy -> treated as no sha
        const result = await songNeedsAudioData(mockSong as any);

        expect(result).toBe(true);
      });

      it("should return false when blob metadata exists", async () => {
        vi.mocked(getBlobMetadata).mockResolvedValue({ size: 5000 } as any);

        const mockSong = createMockSong({
          id: "valid-audio-song",
          sha: "valid-sha",
        });

        const result = await songNeedsAudioData(mockSong);

        expect(result).toBe(false);
      });
    });
  });

  describe("Background Image Loading", () => {
    it("should schedule image loading after playlist initialization", async () => {
      vi.mocked(loadSetting).mockResolvedValue(null);

      const setTimeoutSpy = vi.spyOn(global, "setTimeout");

      const playlistData = {
        playlist: {
          id: "image-playlist",
          title: "image playlist",
          imageExtension: ".jpg",
          imageMimeType: "image/jpeg",
        },
        songs: [
          {
            id: "image-song",
            title: "image song",
            artist: "test artist",
            album: "test album",
            duration: 180,
            fileSize: 1024,
            sha: "test-sha",
            imageExtension: ".jpg",
            imageMimeType: "image/jpeg",
            originalFilename: "song.mp3",
          },
        ],
      };

      const mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };

      await initializeStandalonePlaylist(playlistData, mockCallbacks);

      expect(setTimeoutSpy).toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
    });
  });

  describe("Progress Management Edge Cases", () => {
    it("should handle rapid progress updates", () => {
      for (let i = 0; i < 100; i++) {
        setStandaloneLoadingProgress({
          current: i,
          total: 100,
          currentSong: `Song ${i}`,
          phase: "updating",
        });
      }

      const finalProgress = standaloneLoadingProgress();
      expect(finalProgress?.current).toBe(99);
      expect(finalProgress?.total).toBe(100);
    });

    it("should handle null progress updates", () => {
      setStandaloneLoadingProgress({
        current: 50,
        total: 100,
        currentSong: "Test Song",
        phase: "updating",
      });

      expect(standaloneLoadingProgress()).not.toBeNull();

      setStandaloneLoadingProgress(null);

      expect(standaloneLoadingProgress()).toBeNull();
    });

    it("should handle different progress phases", () => {
      const phases = ["initializing", "reloading", "updating"] as const;

      phases.forEach((phase) => {
        setStandaloneLoadingProgress({
          current: 1,
          total: 3,
          currentSong: `${phase} song`,
          phase,
        });

        const progress = standaloneLoadingProgress();
        expect(progress?.phase).toBe(phase);
      });
    });
  });

  describe("Memory and Performance", () => {
    it("should handle large song collections efficiently", async () => {
      const largeSongCount = 1000;
      vi.mocked(loadSetting).mockResolvedValue(null);

      const playlistData = {
        playlist: {
          id: "large-playlist",
          title: "large playlist",
          description: "test description",
        },
        songs: Array.from({ length: largeSongCount }, (_, i) => ({
          id: `song-${i}`,
          title: `song ${i}`,
          artist: "test artist",
          album: "test album",
          duration: 180,
          originalFilename: `song-${i}.mp3`,
          fileSize: 1024,
          sha: `sha-${i}`,
        })),
      };

      const mockCallbacks = {
        setSelectedPlaylist: vi.fn(),
        setPlaylistSongs: vi.fn(),
        setSidebarCollapsed: vi.fn(),
        setError: vi.fn(),
      };

      const startTime = performance.now();

      await initializeStandalonePlaylist(playlistData, mockCallbacks);

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(1000);
      expect(mockCallbacks.setPlaylistSongs).toHaveBeenCalled();
    });
  });
});
