import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import { useSongState } from "./useSongState.js";
import type { Song } from "../types/playlist.js";

vi.mock("../services/audioService.js", () => ({
  playSong: vi.fn(),
  playSongFromPlaylist: vi.fn(),
  togglePlayback: vi.fn(),
  audioState: {
    currentSong: vi.fn(() => null),
    isPlaying: vi.fn(() => false),
  },
}));

vi.mock("../services/indexedDBService.js", () => ({
  updateSong: vi.fn().mockResolvedValue(undefined),
}));

const mockSong: Song = {
  id: "song-1",
  playlistId: "pl-1",
  title: "test song",
  artist: "test artist",
  album: "test album",
  duration: 180,
  originalFilename: "test.mp3",
  fileSize: 5000000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  order: 0,
};

const mockSong2: Song = { ...mockSong, id: "song-2", title: "song two" };

describe("useSongState edit mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with no edit mode active", () => {
    createRoot((dispose) => {
      const hook = useSongState();
      expect(hook.editingSong()).toBeNull();
      expect(hook.editingPlaylist()).toBe(false);
      expect(hook.isEditMode()).toBe(false);
      dispose();
    });
  });

  describe("playlist edit mode", () => {
    it("activates playlist edit mode", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        expect(hook.editingPlaylist()).toBe(true);
        expect(hook.editingSong()).toBeNull();
        expect(hook.isEditMode()).toBe(true);
        dispose();
      });
    });

    it("clears song edit when entering playlist edit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        hook.handleEditPlaylist();
        expect(hook.editingSong()).toBeNull();
        expect(hook.editingPlaylist()).toBe(true);
        dispose();
      });
    });

    it("exits playlist edit mode via handleCloseEdit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        hook.handleCloseEdit();
        expect(hook.editingPlaylist()).toBe(false);
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });

    it("exits playlist edit mode via setEditingPlaylist(false)", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        hook.setEditingPlaylist(false);
        expect(hook.editingPlaylist()).toBe(false);
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });
  });

  describe("song edit mode", () => {
    it("activates song edit mode with the correct song", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        expect(hook.editingSong()).toEqual(mockSong);
        expect(hook.editingPlaylist()).toBe(false);
        expect(hook.isEditMode()).toBe(true);
        dispose();
      });
    });

    it("clears playlist edit when entering song edit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        hook.handleEditSong(mockSong);
        expect(hook.editingPlaylist()).toBe(false);
        expect(hook.editingSong()).toEqual(mockSong);
        dispose();
      });
    });

    it("switches between songs without going through idle state", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        hook.handleEditSong(mockSong2);
        expect(hook.editingSong()).toEqual(mockSong2);
        expect(hook.isEditMode()).toBe(true);
        dispose();
      });
    });

    it("exits song edit mode via handleCloseEdit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        hook.handleCloseEdit();
        expect(hook.editingSong()).toBeNull();
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });

    it("exits song edit mode via setEditingSong(null)", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        hook.setEditingSong(null);
        expect(hook.editingSong()).toBeNull();
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });
  });

  describe("handleSongSaved", () => {
    it("updates song in IDB and clears editingSong", async () => {
      const { updateSong } = await import("../services/indexedDBService.js");
      let savedHook: ReturnType<typeof useSongState> | undefined;
      createRoot((dispose) => {
        savedHook = useSongState();
        savedHook.handleEditSong(mockSong);
        dispose();
      });
      // test the async call outside the root since createRoot disposes sync
      const hook = (() => {
        let h: ReturnType<typeof useSongState>;
        createRoot(() => { h = useSongState(); h.handleEditSong(mockSong); });
        return h!;
      })();
      const updatedSong = { ...mockSong, title: "updated title" };
      await hook.handleSongSaved(updatedSong);
      expect(updateSong).toHaveBeenCalledWith(updatedSong.id, updatedSong);
      expect(hook.editingSong()).toBeNull();
      expect(hook.isEditMode()).toBe(false);
    });

    it("sets error when IDB update fails", async () => {
      const { updateSong } = await import("../services/indexedDBService.js");
      vi.mocked(updateSong).mockRejectedValueOnce(new Error("db error"));
      let hook: ReturnType<typeof useSongState>;
      createRoot(() => { hook = useSongState(); hook!.handleEditSong(mockSong); });
      await hook!.handleSongSaved(mockSong);
      expect(hook!.error()).toBeTruthy();
    });
  });

  describe("isEditMode derived signal", () => {
    it("is false when neither song nor playlist is being edited", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });

    it("is true when editing a song", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        expect(hook.isEditMode()).toBe(true);
        dispose();
      });
    });

    it("is true when editing the playlist", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        expect(hook.isEditMode()).toBe(true);
        dispose();
      });
    });

    it("returns to false after handleCloseEdit from song edit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditSong(mockSong);
        hook.handleCloseEdit();
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });

    it("returns to false after handleCloseEdit from playlist edit", () => {
      createRoot((dispose) => {
        const hook = useSongState();
        hook.handleEditPlaylist();
        hook.handleCloseEdit();
        expect(hook.isEditMode()).toBe(false);
        dispose();
      });
    });
  });
});

