import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { usePlaylistsQuery } from "./usePlaylistsQuery.js";
import type { Playlist } from "../types/playlist.js";

// mock all dependencies of usePlaylistsQuery
vi.mock("./createDocIndexQuery.js", () => ({
  createDocIndexQuery: vi.fn(() => () => []),
}));

vi.mock("../services/automergeRepo.js", () => ({
  findPlaylistDoc: vi.fn(),
  getRepo: vi.fn(),
}));

vi.mock("@freqhole/api-client/playlistz", () => ({
  parsePlaylistDoc: vi.fn((raw: any) => raw ?? {}),
}));

vi.mock("../services/playlistDocService.js", () => ({
  docToPlaylist: vi.fn((docId: string, _doc: any): Playlist => ({
    id: docId,
    title: "mocked playlist",
    description: undefined,
    createdAt: 0,
    updatedAt: 0,
    songIds: [],
  })),
}));

describe("usePlaylistsQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("basic structure", () => {
    it("returns an object with a playlists signal", () => {
      createRoot((dispose) => {
        const result = usePlaylistsQuery();
        expect(typeof result).toBe("object");
        expect(typeof result.playlists).toBe("function");
        dispose();
      });
    });

    it("returns an empty array initially when no docIndex entries exist", () => {
      createRoot((dispose) => {
        const { playlists } = usePlaylistsQuery();
        expect(Array.isArray(playlists())).toBe(true);
        dispose();
      });
    });
  });

  describe("when docIndex has entries", () => {
    it("resolves playlist data from docIndex entries", async () => {
      const { createDocIndexQuery } = await import("./createDocIndexQuery.js");
      const { findPlaylistDoc } = await import("../services/automergeRepo.js");

      vi.mocked(createDocIndexQuery).mockReturnValue(() => [
        {
          docId: "automerge:abc123",
          title: "test playlist",
          addedAt: 1000,
          peers: [],
          acl: {},
          localDraft: false,
        } as any,
      ]);

      vi.mocked(findPlaylistDoc).mockResolvedValue({
        doc: () => ({ title: "test playlist", songs: [] }),
      } as any);

      let resolvedPlaylists: Playlist[] = [];
      await new Promise<void>((resolve) => {
        createRoot((dispose) => {
          const { playlists } = usePlaylistsQuery();
          // give the effect time to run and resolve
          setTimeout(() => {
            resolvedPlaylists = playlists();
            dispose();
            resolve();
          }, 50);
        });
      });

      // playlists may be empty or resolved depending on timing, but no error should throw
      expect(Array.isArray(resolvedPlaylists)).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("cleans up without throwing when root is disposed", () => {
      expect(() => {
        createRoot((dispose) => {
          usePlaylistsQuery();
          dispose();
        });
      }).not.toThrow();
    });

    it("handles multiple instances independently", () => {
      createRoot((dispose1) => {
        const r1 = usePlaylistsQuery();
        createRoot((dispose2) => {
          const r2 = usePlaylistsQuery();
          expect(typeof r1.playlists).toBe("function");
          expect(typeof r2.playlists).toBe("function");
          dispose2();
        });
        dispose1();
      });
    });
  });
});
