// tests for p2p blob transfer (phase 6).
//
// mocks the midden node (import_blob / download_verified_streaming),
// the iroh adapter, doc lookups, and the blob store. the serving and
// fetching sides are exercised against scripted protocol streams.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PLAYLISTZ_ALPN,
  encodeMessage,
  decodeMessage,
  type Message,
  type BiStreamLike,
} from "../types/playlistz";
import type { Playlist, Song } from "../types/playlist.js";

// --- mocks (hoisted before module imports) ---

const { docs, songLists, adapter, p2p, blobStore } = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  // docId -> songs returned by the mocked playlistDocService
  const songLists = new Map<string, unknown[]>();
  const adapter = {
    isConnected: vi.fn(() => true),
  };
  const p2p = {
    getNode: vi.fn((): unknown => null),
    getIdentity: vi.fn(() => ({ node_id: "me-node" })),
  };
  // sha256 -> stored byte length. storeBlob derives the id from the
  // blob size so verified downloads land on predictable ids
  const blobStore = new Map<string, number>();
  return { docs, songLists, adapter, p2p, blobStore };
});

vi.mock("./automergeRepo.js", () => ({
  getIrohAdapter: () => adapter,
  findPlaylistDoc: vi.fn(async (docId: string) => {
    const doc = docs.get(docId);
    if (!doc) throw new Error(`doc not found: ${docId}`);
    return { doc: () => doc };
  }),
}));

vi.mock("./p2pService.js", () => ({
  getNode: p2p.getNode,
  getIdentity: p2p.getIdentity,
}));

vi.mock("./playlistDocService.js", () => ({
  getSongsForPlaylist: vi.fn(
    async (docId: string) => songLists.get(docId) ?? []
  ),
}));

vi.mock("@freqhole/api-client/storage", () => ({
  storeBlob: vi.fn(async (blob: Blob) => {
    const id = `mock-${blob.size}`;
    blobStore.set(id, blob.size);
    return id;
  }),
  getBlob: vi.fn(async (id: string) => {
    const size = blobStore.get(id);
    if (size === undefined) return null;
    const bytes = new Uint8Array(size);
    return {
      size,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as Blob;
  }),
  getBlobMetadata: vi.fn(async (id: string) => {
    const size = blobStore.get(id);
    if (size === undefined) return null;
    return { blob_id: id, file_size: size };
  }),
}));

import {
  serveBlobRequest,
  fetchBlobForDoc,
  fetchSongBlob,
  prefetchUpcoming,
  savePlaylistOffline,
  type OfflineProgress,
  _resetBlobTransferForTests,
} from "./blobTransferService.js";

const DOC_ID = "automerge:doc1";

// stream used to test the serving side: collects replies
class CollectingStream implements BiStreamLike {
  sent: Message[] = [];
  async write_message(data: Uint8Array): Promise<void> {
    this.sent.push(decodeMessage(data));
  }
  async read_message(): Promise<Uint8Array | null> {
    return null;
  }
  close(): void {}
  peer_node_id(): string {
    return "peer-a";
  }
  alpn(): string {
    return PLAYLISTZ_ALPN;
  }
}

// stream used to test the fetching side: answers blob_request from a
// table of sha256 -> { blake3, size }
function makeServingStream(
  table: Record<string, { blake3: string; size: number }>
): BiStreamLike & { closed: boolean } {
  const replies: Message[] = [];
  return {
    closed: false,
    async write_message(data: Uint8Array) {
      const msg = decodeMessage(data);
      if (msg.type === "blob_request") {
        const entry = table[msg.sha256];
        replies.push(
          entry
            ? { v: 1, type: "blob_ready", sha256: msg.sha256, ...entry }
            : {
                v: 1,
                type: "error",
                code: "blob_not_found",
                message: "nope",
              }
        );
      }
    },
    async read_message() {
      const msg = replies.shift();
      return msg === undefined ? null : encodeMessage(msg);
    },
    close() {
      this.closed = true;
    },
    peer_node_id: () => "peer-a",
    alpn: () => PLAYLISTZ_ALPN,
  };
}

// midden node mock: open_bi serves from the table, verified download
// streams `size` zero bytes in one chunk
function makeNode(table: Record<string, { blake3: string; size: number }>) {
  return {
    node_id: () => "me-node",
    open_bi: vi.fn(async () => makeServingStream(table)),
    import_blob: vi.fn(async () => "blake3-imported"),
    release_blob: vi.fn(),
    download_verified_streaming: vi.fn(
      async (
        _peer: string,
        _hash: string,
        size: number,
        onChunk: (chunk: Uint8Array, offset: number) => void,
        onProgress: (fraction: number) => void
      ) => {
        onChunk(new Uint8Array(size), 0);
        onProgress(1);
        return size;
      }
    ),
  };
}

function makeSong(overrides: Partial<Song>): Song {
  return {
    id: "song-1",
    playlistId: DOC_ID,
    title: "track",
    artist: "",
    album: "",
    duration: 60,
    position: 0,
    mimeType: "audio/mpeg",
    originalFilename: "track.mp3",
    fileSize: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Song;
}

function makePlaylist(songs: Song[]): Playlist {
  songLists.set(DOC_ID, songs);
  return {
    id: DOC_ID,
    title: "tunez",
    songIds: songs.map((s) => s.id),
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Playlist;
}

describe("blobTransferService", () => {
  beforeEach(() => {
    _resetBlobTransferForTests();
    docs.clear();
    songLists.clear();
    blobStore.clear();
    vi.clearAllMocks();
    adapter.isConnected.mockReturnValue(true);
    p2p.getIdentity.mockReturnValue({ node_id: "me-node" });
    p2p.getNode.mockReturnValue(null);
    docs.set(DOC_ID, { peers: { "me-node": {}, "peer-a": {} } });
  });

  describe("serveBlobRequest", () => {
    it("replies no_node when the node is not running", async () => {
      const stream = new CollectingStream();
      await serveBlobRequest(stream, "mock-4");
      expect(stream.sent[0]).toMatchObject({
        type: "error",
        code: "no_node",
      });
    });

    it("replies blob_not_found for unknown blobs", async () => {
      p2p.getNode.mockReturnValue(makeNode({}));
      const stream = new CollectingStream();
      await serveBlobRequest(stream, "mock-404");
      expect(stream.sent[0]).toMatchObject({
        type: "error",
        code: "blob_not_found",
      });
    });

    it("imports the blob and replies blob_ready", async () => {
      const node = makeNode({});
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-4", 4);
      const stream = new CollectingStream();

      await serveBlobRequest(stream, "mock-4");

      expect(node.import_blob).toHaveBeenCalledTimes(1);
      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "blob_ready",
        sha256: "mock-4",
        blake3: "blake3-imported",
        size: 4,
      });
    });

    it("reuses the imported blob on repeat requests", async () => {
      const node = makeNode({});
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-4", 4);

      await serveBlobRequest(new CollectingStream(), "mock-4");
      await serveBlobRequest(new CollectingStream(), "mock-4");

      expect(node.import_blob).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchBlobForDoc", () => {
    it("short-circuits when the blob is already local", async () => {
      const node = makeNode({});
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-4", 4);

      const result = await fetchBlobForDoc(DOC_ID, "mock-4", "audio/mpeg");

      expect(result).toBe("mock-4");
      expect(node.open_bi).not.toHaveBeenCalled();
    });

    it("returns null when the doc has no other peers", async () => {
      docs.set(DOC_ID, { peers: { "me-node": {} } });
      p2p.getNode.mockReturnValue(makeNode({}));

      expect(await fetchBlobForDoc(DOC_ID, "mock-4", "audio/mpeg")).toBeNull();
    });

    it("fetches a missing blob from a doc peer and stores it", async () => {
      const node = makeNode({ "mock-4": { blake3: "b3", size: 4 } });
      p2p.getNode.mockReturnValue(node);
      const fractions: number[] = [];

      const result = await fetchBlobForDoc(
        DOC_ID,
        "mock-4",
        "audio/mpeg",
        (p) => fractions.push(p.fraction)
      );

      expect(result).toBe("mock-4");
      expect(blobStore.has("mock-4")).toBe(true);
      expect(node.open_bi).toHaveBeenCalledWith("peer-a", PLAYLISTZ_ALPN);
      expect(node.download_verified_streaming).toHaveBeenCalledWith(
        "peer-a",
        "b3",
        4,
        expect.any(Function),
        expect.any(Function)
      );
      expect(fractions).toEqual([1]);
    });

    it("returns null when the peer does not have the blob", async () => {
      p2p.getNode.mockReturnValue(makeNode({}));

      expect(await fetchBlobForDoc(DOC_ID, "mock-4", "audio/mpeg")).toBeNull();
    });

    it("dedupes concurrent fetches of the same sha", async () => {
      const node = makeNode({ "mock-4": { blake3: "b3", size: 4 } });
      p2p.getNode.mockReturnValue(node);

      const [a, b] = await Promise.all([
        fetchBlobForDoc(DOC_ID, "mock-4", "audio/mpeg"),
        fetchBlobForDoc(DOC_ID, "mock-4", "audio/mpeg"),
      ]);

      expect(a).toBe("mock-4");
      expect(b).toBe("mock-4");
      expect(node.open_bi).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchSongBlob", () => {
    it("returns null without a sha or playlist", async () => {
      expect(await fetchSongBlob(makeSong({ sha: undefined }))).toBeNull();
      expect(
        await fetchSongBlob(makeSong({ sha: "x", playlistId: undefined }))
      ).toBeNull();
    });

    it("falls back from sha to sha256", async () => {
      const node = makeNode({ "mock-4": { blake3: "b3", size: 4 } });
      p2p.getNode.mockReturnValue(node);

      const result = await fetchSongBlob(
        makeSong({ sha: undefined, sha256: "mock-4" })
      );

      expect(result).toBe("mock-4");
    });
  });

  describe("prefetchUpcoming", () => {
    it("fetches missing blobs for songs after the current one", async () => {
      const node = makeNode({ "mock-7": { blake3: "b3", size: 7 } });
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-4", 4); // song c is already local
      const playlist = makePlaylist([
        makeSong({ id: "a", sha: "mock-2" }),
        makeSong({ id: "b", sha: "mock-7" }),
        makeSong({ id: "c", sha: "mock-4" }),
      ]);

      prefetchUpcoming(playlist, "a");

      await vi.waitFor(() => {
        expect(blobStore.has("mock-7")).toBe(true);
      });
      // current song (a) and local song (c) were not fetched
      expect(node.open_bi).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the current song is not in the playlist", async () => {
      const node = makeNode({});
      p2p.getNode.mockReturnValue(node);
      const playlist = makePlaylist([makeSong({ id: "a", sha: "mock-2" })]);

      prefetchUpcoming(playlist, "nope");
      await new Promise((r) => setTimeout(r, 10));

      expect(node.open_bi).not.toHaveBeenCalled();
    });
  });

  describe("savePlaylistOffline", () => {
    it("fetches every missing blob and reports progress", async () => {
      const node = makeNode({
        "mock-7": { blake3: "b3a", size: 7 },
        "mock-9": { blake3: "b3b", size: 9 },
      });
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-4", 4); // already local
      const playlist = makePlaylist([
        makeSong({ id: "a", sha: "mock-7" }),
        makeSong({ id: "b", sha: "mock-4" }),
        makeSong({ id: "c", sha: "mock-9" }),
      ]);
      const updates: OfflineProgress[] = [];

      const fetched = await savePlaylistOffline(playlist, (p) =>
        updates.push(p)
      );

      expect(fetched).toBe(2);
      expect(blobStore.has("mock-7")).toBe(true);
      expect(blobStore.has("mock-9")).toBe(true);
      const last = updates[updates.length - 1]!;
      expect(last).toMatchObject({ done: 2, total: 2, fraction: 1 });
    });

    it("includes song and playlist cover images", async () => {
      const node = makeNode({
        "mock-7": { blake3: "b3a", size: 7 },
        "mock-11": { blake3: "b3b", size: 11 },
        "mock-13": { blake3: "b3c", size: 13 },
      });
      p2p.getNode.mockReturnValue(node);
      docs.set(DOC_ID, {
        peers: { "peer-a": {} },
        images: [{ blobId: "mock-13" }],
      });
      const playlist = makePlaylist([
        makeSong({
          id: "a",
          sha: "mock-7",
          images: [{ blobId: "mock-11" }] as Song["images"],
        }),
      ]);

      const fetched = await savePlaylistOffline(playlist);

      expect(fetched).toBe(3);
      expect(blobStore.has("mock-11")).toBe(true);
      expect(blobStore.has("mock-13")).toBe(true);
    });

    it("returns 0 when everything is already local", async () => {
      const node = makeNode({});
      p2p.getNode.mockReturnValue(node);
      blobStore.set("mock-7", 7);
      const playlist = makePlaylist([makeSong({ id: "a", sha: "mock-7" })]);

      const fetched = await savePlaylistOffline(playlist);

      expect(fetched).toBe(0);
      expect(node.open_bi).not.toHaveBeenCalled();
    });
  });
});
