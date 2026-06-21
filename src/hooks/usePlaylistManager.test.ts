import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { usePlaylistManager } from "./usePlaylistManager.js";
import type { Playlist } from "../types/playlist.js";
import type { DocIndexEntry } from "../services/indexedDBService.js";

const mockPlaylist: Playlist = {
  id: "test-playlist",
  title: "Test Playlist",
  description: "Test Description",
  songIds: ["song1", "song2"],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockDocEntry: DocIndexEntry = {
  docId: "test-playlist",
  title: "Test Playlist",
  addedAt: Date.now(),
  source: "local",
};

// keep a reference to the docIndex entries array that createDocIndexQuery returns
let docIndexEntries: DocIndexEntry[] = [mockDocEntry];

// Mock the services
vi.mock("../services/playlistDocService.js", () => ({
  createPlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  deleteSong: vi.fn(),
  reorderSongsInDoc: vi.fn(),
  getSongsForPlaylist: vi.fn().mockResolvedValue([]),
  getSongsFromHandle: vi.fn().mockResolvedValue([]),
  getSongById: vi.fn(),
  docToPlaylist: vi.fn(),
  docToPlaylistAsync: vi.fn().mockResolvedValue({
    id: "test-playlist",
    title: "Test Playlist",
    description: "Test Description",
    songIds: ["song1", "song2"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  getSongsWithAudioData: vi.fn().mockResolvedValue([]),
}));

vi.mock("./createDocIndexQuery.js", () => ({
  createDocIndexQuery: vi.fn(() => () => docIndexEntries),
}));

vi.mock("../services/automergeRepo.js", () => ({
  findPlaylistDoc: vi.fn(async () => ({
    doc: () => ({ title: "Test Playlist", songs: {}, songIds: [], peers: {} }),
    on: vi.fn(),
    off: vi.fn(),
  })),
  getRepo: vi.fn(),
}));

vi.mock("../types/playlistz", () => ({
  parsePlaylistDoc: vi.fn((doc: Record<string, unknown>) => doc),
  emptyPlaylistDoc: vi.fn(),
}));

vi.mock("../services/fileProcessingService.js", () => ({
  filterAudioFiles: vi.fn(),
}));

vi.mock("../services/playlistDownloadService.js", () => ({
  parsePlaylistZip: vi.fn(),
  downloadPlaylistAsZip: vi.fn(),
}));

vi.mock("../services/standaloneService.js", () => ({
  initializeStandalonePlaylist: vi.fn(),
  clearStandaloneLoadingProgress: vi.fn(),
  standalonePreferredDocId: vi.fn(() => null),
  setStandalonePreferredDocId: vi.fn(),
  enrichPlaylistWithStandalonePaths: vi.fn((p: unknown) => p),
}));

vi.mock("../services/offlineService.js", () => ({
  initializeOfflineSupport: vi.fn(),
  updatePWAManifest: vi.fn(),
  cacheAudioFile: vi.fn(),
}));

vi.mock("../services/audioService.js", () => ({
  audioState: {
    currentSong: vi.fn(() => null),
    currentPlaylist: vi.fn(() => null),
  },
  stop: vi.fn(),
  refreshPlaylistQueue: vi.fn(),
}));

vi.mock("../services/imageService.js", () => ({
  getImageUrlForContext: vi.fn(),
}));

vi.mock("../services/indexedDBService.js", () => ({
  loadSetting: vi.fn().mockResolvedValue(null),
  saveSetting: vi.fn().mockResolvedValue(undefined),
}));

describe("usePlaylistManager consolidated delete operations", () => {
  let dispose: () => void;
  let hook: ReturnType<typeof usePlaylistManager>;

  beforeEach(async () => {
    vi.clearAllMocks();
    docIndexEntries = [mockDocEntry];

    // re-initialize mock implementations cleared by vi.clearAllMocks()
    const docSvc = await import("../services/playlistDocService.js");
    const repoSvc = await import("../services/automergeRepo.js");
    const idbSvc = await import("../services/indexedDBService.js");
    const fhClient = await import("../types/playlistz");
    const docIndexQry = await import("./createDocIndexQuery.js");

    vi.mocked(docIndexQry.createDocIndexQuery).mockReturnValue(
      () => docIndexEntries as never
    );

    vi.mocked(repoSvc.findPlaylistDoc).mockResolvedValue({
      doc: () => ({
        title: "Test Playlist",
        songs: {},
        songIds: [],
        peers: {},
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as never);

    vi.mocked(docSvc.docToPlaylistAsync).mockResolvedValue({
      id: "test-playlist",
      title: "Test Playlist",
      description: "Test Description",
      songIds: ["song1", "song2"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);

    vi.mocked(docSvc.getSongsFromHandle).mockResolvedValue([] as never);
    vi.mocked(idbSvc.loadSetting).mockResolvedValue(null as never);
    vi.mocked(fhClient.parsePlaylistDoc).mockImplementation(
      (doc: unknown) => doc as never
    );

    createRoot((disposeFn) => {
      dispose = disposeFn;
      hook = usePlaylistManager();
    });

    // wait for deferred effects to run (syncPlaylistsFromDocIndex, on-select, etc.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();

    // ensure the selected playlist is populated for tests that rely on it
    hook.setSelectedPlaylist(mockPlaylist);
  });

  afterEach(() => {
    if (dispose) {
      dispose();
    }
  });

  describe("playlist deletion", () => {
    it("should delete playlist and clear selectedPlaylist", async () => {
      const { deletePlaylist } = await import(
        "../services/playlistDocService.js"
      );

      // Mock successful deletion
      vi.mocked(deletePlaylist).mockResolvedValue();

      // Select playlist
      hook.setSelectedPlaylist(mockPlaylist);
      expect(hook.selectedPlaylist()).toBeTruthy();
      expect(hook.selectedPlaylist()?.id).toBe("test-playlist");

      // Delete playlist
      await hook.handleDeletePlaylist();

      // Playlist should be cleared and service called
      expect(hook.selectedPlaylist()).toBeNull();
      expect(deletePlaylist).toHaveBeenCalledWith("test-playlist");
    });

    it("should handle deletion errors gracefully", async () => {
      const { deletePlaylist } = await import(
        "../services/playlistDocService.js"
      );

      // Mock service error
      vi.mocked(deletePlaylist).mockRejectedValue(new Error("Delete failed"));

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleDeletePlaylist();

      expect(hook.error()).toBe("failed to delete playlist!");
      expect(hook.selectedPlaylist()).toBeTruthy(); // Should remain selected on error
    });

    it("should stop playback if deleted playlist contains currently playing song", async () => {
      const { deletePlaylist } = await import(
        "../services/playlistDocService.js"
      );
      const { audioState, stop } = await import("../services/audioService.js");

      vi.mocked(deletePlaylist).mockResolvedValue();

      // Mock that a song from this playlist is currently playing
      vi.mocked(audioState.currentSong).mockReturnValue({
        id: "song1",
        title: "Song 1",
        artist: "Artist 1",
        album: "Album 1",
        duration: 180,
        position: 0,
        playlistId: "test-playlist", // Same as the playlist being deleted
        fileSize: 1024,
        mimeType: "audio/mp3",
        originalFilename: "song1.mp3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleDeletePlaylist();

      expect(stop).toHaveBeenCalled();
      expect(deletePlaylist).toHaveBeenCalledWith("test-playlist");
      expect(hook.selectedPlaylist()).toBeNull();
    });

    it("should not stop playback if deleted playlist does not contain currently playing song", async () => {
      const { deletePlaylist } = await import(
        "../services/playlistDocService.js"
      );
      const { audioState, stop } = await import("../services/audioService.js");

      vi.mocked(deletePlaylist).mockResolvedValue();

      // Mock that a song from a different playlist is currently playing
      vi.mocked(audioState.currentSong).mockReturnValue({
        id: "song1",
        title: "Song 1",
        artist: "Artist 1",
        album: "Album 1",
        duration: 180,
        position: 0,
        playlistId: "different-playlist", // Different from the playlist being deleted
        fileSize: 1024,
        mimeType: "audio/mp3",
        originalFilename: "song1.mp3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleDeletePlaylist();

      expect(stop).not.toHaveBeenCalled();
      expect(deletePlaylist).toHaveBeenCalledWith("test-playlist");
      expect(hook.selectedPlaylist()).toBeNull();
    });
  });

  describe("song removal", () => {
    it("should remove song from playlist", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");

      vi.mocked(deleteSong).mockResolvedValue();

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleRemoveSong("song1");

      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");
      expect(hook.error()).toBeNull();
    });

    it("should handle song removal errors", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");

      vi.mocked(deleteSong).mockRejectedValue(new Error("Remove failed"));

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleRemoveSong("song1");

      expect(hook.error()).toBe("failed to remove song from playlist!");
    });
  });

  describe("song deletion side effects", () => {
    it("should close edit modal when onClose callback is provided", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");

      vi.mocked(deleteSong).mockResolvedValue();

      hook.setSelectedPlaylist(mockPlaylist);

      const mockOnClose = vi.fn();

      await hook.handleRemoveSong("song1", mockOnClose);

      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should work without onClose callback for regular delete operations", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");

      vi.mocked(deleteSong).mockResolvedValue();

      hook.setSelectedPlaylist(mockPlaylist);

      // Should work without callback (SongRow delete button case)
      await hook.handleRemoveSong("song1");

      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");
      expect(hook.error()).toBeNull();
    });

    it("should stop playback if deleted song is currently playing", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");
      const { audioState, stop } = await import("../services/audioService.js");

      vi.mocked(deleteSong).mockResolvedValue();

      // Mock that song1 is currently playing
      vi.mocked(audioState.currentSong).mockReturnValue({
        id: "song1",
        title: "Song 1",
        artist: "Artist 1",
        album: "Album 1",
        duration: 180,
        position: 0,
        playlistId: "test-playlist",
        fileSize: 1024,
        mimeType: "audio/mp3",
        originalFilename: "song1.mp3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleRemoveSong("song1");

      expect(stop).toHaveBeenCalled();
      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");
    });

    it("should not stop playback if deleted song is not currently playing", async () => {
      const { deleteSong } = await import("../services/playlistDocService.js");
      const { audioState, stop } = await import("../services/audioService.js");

      vi.mocked(deleteSong).mockResolvedValue();

      // Mock that song2 is currently playing (different from deleted song)
      vi.mocked(audioState.currentSong).mockReturnValue({
        id: "song2",
        title: "Song 2",
        artist: "Artist 2",
        album: "Album 2",
        duration: 200,
        position: 1,
        playlistId: "test-playlist",
        fileSize: 2048,
        mimeType: "audio/mp3",
        originalFilename: "song2.mp3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      hook.setSelectedPlaylist(mockPlaylist);

      await hook.handleRemoveSong("song1");

      expect(stop).not.toHaveBeenCalled();
      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");
    });
  });

  describe("consolidated operations working correctly", () => {
    it("should demonstrate that delete operations now work with unified state", async () => {
      const { deletePlaylist, deleteSong } = await import(
        "../services/playlistDocService.js"
      );

      vi.mocked(deletePlaylist).mockResolvedValue();
      vi.mocked(deleteSong).mockResolvedValue();

      // All operations now use the same hook, so state is unified
      hook.setSelectedPlaylist(mockPlaylist);

      // Song removal should work
      await hook.handleRemoveSong("song1");
      expect(deleteSong).toHaveBeenCalledWith("test-playlist", "song1");

      // Playlist deletion should work
      await hook.handleDeletePlaylist();
      expect(deletePlaylist).toHaveBeenCalledWith("test-playlist");
      expect(hook.selectedPlaylist()).toBeNull();
    });

    it("should have all necessary operations consolidated", () => {
      // Verify the hook exposes all needed operations
      expect(typeof hook.handleDeletePlaylist).toBe("function");
      expect(typeof hook.handleRemoveSong).toBe("function");
      expect(typeof hook.handleReorderSongs).toBe("function");
      expect(typeof hook.handlePlaylistUpdate).toBe("function");
      expect(typeof hook.handleDownloadPlaylist).toBe("function");
      expect(typeof hook.handleCachePlaylist).toBe("function");

      // And all the UI state
      expect(typeof hook.showDeleteConfirm).toBe("function");
      expect(typeof hook.setShowDeleteConfirm).toBe("function");
    });
  });
});
