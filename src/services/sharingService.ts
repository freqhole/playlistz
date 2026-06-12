// p2p sharing service for playlistz.
//
// covers the phase 5 surface:
//   - endpoint settings (name, avatar, public/knock mode)
//   - share link generation + the open-share-link flow
//   - peer reconnect on boot (registerAndReconnectPeers pattern)
//   - knock protocol requester + responder on the playlistz ALPN
//
// the responder also dispatches blob_request messages to the blob
// transfer service (phase 6) so a single stream handler covers the
// whole freqhole-playlistz/1 protocol.

import {
  PLAYLISTZ_ALPN,
  encodeShareToken,
  decodeShareToken,
  shareFragment,
  sendMessage,
  readMessage,
  addPeer as addPeerToDoc,
  type Message,
  type BiStreamLike,
  type SharePayloadV1,
} from "freqhole-api-client/playlistz";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { getIrohAdapter, findPlaylistDoc, flushDoc, authorizePeerForDoc } from "./automergeRepo.js";
import {
  startP2P,
  getIdentity,
  getNode,
  waitForNode,
  onLeadershipChange,
  hasExistingIdentity,
} from "./p2pService.js";
import {
  addDocIndexEntry,
  getDocIndexEntry,
  getAllDocIndexEntries,
  upsertKnock,
  getAllKnocks,
  upsertAccessGrant,
  getAccessGrant,
} from "./docIndexService.js";
import { loadSetting, saveSetting } from "./indexedDBService.js";
import type { KnockRecord } from "./indexedDBService.js";
import { serveBlobRequest } from "./blobTransferService.js";
import { log } from "../utils/log.js";

// --- endpoint settings ---

export interface ShareSettings {
  name: string;
  mode: "public" | "knock";
  avatarSha?: string;
}

const SETTINGS_KEY = "p2p:endpoint";

export async function getShareSettings(): Promise<ShareSettings> {
  const stored = await loadSetting<ShareSettings>(SETTINGS_KEY);
  return stored ?? { name: "", mode: "knock" };
}

export async function saveShareSettings(
  settings: ShareSettings
): Promise<void> {
  await saveSetting(SETTINGS_KEY, settings);
}

// --- p2p bootstrap for sharing ---

let protocolHandlerRegistered = false;
let reconnectDone = false;
let leadershipWatched = false;

// listeners notified when the knock inbox changes (new knock arrived)
const knockListeners = new Set<() => void>();

export function onKnocksChanged(cb: () => void): () => void {
  knockListeners.add(cb);
  return () => {
    knockListeners.delete(cb);
  };
}

function notifyKnocksChanged(): void {
  for (const cb of knockListeners) {
    try {
      cb();
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * start p2p and wire up the playlistz protocol responder + peer reconnect.
 * idempotent. safe to call from UI event handlers.
 */
export async function ensureSharingReady(): Promise<void> {
  await startP2P();

  if (!protocolHandlerRegistered) {
    protocolHandlerRegistered = true;
    const adapter = getIrohAdapter();
    adapter.registerAlpnHandler(PLAYLISTZ_ALPN, (stream) => {
      void handlePlaylistzStream(stream);
    });
  }

  // reconnect to peers recorded in docs once we hold the node
  if (!leadershipWatched) {
    leadershipWatched = true;
    onLeadershipChange((leader) => {
      if (leader && !reconnectDone) {
        reconnectDone = true;
        void reconnectKnownPeers();
      }
    });
  }

  // startP2P resolves before the midden node finishes booting - wait so
  // callers (buildShareLink, openShareLink) can dial immediately. resolves
  // null fast in non-leader tabs, where the node lives elsewhere.
  await waitForNode();
}

/**
 * resume p2p on app boot, but only if the user has already enabled it
 * (an identity exists). first-time p2p start stays an explicit user action
 * in the share panel.
 */
export async function resumeSharingIfEnabled(): Promise<void> {
  if (await hasExistingIdentity()) {
    await ensureSharingReady();
  }
}

/**
 * connect to every peer recorded in the peers map of any indexed doc.
 * also warms the repo's docPeerCache so sharePolicy can announce docs.
 */
export async function reconnectKnownPeers(): Promise<void> {
  const identity = getIdentity();
  const myNodeId = identity?.node_id ?? "";
  const adapter = getIrohAdapter();
  const entries = await getAllDocIndexEntries();
  const seen = new Set<string>();

  for (const entry of entries) {
    try {
      const handle = await findPlaylistDoc(entry.docId as AutomergeUrl);
      const doc = handle.doc();
      if (!doc) continue;
      for (const nodeId of Object.keys(doc.peers ?? {})) {
        if (nodeId && nodeId !== myNodeId && !seen.has(nodeId)) {
          seen.add(nodeId);
          adapter.addPeer(nodeId).catch((err) => {
            log.warn("p2p.reconnect", "reconnect to peer failed:", nodeId.slice(0, 16), err);
          });
        }
      }
    } catch {
      // doc unavailable locally - skip
    }
  }
}

// --- share links ---

/**
 * build a share link for a playlist doc. requires a running node (the
 * link embeds our node id so the recipient can dial us).
 */
export async function buildShareLink(
  docId: string,
  title?: string
): Promise<{ token: string; url: string; fragment: string }> {
  await ensureSharingReady();
  const identity = getIdentity();
  if (!identity?.node_id) {
    throw new Error(
      "p2p node is not running - cannot create a share link without a node id"
    );
  }
  const payload: SharePayloadV1 = {
    v: 1,
    n: identity.node_id,
    d: docId,
    ...(title ? { t: title } : {}),
  };
  const token = encodeShareToken(payload);
  const fragment = shareFragment(payload);
  const base = `${window.location.origin}${window.location.pathname}`;
  return { token, url: `${base}${fragment}`, fragment };
}

/**
 * open a share link (or raw token): connect to the peer, sync the doc,
 * record ourselves in the doc's peers map, and index the playlist.
 * returns the docId on success.
 */
export async function openShareLink(input: string): Promise<string> {
  const payload = decodeShareToken(input);
  if (!payload) {
    throw new Error("invalid share link");
  }

  await ensureSharingReady();
  const identity = getIdentity();
  const adapter = getIrohAdapter();

  // pre-authorize the sharing peer for this doc. sharePolicy only trusts
  // peers recorded in the doc, but we don't have the doc yet - without
  // this seed, repo.find would never request it from the peer
  authorizePeerForDoc(payload.d as AutomergeUrl, payload.n);

  // if the doc is already in the local index, skip the peer dial - it's local
  const alreadyLocal = await getDocIndexEntry(payload.d).catch(() => null);

  if (!alreadyLocal) {
    // dial the sharing peer first so repo.find can fetch the doc. discovery
    // records (pkarr/dns) can lag for a freshly-booted peer, so retry the
    // dial a few times before giving up
    for (let attempt = 0; ; attempt++) {
      try {
        await adapter.addPeer(payload.n);
        break;
      } catch (err) {
        if (attempt >= 5) {
          log.warn("p2p.connect", "could not connect to sharing peer:", err);
          // continue anyway - the doc may already be local or another peer has it
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  const handle = await findPlaylistDoc(payload.d as AutomergeUrl);
  const doc = handle.doc();

  // record ourselves AND the sharing peer in the doc's peers map. ourselves
  // so the owner's sharePolicy announces this doc to us on reconnect; the
  // sharer so our own policy keeps trusting them after the cache is rebuilt
  // from the doc (and so reconnectKnownPeers can redial them after reload)
  const myNodeId = identity?.node_id;
  if (doc) {
    const peers = doc.peers ?? {};
    const missingSelf = !!myNodeId && !(myNodeId in peers);
    const missingSharer = !(payload.n in peers);
    if (missingSelf || missingSharer) {
      handle.change((d) => {
        if (missingSelf && myNodeId) addPeerToDoc(d, myNodeId);
        if (missingSharer) addPeerToDoc(d, payload.n);
      });
      await flushDoc(payload.d as AutomergeUrl);
    }
  }

  // index the playlist for the sidebar
  const existing = await getDocIndexEntry(payload.d);
  if (!existing) {
    await addDocIndexEntry({
      docId: payload.d,
      title: doc?.title || payload.t || "shared playlist",
      addedAt: Date.now(),
      source: "shared",
    });
  }

  return payload.d;
}

/**
 * check location.hash for a #share/ fragment. if present, open it and
 * clear the fragment. returns the docId if a share link was opened.
 */
export async function handleShareFragment(): Promise<string | null> {
  const hash = window.location.hash;
  if (!hash.startsWith("#share/")) return null;
  try {
    const docId = await openShareLink(hash);
    // clear the fragment so reloads don't re-trigger
    history.replaceState(null, "", window.location.pathname);
    return docId;
  } catch (err) {
    log.error("share.fragment", "failed to open share link:", err);
    history.replaceState(null, "", window.location.pathname);
    throw err;
  }
}

// --- knock requester ---

export interface PeerPlaylistListing {
  nodeId: string;
  name?: string;
  public: boolean;
  items: { docId: string; title: string; songCount: number }[];
  knockRequired: boolean;
}

async function openPlaylistzStream(nodeId: string): Promise<BiStreamLike> {
  await ensureSharingReady();
  const node = getNode();
  if (!node) {
    throw new Error("p2p node is not running in this tab");
  }
  return (await node.open_bi(
    nodeId,
    PLAYLISTZ_ALPN
  )) as unknown as BiStreamLike;
}

/**
 * query a peer for its playlist listing. sends hello + list_playlists.
 * if the peer requires a knock, knockRequired is true and items is empty.
 */
export async function queryPeerPlaylists(
  nodeId: string
): Promise<PeerPlaylistListing> {
  const identity = getIdentity();
  const settings = await getShareSettings();
  const stream = await openPlaylistzStream(nodeId);
  try {
    await sendMessage(stream, {
      v: 1,
      type: "hello",
      nodeId: identity?.node_id ?? "",
      ...(settings.name ? { name: settings.name } : {}),
    });
    const helloReply = await readMessage(stream);
    if (helloReply?.type !== "hello_ok") {
      throw new Error("peer did not answer hello");
    }

    await sendMessage(stream, { v: 1, type: "list_playlists" });
    const listReply = await readMessage(stream);

    if (listReply?.type === "playlists") {
      return {
        nodeId,
        name: helloReply.name,
        public: helloReply.public,
        items: listReply.items,
        knockRequired: false,
      };
    }
    if (listReply?.type === "error" && listReply.code === "knock_required") {
      return {
        nodeId,
        name: helloReply.name,
        public: helloReply.public,
        items: [],
        knockRequired: true,
      };
    }
    throw new Error("unexpected reply to list_playlists");
  } finally {
    stream.close();
  }
}

/**
 * knock on a peer. returns the resulting status; when accepted, the
 * granted doc ids are opened + indexed automatically.
 */
export async function knockOnPeer(
  nodeId: string,
  message?: string
): Promise<{ status: "pending" | "accepted" | "denied"; docIds: string[] }> {
  const identity = getIdentity();
  const settings = await getShareSettings();
  const stream = await openPlaylistzStream(nodeId);
  let reply: Message | null;
  try {
    await sendMessage(stream, {
      v: 1,
      type: "knock",
      nodeId: identity?.node_id ?? "",
      ...(settings.name ? { name: settings.name } : {}),
      ...(message ? { message } : {}),
    });
    reply = await readMessage(stream);
  } finally {
    stream.close();
  }

  if (reply?.type !== "knock_status") {
    throw new Error("peer did not answer knock");
  }

  // track the outbound knock for the UI
  await upsertKnock({
    id: `out:${nodeId}`,
    nodeId,
    direction: "outbound",
    name: "",
    message: message ?? "",
    status: reply.status === "denied" ? "rejected" : reply.status,
    createdAt: Date.now(),
    ...(reply.status !== "pending" ? { processedAt: Date.now() } : {}),
  });

  const docIds = reply.grantedDocIds ?? [];
  if (reply.status === "accepted" && docIds.length > 0) {
    const adapter = getIrohAdapter();
    await adapter.addPeer(nodeId).catch(() => {});
    for (const docId of docIds) {
      try {
        const handle = await findPlaylistDoc(docId as AutomergeUrl);
        const doc = handle.doc();
        const myNodeId = identity?.node_id;
        if (myNodeId && doc && !(myNodeId in (doc.peers ?? {}))) {
          handle.change((d) => addPeerToDoc(d, myNodeId));
          await flushDoc(docId as AutomergeUrl);
        }
        if (!(await getDocIndexEntry(docId))) {
          await addDocIndexEntry({
            docId,
            title: doc?.title || "shared playlist",
            addedAt: Date.now(),
            source: "shared",
          });
        }
      } catch (err) {
        log.warn("p2p.knock", "failed to open granted doc:", docId, err);
      }
    }
  }

  return { status: reply.status, docIds };
}

// --- knock responder (inbox side) ---

/**
 * accept an inbound knock: persist the grant, record the peer in each
 * granted doc, and dial the peer so sync starts immediately.
 */
export async function acceptKnock(
  knockId: string,
  docIds: string[]
): Promise<void> {
  const knocks = await getAllKnocks();
  const knock = knocks.find((k) => k.id === knockId);
  if (!knock) throw new Error("knock not found");

  await upsertAccessGrant({
    nodeId: knock.nodeId,
    name: knock.name,
    grantedAt: Date.now(),
    docIds,
  });
  await upsertKnock({
    ...knock,
    status: "accepted",
    processedAt: Date.now(),
  });

  for (const docId of docIds) {
    try {
      const handle = await findPlaylistDoc(docId as AutomergeUrl);
      const doc = handle.doc();
      if (doc && !(knock.nodeId in (doc.peers ?? {}))) {
        handle.change((d) => addPeerToDoc(d, knock.nodeId));
        await flushDoc(docId as AutomergeUrl);
      }
    } catch (err) {
      log.warn("p2p.knock", "failed to record peer in doc:", docId, err);
    }
  }

  const adapter = getIrohAdapter();
  await adapter.addPeer(knock.nodeId).catch(() => {});
  notifyKnocksChanged();
}

/** deny an inbound knock. */
export async function denyKnock(knockId: string): Promise<void> {
  const knocks = await getAllKnocks();
  const knock = knocks.find((k) => k.id === knockId);
  if (!knock) return;
  await upsertKnock({
    ...knock,
    status: "rejected",
    processedAt: Date.now(),
  });
  notifyKnocksChanged();
}

/** list inbound knocks for the inbox UI (newest first). */
export async function getInboundKnocks(): Promise<KnockRecord[]> {
  const knocks = await getAllKnocks();
  return knocks
    .filter((k) => k.direction === "inbound")
    .sort((a, b) => b.createdAt - a.createdAt);
}

// --- protocol responder ---

async function buildPlaylistItems(): Promise<
  { docId: string; title: string; songCount: number }[]
> {
  const entries = await getAllDocIndexEntries();
  const items: { docId: string; title: string; songCount: number }[] = [];
  for (const entry of entries) {
    try {
      const handle = await findPlaylistDoc(entry.docId as AutomergeUrl);
      const doc = handle.doc();
      items.push({
        docId: entry.docId,
        title: doc?.title || entry.title,
        songCount: doc ? Object.keys(doc.songs ?? {}).length : 0,
      });
    } catch {
      items.push({ docId: entry.docId, title: entry.title, songCount: 0 });
    }
  }
  return items;
}

/**
 * handle one inbound stream on the playlistz ALPN. loops over messages
 * until EOF. exported for tests.
 */
export async function handlePlaylistzStream(
  stream: BiStreamLike
): Promise<void> {
  const peerNodeId = stream.peer_node_id();
  try {
    for (;;) {
      const msg = await readMessage(stream);
      if (msg === null) break;
      await handleProtocolMessage(stream, peerNodeId, msg);
    }
  } catch (err) {
      log.warn("p2p.protocol", "protocol stream error:", err);
  } finally {
    try {
      stream.close();
    } catch {
      // already closed
    }
  }
}

async function handleProtocolMessage(
  stream: BiStreamLike,
  peerNodeId: string,
  msg: Message
): Promise<void> {
  const identity = getIdentity();
  const settings = await getShareSettings();

  switch (msg.type) {
    case "hello": {
      await sendMessage(stream, {
        v: 1,
        type: "hello_ok",
        nodeId: identity?.node_id ?? "",
        ...(settings.name ? { name: settings.name } : {}),
        public: settings.mode === "public",
      });
      break;
    }

    case "list_playlists": {
      const grant = await getAccessGrant(peerNodeId);
      if (settings.mode !== "public" && !grant) {
        await sendMessage(stream, {
          v: 1,
          type: "error",
          code: "knock_required",
          message: "this node requires a knock before listing playlists",
        });
        break;
      }
      let items = await buildPlaylistItems();
      // a grant may be scoped to specific docs
      if (settings.mode !== "public" && grant?.docIds) {
        const allowed = new Set(grant.docIds);
        items = items.filter((i) => allowed.has(i.docId));
      }
      await sendMessage(stream, { v: 1, type: "playlists", items });
      break;
    }

    case "knock": {
      const existing = await getAccessGrant(msg.nodeId);
      if (existing) {
        await sendMessage(stream, {
          v: 1,
          type: "knock_status",
          status: "accepted",
          grantedDocIds: existing.docIds ?? [],
        });
        break;
      }
      // record the knock for the inbox if we haven't seen it
      const knocks = await getAllKnocks();
      const prior = knocks.find(
        (k) => k.direction === "inbound" && k.nodeId === msg.nodeId
      );
      if (prior?.status === "rejected") {
        await sendMessage(stream, {
          v: 1,
          type: "knock_status",
          status: "denied",
        });
        break;
      }
      if (!prior) {
        await upsertKnock({
          id: crypto.randomUUID(),
          nodeId: msg.nodeId,
          direction: "inbound",
          name: msg.name ?? "",
          message: msg.message ?? "",
          status: "pending",
          createdAt: Date.now(),
        });
        notifyKnocksChanged();
      }
      await sendMessage(stream, {
        v: 1,
        type: "knock_status",
        status: "pending",
      });
      break;
    }

    case "blob_request": {
      // only serve blobs to peers who have an accepted grant (or if public mode)
      const blobGrant = await getAccessGrant(peerNodeId);
      if (settings.mode !== "public" && !blobGrant) {
        await sendMessage(stream, {
          v: 1,
          type: "error",
          code: "knock_required",
          message: "access denied: knock required before requesting blobs",
        });
        break;
      }
      await serveBlobRequest(stream, msg.sha256);
      break;
    }

    default: {
      await sendMessage(stream, {
        v: 1,
        type: "error",
        code: "unexpected_message",
        message: `unexpected message type: ${msg.type}`,
      });
    }
  }
}

/** reset module state. for use in tests only. */
export function _resetSharingForTests(): void {
  protocolHandlerRegistered = false;
  reconnectDone = false;
  leadershipWatched = false;
  knockListeners.clear();
}
