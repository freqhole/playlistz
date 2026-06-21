// tests for the doc-backed playlist/song crud service.
//
// uses the real automerge repo (fake-indexeddb storage) with mocked
// IrohNetworkAdapter, p2pService, and blob store. covers the interfaces
// the ui depends on, including regressions found in live debugging:
//   - automerge RangeError from re-inserting doc-derived objects
//   - solid proxy objects crossing the persistence boundary
//   - getSongById registry miss after a page reload
//   - image hydration from the blob store (imageFilePath/imageType)

import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// --- mocks (hoisted before module imports) ---

vi.mock("@freqhole/api-client/automerge", async () => {
  const { NetworkAdapter } = await vi.importActual<
    typeof import("@automerge/automerge-repo")
  >("@automerge/automerge-repo");

  class MockIrohNetworkAdapter extends NetworkAdapter {
    isReady() {
      return true;
    }
    async whenReady() {
      return;
    }
    connect() {}
    disconnect() {}
    send() {}
  }

  return { IrohNetworkAdapter: MockIrohNetworkAdapter };
});

vi.mock("./p2pService.js", () => ({
  getAdapterOptions: vi.fn(() => ({
    getNode: async () => {
      throw new Error("not available in tests");
    },
    getIdentity: async () => null,
  })),
}));

// in-memory blob store mock - storeBlob returns deterministic ids,
// getBlobObjectURL/getBlobMetadata resolve for stored ids only
const { blobStore } = vi.hoisted(() => ({
  blobStore: new Map<string, { mimeType: string; size: number }>(),
}));

vi.mock("@freqhole/api-client/storage", () => ({
  storeBlob: vi.fn(async (blob: Blob, mimeType: string) => {
    const id = `sha-${blobStore.size + 1}-${blob.size}`;
    blobStore.set(id, { mimeType, size: blob.size });
    return id;
  }),
  getBlob: vi.fn(async (id: string) =>
    blobStore.has(id) ? new Blob(["x"]) : null
  ),
  getBlobObjectURL: vi.fn(async (id: string) =>
    blobStore.has(id) ? `blob:mock-${id}` : null
  ),
  getBlobMetadata: vi.fn(async (id: string) => {
    const rec = blobStore.get(id);
    if (!rec) return null;
    return {
      blob_id: id,
      storage_type: "opfs",
      storage_path: id,
      mime_type: rec.mimeType,
      file_size: rec.size,
      created_at: 0,
    };
  }),
  deleteBlob: vi.fn(async (id: string) => {
    blobStore.delete(id);
  }),
}));

import {
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addSongToPlaylist,
  updateSongInDoc,
  deleteSong,
  reorderSongsInDoc,
  getSongsForPlaylist,
  getSongById,
  setPlaylistCoverImage,
  clearPlaylistCoverImage,
  setSongCoverImage,
  docToPlaylist,
  docToPlaylistAsync,
  _clearSongRegistryForTests,
} from "./playlistDocService.js";
import { _resetRepoForTests, findPlaylistDoc } from "./automergeRepo.js";
import { resetDBCache } from "./indexedDBService.js";
import { getAllDocIndexEntries, getDocIndexEntry } from "./docIndexService.js";
import { parsePlaylistDoc } from "@freqhole/api-client/playlistz";
import type { AutomergeUrl } from "@automerge/automerge-repo";

function makeAudioFile(name = "track.mp3", content = "fake audio"): File {
  const file = new File([content], name, { type: "audio/mpeg" });
  // jsdom's File lacks arrayBuffer()
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode(content).buffer,
    });
  }
  return file;
}

describe("playlistDocService", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDBCache();
    _resetRepoForTests();
    _clearSongRegistryForTests();
    blobStore.clear();
  });

  describe("createPlaylist", () => {
    it("returns a playlist view with an automerge docId", async () => {
      const playlist = await createPlaylist({ title: "test" });
      expect(playlist.id).toMatch(/^automerge:/);
      expect(playlist.title).toBe("test");
      expect(playlist.songIds).toEqual([]);
    });

    it("adds a docIndex entry", async () => {
      const playlist = await createPlaylist({ title: "indexed" });
      const entries = await getAllDocIndexEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.docId).toBe(playlist.id);
      expect(entries[0]!.title).toBe("indexed");
    });
  });

  describe("updatePlaylist", () => {
    it("persists title and description to the doc", async () => {
      const playlist = await createPlaylist({ title: "before" });
      await updatePlaylist(playlist.id, {
        title: "after",
        description: "desc",
      });

      const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
      const doc = parsePlaylistDoc(handle.doc());
      expect(doc.title).toBe("after");
      expect(doc.description).toBe("desc");
    });

    it("updates the docIndex title", async () => {
      const playlist = await createPlaylist({ title: "before" });
      await updatePlaylist(playlist.id, { title: "after" });
      const entry = await getDocIndexEntry(playlist.id);
      expect(entry?.title).toBe("after");
    });

    it("persists display filter fields", async () => {
      const playlist = await createPlaylist({ title: "filters" });
      await updatePlaylist(playlist.id, {
        bgFilterEnabled: false,
        bgFilterBlur: 5,
        coverFilterBlur: 2,
      });

      const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
      const doc = parsePlaylistDoc(handle.doc());
      expect(doc.bgFilterEnabled).toBe(false);
      expect(doc.bgFilterBlur).toBe(5);
      expect(doc.coverFilterBlur).toBe(2);
    });

    it("accepts proxy-wrapped fields (solid store objects)", async () => {
      const playlist = await createPlaylist({ title: "proxy" });
      // simulate a solid store proxy crossing the boundary
      const proxied = new Proxy(
        { title: "from proxy", description: "proxied desc" },
        {}
      );
      await expect(updatePlaylist(playlist.id, proxied)).resolves.not.toThrow();

      const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
      const doc = parsePlaylistDoc(handle.doc());
      expect(doc.title).toBe("from proxy");
    });
  });

  describe("deletePlaylist", () => {
    it("removes the docIndex entry", async () => {
      const playlist = await createPlaylist({ title: "doomed" });
      await deletePlaylist(playlist.id);
      const entries = await getAllDocIndexEntries();
      expect(entries).toHaveLength(0);
    });

    it("clears the playlist's songs from the registry", async () => {
      const playlist = await createPlaylist({ title: "doomed" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile());
      await deletePlaylist(playlist.id);
      _clearSongRegistryForTests();
      // docIndex entry is gone, so the fallback scan finds nothing
      expect(await getSongById(song.id)).toBeNull();
    });
  });

  describe("addSongToPlaylist", () => {
    it("adds a song entry to the doc and returns a Song view", async () => {
      const playlist = await createPlaylist({ title: "with songs" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        title: "my song",
        artist: "artist",
        album: "album",
        duration: 120,
      });

      expect(song.title).toBe("my song");
      expect(song.artist).toBe("artist");
      expect(song.playlistId).toBe(playlist.id);
      expect(song.sha256).toBeTruthy();

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs).toHaveLength(1);
      expect(songs[0]!.id).toBe(song.id);
    });

    it("stores audio bytes in the blob store keyed by sha", async () => {
      const playlist = await createPlaylist({ title: "blobs" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile());
      expect(blobStore.has(song.sha256!)).toBe(true);
    });

    it("stores cover art and carries an image ref on the song", async () => {
      const playlist = await createPlaylist({ title: "art" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        imageData: new ArrayBuffer(8),
        imageType: "image/png",
      });
      expect(song.images).toHaveLength(1);
      expect(song.images![0]!.isPrimary).toBe(true);
      expect(blobStore.has(song.images![0]!.blobId)).toBe(true);
    });
  });

  describe("updateSongInDoc", () => {
    it("updates metadata fields", async () => {
      const playlist = await createPlaylist({ title: "edit" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        title: "orig",
        album: "orig album",
      });

      await updateSongInDoc(playlist.id, song.id, { album: "new album" });

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.album).toBe("new album");
      expect(songs[0]!.title).toBe("orig");
    });

    it("does not throw RangeError when passed a full Song view object", async () => {
      // regression: SongEditPanel passes the whole (doc-derived) song back.
      // the old implementation spread the automerge proxy and re-inserted it,
      // which made automerge throw "Cannot create a reference to an existing
      // document object"
      const playlist = await createPlaylist({ title: "regression" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        imageData: new ArrayBuffer(8),
        imageType: "image/png",
      });

      const fetched = await getSongById(song.id);
      expect(fetched).not.toBeNull();

      await expect(
        updateSongInDoc(playlist.id, song.id, {
          ...fetched!,
          album: "edited album",
        })
      ).resolves.not.toThrow();

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.album).toBe("edited album");
      // image refs survive a metadata-only edit
      expect(songs[0]!.images).toHaveLength(1);
    });

    it("replaces images when new image data is provided", async () => {
      const playlist = await createPlaylist({ title: "img replace" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        imageData: new ArrayBuffer(8),
        imageType: "image/png",
      });
      const firstBlobId = song.images![0]!.blobId;

      await updateSongInDoc(playlist.id, song.id, {
        imageData: new ArrayBuffer(16),
        imageType: "image/jpeg",
      });

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.images).toHaveLength(1);
      expect(songs[0]!.images![0]!.blobId).not.toBe(firstBlobId);
    });
  });

  describe("deleteSong", () => {
    it("removes the song from the doc and registry", async () => {
      const playlist = await createPlaylist({ title: "removal" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile());

      await deleteSong(playlist.id, song.id);

      expect(await getSongsForPlaylist(playlist.id)).toHaveLength(0);
      expect(await getSongById(song.id)).toBeNull();
    });
  });

  describe("reorderSongsInDoc", () => {
    it("moves a song to a new position", async () => {
      const playlist = await createPlaylist({ title: "order" });
      const a = await addSongToPlaylist(playlist.id, makeAudioFile("a.mp3", "aaa"));
      const b = await addSongToPlaylist(playlist.id, makeAudioFile("b.mp3", "bbb"));
      const c = await addSongToPlaylist(playlist.id, makeAudioFile("c.mp3", "ccc"));

      await reorderSongsInDoc(playlist.id, 0, 2);

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs.map((s) => s.id)).toEqual([b.id, c.id, a.id]);
      expect(songs.map((s) => s.position)).toEqual([0, 1, 2]);
    });
  });

  describe("getSongById", () => {
    it("returns a registered song", async () => {
      const playlist = await createPlaylist({ title: "lookup" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        title: "findable",
      });

      const found = await getSongById(song.id);
      expect(found?.title).toBe("findable");
      expect(found?.playlistId).toBe(playlist.id);
    });

    it("rebuilds the registry from the docIndex on a miss (reload scenario)", async () => {
      // regression: after a page reload the in-memory registry is empty,
      // and song rows rendered "song not found" for every song
      const playlist = await createPlaylist({ title: "reload" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        title: "survives reload",
      });

      _clearSongRegistryForTests();

      const found = await getSongById(song.id);
      expect(found?.title).toBe("survives reload");
    });

    it("returns null for unknown ids", async () => {
      await createPlaylist({ title: "empty" });
      expect(await getSongById("nope")).toBeNull();
    });
  });

  describe("image hydration", () => {
    it("getSongsForPlaylist hydrates imageFilePath and imageType", async () => {
      const playlist = await createPlaylist({ title: "hydrate" });
      await addSongToPlaylist(playlist.id, makeAudioFile(), {
        imageData: new ArrayBuffer(8),
        imageType: "image/png",
      });

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.imageFilePath).toMatch(/^blob:mock-/);
      expect(songs[0]!.imageType).toBe("image/png");
    });

    it("getSongById hydrates the image after a registry rebuild", async () => {
      const playlist = await createPlaylist({ title: "hydrate reload" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile(), {
        imageData: new ArrayBuffer(8),
        imageType: "image/png",
      });

      _clearSongRegistryForTests();

      const found = await getSongById(song.id);
      expect(found?.imageFilePath).toMatch(/^blob:mock-/);
      expect(found?.imageType).toBe("image/png");
    });

    it("songs without images are left unhydrated", async () => {
      const playlist = await createPlaylist({ title: "no image" });
      await addSongToPlaylist(playlist.id, makeAudioFile());

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.imageFilePath).toBeUndefined();
      expect(songs[0]!.imageType).toBeUndefined();
    });

    it("docToPlaylistAsync hydrates the playlist cover from the blob store", async () => {
      const playlist = await createPlaylist({ title: "cover" });
      await setPlaylistCoverImage(
        playlist.id,
        new ArrayBuffer(8),
        "image/webp"
      );

      const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
      const doc = parsePlaylistDoc(handle.doc());
      const view = await docToPlaylistAsync(playlist.id, doc);

      expect(view._primaryImageSha).toBeTruthy();
      expect(view.imageFilePath).toMatch(/^blob:mock-/);
      expect(view.imageType).toBe("image/webp");
    });

    it("clearPlaylistCoverImage removes the cover refs", async () => {
      const playlist = await createPlaylist({ title: "uncover" });
      await setPlaylistCoverImage(playlist.id, new ArrayBuffer(8), "image/png");
      await clearPlaylistCoverImage(playlist.id);

      const handle = await findPlaylistDoc(playlist.id as AutomergeUrl);
      const doc = parsePlaylistDoc(handle.doc());
      expect(doc.images).toHaveLength(0);
      expect(docToPlaylist(playlist.id, doc)._primaryImageSha).toBeUndefined();
    });

    it("setSongCoverImage attaches a primary image to the song", async () => {
      const playlist = await createPlaylist({ title: "song cover" });
      const song = await addSongToPlaylist(playlist.id, makeAudioFile());

      await setSongCoverImage(
        playlist.id,
        song.id,
        new ArrayBuffer(8),
        "image/png"
      );

      const songs = await getSongsForPlaylist(playlist.id);
      expect(songs[0]!.images!.length).toBeGreaterThan(0);
      expect(songs[0]!.imageFilePath).toMatch(/^blob:mock-/);
    });
  });
});
