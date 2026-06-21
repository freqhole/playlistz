// tests for the p2p sharing service (phase 5).
//
// uses fake-indexeddb for the real docIndex/knocks/grants/settings stores,
// with mocked p2pService, automergeRepo, and blobTransferService. protocol
// streams are scripted in-memory BiStreamLike objects.

import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  PLAYLISTZ_ALPN,
  encodeMessage,
  decodeMessage,
  decodeShareToken,
  type Message,
  type BiStreamLike,
} from "../types/playlistz";

// --- mocks (hoisted before module imports) ---

const { docs, adapter, p2p, blobs } = vi.hoisted(() => {
  // docId -> mutable doc object served by the mocked findPlaylistDoc
  const docs = new Map<string, Record<string, unknown>>();
  const adapter = {
    addPeer: vi.fn(async (_nodeId: string) => {}),
    isConnected: vi.fn(() => false),
    registerAlpnHandler: vi.fn(),
  };
  const p2p = {
    startP2P: vi.fn(async () => {}),
    getIdentity: vi.fn(() => ({ node_id: "me-node" })),
    getNode: vi.fn((): unknown => null),
    isLeader: vi.fn(() => true),
    onLeadershipChange: vi.fn((cb: (leader: boolean) => void) => {
      cb(true);
      return () => {};
    }),
    hasExistingIdentity: vi.fn(async () => false),
    waitForNode: vi.fn(async (): Promise<unknown> => null),
  };
  const blobs = {
    serveBlobRequest: vi.fn(async () => {}),
  };
  return { docs, adapter, p2p, blobs };
});

vi.mock("./automergeRepo.js", () => ({
  getIrohAdapter: () => adapter,
  authorizePeerForDoc: vi.fn(),
  findPlaylistDoc: vi.fn(async (docId: string) => {
    const doc = docs.get(docId);
    if (!doc) throw new Error(`doc not found: ${docId}`);
    return {
      doc: () => doc,
      change: (cb: (d: Record<string, unknown>) => void) => cb(doc),
    };
  }),
  flushDoc: vi.fn(async () => {}),
}));

vi.mock("./p2pService.js", () => ({
  startP2P: p2p.startP2P,
  getIdentity: p2p.getIdentity,
  getNode: p2p.getNode,
  isLeader: p2p.isLeader,
  onLeadershipChange: p2p.onLeadershipChange,
  hasExistingIdentity: p2p.hasExistingIdentity,
  waitForNode: p2p.waitForNode,
}));

vi.mock("./blobTransferService.js", () => ({
  serveBlobRequest: blobs.serveBlobRequest,
}));

import {
  getShareSettings,
  saveShareSettings,
  ensureSharingReady,
  reconnectKnownPeers,
  buildShareLink,
  openShareLink,
  handleShareFragment,
  queryPeerPlaylists,
  knockOnPeer,
  knockForDocAccess,
  acceptKnock,
  denyKnock,
  getInboundKnocks,
  handlePlaylistzStream,
  _resetSharingForTests,
} from "./sharingService.js";
import { resetDBCache } from "./indexedDBService.js";
import {
  addDocIndexEntry,
  getDocIndexEntry,
  getAllKnocks,
  getAccessGrant,
  upsertAccessGrant,
} from "./docIndexService.js";
import { flushDoc } from "./automergeRepo.js";

// scripted bidirectional stream: replies are read in order, everything
// written by the code under test is collected in `sent`
class MockStream implements BiStreamLike {
  sent: Message[] = [];
  closed = false;
  private incoming: Message[];

  constructor(
    private peer: string,
    incoming: Message[] = []
  ) {
    this.incoming = [...incoming];
  }

  async write_message(data: Uint8Array): Promise<void> {
    this.sent.push(decodeMessage(data));
  }

  async read_message(): Promise<Uint8Array | null> {
    const msg = this.incoming.shift();
    return msg === undefined ? null : encodeMessage(msg);
  }

  close(): void {
    this.closed = true;
  }

  peer_node_id(): string {
    return this.peer;
  }

  alpn(): string {
    return PLAYLISTZ_ALPN;
  }
}

function makeDoc(
  docId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const doc = {
    title: "tunez",
    songs: {},
    peers: {},
    ...overrides,
  };
  docs.set(docId, doc);
  return doc;
}

const DOC_ID = "automerge:abc123";

describe("sharingService", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetDBCache();
    _resetSharingForTests();
    docs.clear();
    vi.clearAllMocks();
    p2p.getIdentity.mockReturnValue({ node_id: "me-node" });
    p2p.getNode.mockReturnValue(null);
    p2p.hasExistingIdentity.mockResolvedValue(false);
    window.location.hash = "";
  });

  describe("share settings", () => {
    it("defaults to knock mode with empty name", async () => {
      expect(await getShareSettings()).toEqual({ name: "", mode: "knock" });
    });

    it("round-trips saved settings", async () => {
      await saveShareSettings({ name: "edward", mode: "public" });
      expect(await getShareSettings()).toEqual({
        name: "edward",
        mode: "public",
      });
    });
  });

  describe("ensureSharingReady", () => {
    it("starts p2p and registers the protocol handler once", async () => {
      await ensureSharingReady();
      await ensureSharingReady();
      expect(p2p.startP2P).toHaveBeenCalledTimes(2);
      expect(adapter.registerAlpnHandler).toHaveBeenCalledTimes(1);
      expect(adapter.registerAlpnHandler).toHaveBeenCalledWith(
        PLAYLISTZ_ALPN,
        expect.any(Function)
      );
    });
  });

  describe("reconnectKnownPeers", () => {
    it("dials every peer recorded in indexed docs, excluding self", async () => {
      makeDoc(DOC_ID, { peers: { "me-node": {}, "peer-a": {}, "peer-b": {} } });
      await addDocIndexEntry({
        docId: DOC_ID,
        title: "tunez",
        addedAt: 1,
        source: "local",
      });

      await reconnectKnownPeers();

      const dialed = adapter.addPeer.mock.calls.map((c) => c[0]);
      expect(dialed.sort()).toEqual(["peer-a", "peer-b"]);
    });
  });

  describe("share links", () => {
    it("builds a decodable share link with our node id", async () => {
      const { token, url, fragment } = await buildShareLink(DOC_ID, "tunez");
      const decoded = decodeShareToken(token);
      expect(decoded).toMatchObject({
        v: 1,
        n: "me-node",
        d: DOC_ID,
        t: "tunez",
      });
      expect(fragment.startsWith("#share/")).toBe(true);
      expect(url.endsWith(fragment)).toBe(true);
    });

    it("throws without a node identity", async () => {
      p2p.getIdentity.mockReturnValue(null as unknown as { node_id: string });
      await expect(buildShareLink(DOC_ID)).rejects.toThrow(/node id/);
    });

    it("opens a share link: dials peer, records self, indexes doc", async () => {
      await saveShareSettings({ name: "", mode: "public" });
      const doc = makeDoc(DOC_ID, { title: "their tunez" });
      const { token } = await buildShareLink(DOC_ID);
      // simulate receiving someone else's link
      vi.clearAllMocks();
      p2p.getIdentity.mockReturnValue({ node_id: "me-node" });

      const result = await openShareLink(token);

      expect(result).toEqual({ status: "synced", docId: DOC_ID });
      expect(adapter.addPeer).toHaveBeenCalledWith("me-node");
      expect(doc.peers).toHaveProperty("me-node");
      expect(flushDoc).toHaveBeenCalledWith(DOC_ID);
      const entry = await getDocIndexEntry(DOC_ID);
      expect(entry?.source).toBe("shared");
      expect(entry?.title).toBe("their tunez");
    });

    it("returns knock_required when link was created in knock mode", async () => {
      await saveShareSettings({ name: "", mode: "knock" });
      makeDoc(DOC_ID);
      const { token } = await buildShareLink(DOC_ID, "private tunez");
      // reset identity for recipient
      vi.clearAllMocks();
      p2p.getIdentity.mockReturnValue({ node_id: "me-node" });

      const result = await openShareLink(token);

      expect(result).toEqual({
        status: "knock_required",
        ownerNodeId: "me-node",
        docId: DOC_ID,
        title: "private tunez",
      });
      // doc should not have been synced
      expect(adapter.addPeer).not.toHaveBeenCalled();
      expect(await getDocIndexEntry(DOC_ID)).toBeUndefined();
    });

    it("skips knock gate when doc is already local", async () => {
      await saveShareSettings({ name: "", mode: "knock" });
      makeDoc(DOC_ID, { title: "mine" });
      await addDocIndexEntry({
        docId: DOC_ID,
        title: "mine",
        addedAt: 1,
        source: "local",
      });
      const { token } = await buildShareLink(DOC_ID);

      const result = await openShareLink(token);

      expect(result).toEqual({ status: "synced", docId: DOC_ID });
    });

    it("does not duplicate an existing index entry", async () => {
      makeDoc(DOC_ID);
      await addDocIndexEntry({
        docId: DOC_ID,
        title: "already here",
        addedAt: 42,
        source: "local",
      });
      // public mode so no knock gate
      await saveShareSettings({ name: "", mode: "public" });
      const { token } = await buildShareLink(DOC_ID);

      await openShareLink(token);

      const entry = await getDocIndexEntry(DOC_ID);
      expect(entry?.title).toBe("already here");
      expect(entry?.source).toBe("local");
    });

    it("rejects garbage input", async () => {
      await expect(openShareLink("not a link!!!")).rejects.toThrow(
        /invalid share link/
      );
    });

    it("handleShareFragment opens #share/ links and clears the hash", async () => {
      await saveShareSettings({ name: "", mode: "public" });
      makeDoc(DOC_ID);
      const { fragment } = await buildShareLink(DOC_ID);
      window.location.hash = fragment;
      // the test setup mocks window.location as a plain object, so emulate
      // the browser's replaceState -> location sync here
      const replaceState = vi
        .spyOn(history, "replaceState")
        .mockImplementation(() => {
          window.location.hash = "";
        });

      const result = await handleShareFragment();

      expect(result).toEqual({ status: "synced", docId: DOC_ID });
      expect(replaceState).toHaveBeenCalled();
      expect(window.location.hash).toBe("");
      expect(await getDocIndexEntry(DOC_ID)).toBeTruthy();
      replaceState.mockRestore();
    });

    it("handleShareFragment returns knock_required and clears the hash for knock-mode links", async () => {
      await saveShareSettings({ name: "", mode: "knock" });
      makeDoc(DOC_ID);
      const { fragment } = await buildShareLink(DOC_ID, "secret tunez");
      window.location.hash = fragment;
      const replaceState = vi
        .spyOn(history, "replaceState")
        .mockImplementation(() => {
          window.location.hash = "";
        });

      const result = await handleShareFragment();

      expect(result?.status).toBe("knock_required");
      expect(window.location.hash).toBe("");
      expect(await getDocIndexEntry(DOC_ID)).toBeUndefined();
      replaceState.mockRestore();
    });

    it("handleShareFragment is a no-op without a share fragment", async () => {
      expect(await handleShareFragment()).toBeNull();
    });
  });

  describe("protocol responder", () => {
    it("answers hello with hello_ok and our settings", async () => {
      await saveShareSettings({ name: "edward", mode: "public" });
      const stream = new MockStream("peer-a", [
        { v: 1, type: "hello", nodeId: "peer-a" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent).toEqual([
        {
          v: 1,
          type: "hello_ok",
          nodeId: "me-node",
          name: "edward",
          public: true,
        },
      ]);
      expect(stream.closed).toBe(true);
    });

    it("requires a knock for list_playlists in knock mode", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "list_playlists" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toMatchObject({
        type: "error",
        code: "knock_required",
      });
    });

    it("lists playlists in public mode", async () => {
      await saveShareSettings({ name: "", mode: "public" });
      makeDoc(DOC_ID, { title: "tunez", songs: { s1: {}, s2: {} } });
      await addDocIndexEntry({
        docId: DOC_ID,
        title: "tunez",
        addedAt: 1,
        source: "local",
      });
      const stream = new MockStream("peer-a", [
        { v: 1, type: "list_playlists" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "playlists",
        items: [{ docId: DOC_ID, title: "tunez", songCount: 2 }],
      });
    });

    it("scopes the listing to a grant's docIds in knock mode", async () => {
      makeDoc(DOC_ID, { title: "granted" });
      makeDoc("automerge:other", { title: "private" });
      await addDocIndexEntry({
        docId: DOC_ID,
        title: "granted",
        addedAt: 1,
        source: "local",
      });
      await addDocIndexEntry({
        docId: "automerge:other",
        title: "private",
        addedAt: 2,
        source: "local",
      });
      await upsertAccessGrant({
        nodeId: "peer-a",
        name: "",
        grantedAt: 1,
        docIds: [DOC_ID],
      });
      const stream = new MockStream("peer-a", [
        { v: 1, type: "list_playlists" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toMatchObject({
        type: "playlists",
        items: [{ docId: DOC_ID, title: "granted", songCount: 0 }],
      });
    });

    it("records an inbound knock and replies pending", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "knock", nodeId: "peer-a", name: "viz", message: "yo" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "knock_status",
        status: "pending",
      });
      const knocks = await getInboundKnocks();
      expect(knocks).toHaveLength(1);
      expect(knocks[0]).toMatchObject({
        nodeId: "peer-a",
        name: "viz",
        message: "yo",
        status: "pending",
        knockType: "browse",
      });
    });

    it("records an inbound doc_access knock with the requested docId", async () => {
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock",
          nodeId: "peer-a",
          name: "viz",
          message: "let me in",
          knockType: "doc_access",
          docId: DOC_ID,
        },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toMatchObject({
        type: "knock_status",
        status: "pending",
      });
      const knocks = await getInboundKnocks();
      expect(knocks[0]).toMatchObject({
        knockType: "doc_access",
        requestedDocId: DOC_ID,
        status: "pending",
      });
    });

    it("queues doc_access knock as pending even when peer has a grant (no collaborative flag)", async () => {
      makeDoc(DOC_ID);
      await upsertAccessGrant({
        nodeId: "peer-a",
        name: "",
        grantedAt: 1,
        docIds: [DOC_ID],
      });
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock",
          nodeId: "peer-a",
          knockType: "doc_access",
          docId: DOC_ID,
        },
      ]);

      await handlePlaylistzStream(stream);

      // without collaborative flag the owner must approve explicitly
      expect(stream.sent[0]).toMatchObject({
        type: "knock_status",
        status: "pending",
      });
      const knocks = await getInboundKnocks();
      expect(knocks[0]).toMatchObject({
        knockType: "doc_access",
        requestedDocId: DOC_ID,
        status: "pending",
      });
    });

    it("auto-accepts doc_access knock when collaborative is true and peer has a grant", async () => {
      makeDoc(DOC_ID, { collaborative: true });
      await upsertAccessGrant({
        nodeId: "peer-a",
        name: "",
        grantedAt: 1,
        docIds: [DOC_ID],
      });
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock",
          nodeId: "peer-a",
          knockType: "doc_access",
          docId: DOC_ID,
        },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "knock_status",
        status: "accepted",
        grantedDocIds: [DOC_ID],
      });
    });

    it("auto-accepts doc_access knock when collaborative is true and mode is public", async () => {
      await saveShareSettings({ name: "", mode: "public" });
      makeDoc(DOC_ID, { collaborative: true });
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock",
          nodeId: "peer-a",
          knockType: "doc_access",
          docId: DOC_ID,
        },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "knock_status",
        status: "accepted",
        grantedDocIds: [DOC_ID],
      });
    });

    it("browse and doc_access knocks from same node are tracked separately", async () => {
      const browseStream = new MockStream("peer-a", [
        { v: 1, type: "knock", nodeId: "peer-a" },
      ]);
      await handlePlaylistzStream(browseStream);

      const docStream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock",
          nodeId: "peer-a",
          knockType: "doc_access",
          docId: DOC_ID,
        },
      ]);
      await handlePlaylistzStream(docStream);

      const knocks = await getInboundKnocks();
      expect(knocks).toHaveLength(2);
      expect(knocks.find((k) => k.knockType === "browse")).toBeDefined();
      expect(knocks.find((k) => k.knockType === "doc_access")).toBeDefined();
    });

    it("does not duplicate a repeated knock", async () => {
      for (let i = 0; i < 2; i++) {
        const stream = new MockStream("peer-a", [
          { v: 1, type: "knock", nodeId: "peer-a" },
        ]);
        await handlePlaylistzStream(stream);
      }
      expect(await getInboundKnocks()).toHaveLength(1);
    });

    it("answers accepted with granted docIds when a grant exists", async () => {
      await upsertAccessGrant({
        nodeId: "peer-a",
        name: "",
        grantedAt: 1,
        docIds: [DOC_ID],
      });
      const stream = new MockStream("peer-a", [
        { v: 1, type: "knock", nodeId: "peer-a" },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toEqual({
        v: 1,
        type: "knock_status",
        status: "accepted",
        grantedDocIds: [DOC_ID],
      });
    });

    it("answers denied after a knock was rejected", async () => {
      const knockStream = new MockStream("peer-a", [
        { v: 1, type: "knock", nodeId: "peer-a" },
      ]);
      await handlePlaylistzStream(knockStream);
      const knock = (await getInboundKnocks())[0]!;
      await denyKnock(knock.id);

      const retry = new MockStream("peer-a", [
        { v: 1, type: "knock", nodeId: "peer-a" },
      ]);
      await handlePlaylistzStream(retry);

      expect(retry.sent[0]).toEqual({
        v: 1,
        type: "knock_status",
        status: "denied",
      });
    });

    it("dispatches blob_request to the blob transfer service", async () => {
      await saveShareSettings({ name: "", mode: "public" });
      const stream = new MockStream("peer-a", [
        { v: 1, type: "blob_request", sha256: "deadbeef" },
      ]);

      await handlePlaylistzStream(stream);

      expect(blobs.serveBlobRequest).toHaveBeenCalledWith(stream, "deadbeef");
    });

    it("rejects unexpected message types", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "playlists", items: [] },
      ]);

      await handlePlaylistzStream(stream);

      expect(stream.sent[0]).toMatchObject({
        type: "error",
        code: "unexpected_message",
      });
    });
  });

  describe("knock requester", () => {
    function givePeerNode(stream: MockStream): void {
      p2p.getNode.mockReturnValue({
        open_bi: vi.fn(async () => stream),
      });
    }

    it("queryPeerPlaylists returns the peer's listing", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "hello_ok", nodeId: "peer-a", name: "viz", public: true },
        {
          v: 1,
          type: "playlists",
          items: [{ docId: DOC_ID, title: "tunez", songCount: 3 }],
        },
      ]);
      givePeerNode(stream);

      const listing = await queryPeerPlaylists("peer-a");

      expect(listing).toEqual({
        nodeId: "peer-a",
        name: "viz",
        public: true,
        items: [{ docId: DOC_ID, title: "tunez", songCount: 3 }],
        knockRequired: false,
      });
      expect(stream.closed).toBe(true);
    });

    it("queryPeerPlaylists flags knock_required", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "hello_ok", nodeId: "peer-a", public: false },
        { v: 1, type: "error", code: "knock_required", message: "knock" },
      ]);
      givePeerNode(stream);

      const listing = await queryPeerPlaylists("peer-a");

      expect(listing.knockRequired).toBe(true);
      expect(listing.items).toEqual([]);
    });

    it("knockOnPeer records the outbound knock and opens granted docs", async () => {
      makeDoc(DOC_ID, { title: "granted tunez" });
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock_status",
          status: "accepted",
          grantedDocIds: [DOC_ID],
        },
      ]);
      givePeerNode(stream);

      const result = await knockOnPeer("peer-a", "lemme in");

      expect(result).toEqual({ status: "accepted", docIds: [DOC_ID] });
      const knocks = await getAllKnocks();
      expect(knocks.find((k) => k.id === "out:peer-a")).toMatchObject({
        direction: "outbound",
        status: "accepted",
        message: "lemme in",
      });
      const entry = await getDocIndexEntry(DOC_ID);
      expect(entry?.source).toBe("shared");
      expect(docs.get(DOC_ID)?.peers).toHaveProperty("me-node");
    });

    it("knockOnPeer records a pending knock", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "knock_status", status: "pending" },
      ]);
      givePeerNode(stream);

      const result = await knockOnPeer("peer-a");

      expect(result).toEqual({ status: "pending", docIds: [] });
      const knocks = await getAllKnocks();
      expect(knocks.find((k) => k.id === "out:peer-a")?.status).toBe("pending");
    });

    it("knockForDocAccess sends a doc_access knock and syncs on acceptance", async () => {
      makeDoc(DOC_ID, { title: "locked tunez" });
      const stream = new MockStream("peer-a", [
        {
          v: 1,
          type: "knock_status",
          status: "accepted",
          grantedDocIds: [DOC_ID],
        },
      ]);
      givePeerNode(stream);

      const result = await knockForDocAccess(
        "peer-a",
        DOC_ID,
        "please let me in"
      );

      expect(result.status).toBe("accepted");
      const sentKnock = stream.sent[0];
      expect(sentKnock).toMatchObject({
        type: "knock",
        knockType: "doc_access",
        docId: DOC_ID,
        message: "please let me in",
      });
      const outKnock = (await getAllKnocks()).find(
        (k) => k.id === `out:peer-a:doc:${DOC_ID}`
      );
      expect(outKnock).toMatchObject({
        direction: "outbound",
        knockType: "doc_access",
        requestedDocId: DOC_ID,
        status: "accepted",
      });
      // doc should have been synced + indexed
      const entry = await getDocIndexEntry(DOC_ID);
      expect(entry?.source).toBe("shared");
    });

    it("knockForDocAccess returns pending when owner queues the request", async () => {
      const stream = new MockStream("peer-a", [
        { v: 1, type: "knock_status", status: "pending" },
      ]);
      givePeerNode(stream);

      const result = await knockForDocAccess("peer-a", DOC_ID, "");

      expect(result.status).toBe("pending");
      expect(await getDocIndexEntry(DOC_ID)).toBeUndefined();
    });
  });

  describe("knock inbox", () => {
    async function recordInboundKnock(nodeId: string): Promise<string> {
      const stream = new MockStream(nodeId, [{ v: 1, type: "knock", nodeId }]);
      await handlePlaylistzStream(stream);
      const knock = (await getInboundKnocks()).find(
        (k) => k.nodeId === nodeId
      )!;
      return knock.id;
    }

    it("acceptKnock persists the grant and records the peer in docs", async () => {
      const doc = makeDoc(DOC_ID);
      const knockId = await recordInboundKnock("peer-a");

      await acceptKnock(knockId, [DOC_ID]);

      const grant = await getAccessGrant("peer-a");
      expect(grant?.docIds).toEqual([DOC_ID]);
      expect(doc.peers).toHaveProperty("peer-a");
      expect(flushDoc).toHaveBeenCalledWith(DOC_ID);
      expect(adapter.addPeer).toHaveBeenCalledWith("peer-a");
      const knocks = await getInboundKnocks();
      expect(knocks[0]?.status).toBe("accepted");
    });

    it("denyKnock marks the knock rejected without a grant", async () => {
      const knockId = await recordInboundKnock("peer-a");

      await denyKnock(knockId);

      expect(await getAccessGrant("peer-a")).toBeUndefined();
      expect((await getInboundKnocks())[0]?.status).toBe("rejected");
    });
  });
});
