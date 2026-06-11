import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mock idb to avoid issues with opening real IndexedDB in test env
vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

import {
  setupDB,
  resetDBCache,
  loadAllPlaybackPositions,
  savePlaybackPosition,
  deletePlaybackPosition,
  saveLastPlayed,
  loadLastPlayed,
  saveSetting,
  loadSetting,
  mutateAndNotify,
  updatePlaylist,
  updateSong,
  getSongsWithAudioData,
  PLAYLISTS_STORE,
  SONGS_STORE,
  DB_NAME,
} from "./indexedDBService.js";

// mock BroadcastChannel
global.BroadcastChannel = vi.fn(() => ({
  postMessage: vi.fn(),
  onmessage: null,
  close: vi.fn(),
})) as any;

const mockDB = {
  getAll: vi.fn(),
  transaction: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

const mockStore = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
};

const mockTransaction = {
  objectStore: vi.fn(() => mockStore),
  done: Promise.resolve(),
};

describe("indexedDBService", () => {
  let mockOpenDB: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetDBCache();

    const { openDB } = await import("idb");
    mockOpenDB = vi.mocked(openDB);
    mockDB.transaction.mockReturnValue(mockTransaction);
    mockTransaction.objectStore.mockReturnValue(mockStore);
    mockTransaction.done = Promise.resolve();
    mockOpenDB.mockResolvedValue(mockDB);
    mockDB.getAll.mockResolvedValue([]);
    mockDB.get.mockResolvedValue(undefined);
    mockDB.put.mockResolvedValue(undefined);
    mockDB.delete.mockResolvedValue(undefined);
    mockStore.put.mockResolvedValue(undefined);
    mockStore.get.mockResolvedValue(undefined);
    mockStore.delete.mockResolvedValue(undefined);
    mockStore.getAll.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constants", () => {
    it("exports DB_NAME", () => {
      expect(typeof DB_NAME).toBe("string");
      expect(DB_NAME.length).toBeGreaterThan(0);
    });

    it("exports PLAYLISTS_STORE and SONGS_STORE as compat constants", () => {
      expect(PLAYLISTS_STORE).toBe("playlists");
      expect(SONGS_STORE).toBe("songs");
    });
  });

  describe("setupDB", () => {
    it("calls openDB to open the database", async () => {
      await setupDB();
      expect(mockOpenDB).toHaveBeenCalledWith(DB_NAME, 1, expect.any(Object));
    });

    it("caches the db connection on repeated calls", async () => {
      await setupDB();
      await setupDB();
      // second call should reuse the cached connection, not open again
      expect(mockOpenDB.mock.calls.length).toBe(1);
    });
  });

  describe("resetDBCache", () => {
    it("forces a fresh db open after reset", async () => {
      await setupDB();
      resetDBCache();
      await setupDB();
      expect(mockOpenDB.mock.calls.length).toBe(2);
    });
  });

  describe("loadAllPlaybackPositions", () => {
    it("returns an empty map when no positions are stored", async () => {
      mockDB.getAll.mockResolvedValue([]);
      const result = await loadAllPlaybackPositions();
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("returns a map keyed by songId", async () => {
      mockDB.getAll.mockResolvedValue([
        { songId: "s1", position: 42, updatedAt: Date.now() },
        { songId: "s2", position: 77, updatedAt: Date.now() },
      ]);
      const result = await loadAllPlaybackPositions();
      expect(result.get("s1")).toBe(42);
      expect(result.get("s2")).toBe(77);
    });
  });

  describe("savePlaybackPosition", () => {
    it("puts a record into the playbackPositions store", async () => {
      await savePlaybackPosition("song-abc", 99.5);
      expect(mockDB.put).toHaveBeenCalledWith(
        "playbackPositions",
        expect.objectContaining({ songId: "song-abc", position: 99.5 })
      );
    });
  });

  describe("deletePlaybackPosition", () => {
    it("deletes a record from the playbackPositions store", async () => {
      await deletePlaybackPosition("song-abc");
      expect(mockDB.delete).toHaveBeenCalledWith("playbackPositions", "song-abc");
    });
  });

  describe("saveLastPlayed / loadLastPlayed", () => {
    it("saves and retrieves the last-played song id", async () => {
      mockDB.get.mockResolvedValue({ playlistId: "pl-1", songId: "song-xyz" });
      await saveLastPlayed("pl-1", "song-xyz");
      const result = await loadLastPlayed("pl-1");
      expect(result).toBe("song-xyz");
    });

    it("returns null when no last-played exists", async () => {
      mockDB.get.mockResolvedValue(undefined);
      const result = await loadLastPlayed("pl-1");
      expect(result).toBeNull();
    });
  });

  describe("saveSetting / loadSetting", () => {
    it("saves and retrieves a setting value", async () => {
      mockDB.get.mockResolvedValue({ key: "volume", value: 0.8 });
      await saveSetting("volume", 0.8);
      const result = await loadSetting("volume");
      expect(result).toBe(0.8);
    });

    it("returns null for missing setting", async () => {
      mockDB.get.mockResolvedValue(undefined);
      const result = await loadSetting("volume");
      expect(result).toBeNull();
    });
  });

  describe("compat stubs (no-ops)", () => {
    it("mutateAndNotify is a no-op that resolves without error", async () => {
      await expect(
        mutateAndNotify({ dbName: DB_NAME, storeName: "playlists", key: "x", updateFn: () => ({} as any) })
      ).resolves.not.toThrow();
    });

    it("updatePlaylist is a no-op that resolves without error", async () => {
      await expect(updatePlaylist("id", {})).resolves.not.toThrow();
    });

    it("updateSong is a no-op that resolves without error", async () => {
      await expect(updateSong("id", {})).resolves.not.toThrow();
    });

    it("getSongsWithAudioData returns empty array", async () => {
      const result = await getSongsWithAudioData(["s1", "s2"]);
      expect(result).toEqual([]);
    });
  });
});
