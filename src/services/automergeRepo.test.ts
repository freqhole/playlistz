// tests for the automerge-repo singleton module.
//
// uses real @automerge/automerge-repo + IndexedDBStorageAdapter (via
// fake-indexeddb from test-setup) + mocked IrohNetworkAdapter and p2pService.

import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mocks (hoisted before module imports) ---

const { MockIrohNetworkAdapterClass } = vi.hoisted(() => {
  return { MockIrohNetworkAdapterClass: vi.fn() };
});

vi.mock("freqhole-api-client/automerge", async () => {
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

  MockIrohNetworkAdapterClass.mockImplementation(
    (...args: unknown[]) => new MockIrohNetworkAdapter(...(args as []))
  );

  return { IrohNetworkAdapter: MockIrohNetworkAdapterClass };
});

vi.mock("./p2pService.js", () => ({
  getAdapterOptions: vi.fn(() => ({
    getNode: async () => {
      throw new Error("not available in tests");
    },
    getIdentity: async () => null,
  })),
}));

import {
  getRepo,
  createPlaylistDoc,
  findPlaylistDoc,
  deletePlaylistDoc,
  _resetRepoForTests,
  _testSharePolicy,
} from "./automergeRepo.js";
import { parseAutomergeUrl } from "@automerge/automerge-repo";
import type { PeerId, DocumentId } from "@automerge/automerge-repo";
import { addPeer } from "freqhole-api-client/playlistz";

describe("automergeRepo", () => {
  beforeEach(() => {
    _resetRepoForTests();
  });

  describe("getRepo()", () => {
    it("returns a repo instance", () => {
      const repo = getRepo();
      expect(repo).toBeDefined();
    });

    it("returns the same singleton on repeated calls", () => {
      const r1 = getRepo();
      const r2 = getRepo();
      expect(r1).toBe(r2);
    });

    it("returns a fresh repo after _resetRepoForTests", () => {
      const r1 = getRepo();
      _resetRepoForTests();
      const r2 = getRepo();
      expect(r1).not.toBe(r2);
    });
  });

  describe("createPlaylistDoc()", () => {
    it("returns an AutomergeUrl and a DocHandle", () => {
      const { docId, handle } = createPlaylistDoc();
      expect(docId).toMatch(/^automerge:/);
      expect(handle).toBeDefined();
    });

    it("seeds the doc with PlaylistDoc defaults", () => {
      const { handle } = createPlaylistDoc();
      const doc = handle.doc();
      expect(doc).toBeDefined();
      expect(doc?.version).toBe(1);
      expect(doc?.title).toBe("");
      expect(doc?.songs).toEqual({});
      expect(doc?.order).toEqual([]);
    });

    it("applies initial overrides to the doc", () => {
      const { handle } = createPlaylistDoc({
        title: "my playlist",
        description: "a test",
      });
      const doc = handle.doc();
      expect(doc?.title).toBe("my playlist");
      expect(doc?.description).toBe("a test");
    });

    it("each call produces a unique docId", () => {
      const { docId: id1 } = createPlaylistDoc();
      const { docId: id2 } = createPlaylistDoc();
      expect(id1).not.toBe(id2);
    });
  });

  describe("findPlaylistDoc()", () => {
    it("returns the same handle as was created", async () => {
      const { docId } = createPlaylistDoc({ title: "find test" });
      const found = await findPlaylistDoc(docId);
      const doc = found.doc();
      expect(doc?.title).toBe("find test");
    });

    it("round-trip preserves the full doc content", async () => {
      const { docId, handle: orig } = createPlaylistDoc({
        title: "roundtrip",
        description: "desc",
      });
      orig.change((d) => {
        d.order.push("song-1");
        d.songs["song-1"] = {
          id: "song-1",
          title: "track",
          artist: "artist",
          album: "album",
          duration: 120,
          mimeType: "audio/mp3",
          fileSize: 100,
          sha256: "abc123",
          images: [],
          urls: [],
        };
      });
      const found = await findPlaylistDoc(docId);
      const doc = found.doc();
      expect(doc?.title).toBe("roundtrip");
      expect(doc?.order).toContain("song-1");
    });
  });

  describe("sharePolicy via _testSharePolicy()", () => {
    it("denies peers not recorded in the doc", async () => {
      const { docId } = createPlaylistDoc();
      const { documentId } = parseAutomergeUrl(docId);
      const stranger = "stranger-node" as PeerId;
      const allowed = await _testSharePolicy(
        stranger,
        documentId as unknown as DocumentId
      );
      expect(allowed).toBe(false);
    });

    it("denies unknown documentId (not in cache)", async () => {
      const unknownId = "2BmFCMEUanPd5grDGtGfwd" as unknown as DocumentId;
      const peerId = "some-peer" as PeerId;
      expect(await _testSharePolicy(peerId, unknownId)).toBe(false);
    });

    it("allows a peer recorded in the doc's peers map", async () => {
      const { docId, handle } = createPlaylistDoc();
      const { documentId } = parseAutomergeUrl(docId);

      // add a peer via the shared addPeer mutator
      handle.change((doc) => addPeer(doc, "known-peer-id"));

      const peerId = "known-peer-id" as PeerId;
      const allowed = await _testSharePolicy(
        peerId,
        documentId as unknown as DocumentId
      );
      expect(allowed).toBe(true);
    });

    it("allows a peer recorded in the doc's acl", async () => {
      const { docId, handle } = createPlaylistDoc();
      const { documentId } = parseAutomergeUrl(docId);

      handle.change((doc) => {
        if (!doc.acl) doc.acl = {};
        doc.acl["acl-peer"] = { role: "viewer" };
      });

      const peerId = "acl-peer" as PeerId;
      const allowed = await _testSharePolicy(
        peerId,
        documentId as unknown as DocumentId
      );
      expect(allowed).toBe(true);
    });

    it("denies a stranger even when other peers are allowed", async () => {
      const { docId, handle } = createPlaylistDoc();
      const { documentId } = parseAutomergeUrl(docId);

      handle.change((doc) => addPeer(doc, "known-peer-id"));

      const stranger = "not-a-peer" as PeerId;
      const allowed = await _testSharePolicy(
        stranger,
        documentId as unknown as DocumentId
      );
      expect(allowed).toBe(false);
    });
  });

  describe("deletePlaylistDoc()", () => {
    it("fires the delete event on the handle", async () => {
      const { docId, handle } = createPlaylistDoc({ title: "to delete" });

      let deleteReceived = false;
      handle.on("delete", () => {
        deleteReceived = true;
      });

      await deletePlaylistDoc(docId);
      expect(deleteReceived).toBe(true);
    });

    it("tombstones the doc before deleting it", async () => {
      const { docId, handle } = createPlaylistDoc({ title: "tombstone test" });

      let tombstoneDoc: { deleted?: boolean } | undefined;
      handle.on("change", ({ doc }) => {
        tombstoneDoc = doc as { deleted?: boolean };
      });

      await deletePlaylistDoc(docId);

      // tombstoneDoc should have been set by the change event before delete
      expect(tombstoneDoc?.deleted).toBe(true);
    });

    it("removes the doc from the share policy cache", async () => {
      const { docId, handle } = createPlaylistDoc();
      const { documentId } = parseAutomergeUrl(docId);

      // put a peer in the cache
      handle.change((doc) => addPeer(doc, "some-peer"));
      expect(
        await _testSharePolicy(
          "some-peer" as PeerId,
          documentId as unknown as DocumentId
        )
      ).toBe(true);

      await deletePlaylistDoc(docId);

      // cache entry removed - should now deny
      expect(
        await _testSharePolicy(
          "some-peer" as PeerId,
          documentId as unknown as DocumentId
        )
      ).toBe(false);
    });
  });
});
