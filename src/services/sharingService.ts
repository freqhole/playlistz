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
  avatarDataUrl?: string;
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
  // fire-and-forget: tell connected peers about our updated identity
  void notifyPeersOfIdentityUpdate(settings);
}

/**
 * open a stream to every currently-connected peer and send our current
 * name + avatar so they can update their docIndex entries without waiting
 * for the next explicit hello exchange.
 */
async function notifyPeersOfIdentityUpdate(
  settings: ShareSettings
): Promise<void> {
  if (!protocolHandlerRegistered) return;
  let adapter: ReturnType<typeof getIrohAdapter>;
  try {
    adapter = getIrohAdapter();
  } catch {
    return;
  }
  const entries = await getAllDocIndexEntries().catch(() => [] as Awaited<ReturnType<typeof getAllDocIndexEntries>>);
  const seen = new Set<string>();
  const myNodeId = getIdentity()?.node_id ?? "";
  for (const entry of entries) {
    const nodeId = entry.remoteNodeId;
    if (!nodeId || nodeId === myNodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (!adapter.isConnected(nodeId)) continue;
    void (async () => {
      try {
        const stream = await openPlaylistzStream(nodeId);
        try {
          await sendMessage(stream, {
            v: 1,
            type: "identity_update",
            ...(settings.name ? { name: settings.name } : {}),
            ...(settings.avatarDataUrl
              ? { avatarDataUrl: settings.avatarDataUrl }
              : {}),
          });
        } finally {
          stream.close();
        }
      } catch {
        // peer unreachable - they'll get fresh data on next hello
      }
    })();
  }
}

// --- p2p bootstrap for sharing ---

let protocolHandlerRegistered = false;
let reconnectDone = false;
let leadershipWatched = false;
// interval id for the periodic reconnect timer (cleared on reset)
let reconnectIntervalId: ReturnType<typeof setInterval> | null = null;

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
        // periodic reconnect: re-dial known peers every 90s so automerge
        // can sync changes that arrived while the connection was down
        if (!reconnectIntervalId) {
          reconnectIntervalId = setInterval(() => void reconnectKnownPeers(), 90_000);
        }
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
 * do a quick hello exchange with a known peer and refresh their name +
 * avatar in docIndex entries and access grant record. silently ignores
 * errors (peer may be offline).
 */
async function refreshPeerIdentity(nodeId: string): Promise<void> {
  const identity = getIdentity();
  const settings = await getShareSettings().catch(
    () => ({ name: "", mode: "knock" as const })
  );
  let peerName: string | undefined;
  let peerAvatarDataUrl: string | undefined;
  try {
    const stream = await openPlaylistzStream(nodeId);
    try {
      await sendMessage(stream, {
        v: 1,
        type: "hello",
        nodeId: identity?.node_id ?? "",
        ...(settings.name ? { name: settings.name } : {}),
      });
      const reply = await readMessage(stream);
      if (reply?.type === "hello_ok") {
        peerName = reply.name;
        peerAvatarDataUrl = reply.avatarDataUrl;
      }
    } finally {
      stream.close();
    }
  } catch {
    return; // peer offline or unreachable
  }

  if (!peerName && !peerAvatarDataUrl) return;

  // update all docIndex entries that reference this peer
  const entries = await getAllDocIndexEntries().catch(
    () => [] as Awaited<ReturnType<typeof getAllDocIndexEntries>>
  );
  for (const entry of entries) {
    if (entry.remoteNodeId !== nodeId) continue;
    await addDocIndexEntry({
      ...entry,
      ...(peerName ? { remoteName: peerName } : {}),
      ...(peerAvatarDataUrl ? { remoteAvatarDataUrl: peerAvatarDataUrl } : {}),
    }).catch(() => {});
  }

  // update access grant if we have one for this peer
  const grant = await getAccessGrant(nodeId).catch(() => undefined);
  if (grant) {
    await upsertAccessGrant({
      ...grant,
      ...(peerName ? { name: peerName } : {}),
      ...(peerAvatarDataUrl ? { avatarDataUrl: peerAvatarDataUrl } : {}),
    }).catch(() => {});
  }
}

/**
 * connect to every peer recorded in the peers map of any indexed doc.
 * also warms the repo's docPeerCache so sharePolicy can announce docs.
 * pre-seeds the cache from docIndex entries before doc handles resolve
 * to close the timing window where a peer reconnects before the cache
 * is populated from the doc.
 */
export async function reconnectKnownPeers(): Promise<void> {
  const identity = getIdentity();
  const myNodeId = identity?.node_id ?? "";
  const adapter = getIrohAdapter();
  const entries = await getAllDocIndexEntries();
  const seen = new Set<string>();

  // fast pass: pre-authorize known remote peers from the docIndex before
  // waiting on doc handles. this prevents sharePolicy from rejecting a
  // reconnecting peer during the async doc-load window.
  for (const entry of entries) {
    if (entry.remoteNodeId && entry.remoteNodeId !== myNodeId) {
      authorizePeerForDoc(entry.docId as AutomergeUrl, entry.remoteNodeId);
    }
  }

  for (const entry of entries) {
    try {
      const handle = await findPlaylistDoc(entry.docId as AutomergeUrl);
      const doc = handle.doc();
      if (!doc) continue;
      for (const nodeId of Object.keys(doc.peers ?? {})) {
        if (nodeId && nodeId !== myNodeId && !seen.has(nodeId)) {
          seen.add(nodeId);
          void adapter.addPeer(nodeId).then(async () => {
            // refresh the peer's identity in docIndex + grant after connecting
            void refreshPeerIdentity(nodeId);
          }).catch((err) => {
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

// discriminated result of opening a share link.
// "synced"         - doc is now local (direct access or already present)
// "knock_required" - owner is in knock mode; call knockForDocAccess to proceed
export type OpenShareLinkResult =
  | { status: "synced"; docId: string }
  | {
      status: "knock_required";
      ownerNodeId: string;
      ownerName?: string;
      docId: string;
      title?: string;
    };

/**
 * build a share link for a playlist doc. requires a running node (the
 * link embeds our node id so the recipient can dial us). embeds the
 * current sharing mode so recipients know if a knock is required.
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
  const settings = await getShareSettings();
  const payload: SharePayloadV1 = {
    v: 1,
    n: identity.node_id,
    d: docId,
    ...(title ? { t: title } : {}),
    ...(settings.mode === "knock" ? { m: "knock" } : {}),
  };
  const token = encodeShareToken(payload);
  const fragment = shareFragment(payload);
  const base = `${window.location.origin}${window.location.pathname}`;
  return { token, url: `${base}${fragment}`, fragment };
}

/**
 * perform the actual automerge doc sync for a share payload.
 * dials the peer, finds the doc, records peers in the doc, and indexes it.
 * does a quick hello exchange to capture the peer's name and avatar.
 */
async function syncSharedDoc(
  payload: SharePayloadV1
): Promise<{ status: "synced"; docId: string }> {
  const identity = getIdentity();
  const adapter = getIrohAdapter();
  const mySettings = await getShareSettings();

  // pre-authorize the sharing peer so sharePolicy trusts them before the doc
  // arrives (the doc can't arrive if the policy already rejects the peer)
  authorizePeerForDoc(payload.d as AutomergeUrl, payload.n);

  // fetch name + avatar from the sharer via a hello exchange.
  // best-effort: failures are silently ignored so the main sync still proceeds.
  let peerName: string | undefined;
  let peerAvatarDataUrl: string | undefined;
  try {
    const stream = await openPlaylistzStream(payload.n);
    try {
      await sendMessage(stream, {
        v: 1,
        type: "hello",
        nodeId: identity?.node_id ?? "",
        ...(mySettings.name ? { name: mySettings.name } : {}),
      });
      const reply = await readMessage(stream);
      if (reply?.type === "hello_ok") {
        peerName = reply.name;
        peerAvatarDataUrl = reply.avatarDataUrl;
      }
    } finally {
      stream.close();
    }
  } catch {
    // peer may be offline or reject hello - not fatal
  }

  const alreadyLocal = await getDocIndexEntry(payload.d).catch(() => null);
  if (!alreadyLocal) {
    for (let attempt = 0; ; attempt++) {
      try {
        await adapter.addPeer(payload.n);
        break;
      } catch (err) {
        if (attempt >= 5) {
          log.warn("p2p.connect", "could not connect to sharing peer:", err);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  const handle = await findPlaylistDoc(payload.d as AutomergeUrl);
  const doc = handle.doc();

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

  const existing = await getDocIndexEntry(payload.d);
  if (!existing) {
    await addDocIndexEntry({
      docId: payload.d,
      title: doc?.title || payload.t || "shared playlist",
      addedAt: Date.now(),
      source: "shared",
      remoteNodeId: payload.n,
      remoteName: peerName,
      remoteAvatarDataUrl: peerAvatarDataUrl,
    });
  } else if (peerName || peerAvatarDataUrl) {
    // update name/avatar if we got fresher data
    await addDocIndexEntry({
      ...existing,
      ...(peerName ? { remoteName: peerName } : {}),
      ...(peerAvatarDataUrl ? { remoteAvatarDataUrl: peerAvatarDataUrl } : {}),
    });
  }

  return { status: "synced", docId: payload.d };
}

/**
 * open a share link (or raw token).
 * - if the link embeds `m: "knock"`, returns knock_required without syncing.
 *   call knockForDocAccess() once the user confirms, then the doc syncs.
 * - otherwise syncs the doc immediately and returns { status: "synced" }.
 */
export async function openShareLink(
  input: string
): Promise<OpenShareLinkResult> {
  const payload = decodeShareToken(input);
  if (!payload) {
    throw new Error("invalid share link");
  }

  await ensureSharingReady();

  // if already local, skip re-sync
  const alreadyLocal = await getDocIndexEntry(payload.d).catch(() => null);
  if (alreadyLocal) {
    return { status: "synced", docId: payload.d };
  }

  // knock mode encoded in the link: gate sync behind a knock
  if (payload.m === "knock") {
    return {
      status: "knock_required",
      ownerNodeId: payload.n,
      docId: payload.d,
      title: payload.t,
    };
  }

  return syncSharedDoc(payload);
}

/**
 * check location.hash for a #share/ fragment. if present, open it and
 * clear the fragment. returns an OpenShareLinkResult or null.
 */
export async function handleShareFragment(): Promise<OpenShareLinkResult | null> {
  const hash = window.location.hash;
  if (!hash.startsWith("#share/")) return null;
  try {
    const result = await openShareLink(hash);
    // clear the fragment so reloads don't re-trigger
    history.replaceState(null, "", window.location.pathname);
    return result;
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
  avatarDataUrl?: string;
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
        avatarDataUrl: helloReply.avatarDataUrl,
        public: helloReply.public,
        items: listReply.items,
        knockRequired: false,
      };
    }
    if (listReply?.type === "error" && listReply.code === "knock_required") {
      return {
        nodeId,
        name: helloReply.name,
        avatarDataUrl: helloReply.avatarDataUrl,
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
            remoteNodeId: nodeId,
          });
        }
      } catch (err) {
        log.warn("p2p.knock", "failed to open granted doc:", docId, err);
      }
    }
  }

  return { status: reply.status, docIds };
}

/**
 * send a doc_access knock to a specific peer for a specific playlist doc.
 * used after openShareLink returns knock_required.
 * when accepted, syncs the doc and indexes it automatically.
 */
export async function knockForDocAccess(
  ownerNodeId: string,
  docId: string,
  message: string,
  titleHint?: string
): Promise<{ status: "pending" | "accepted" | "denied" }> {
  const identity = getIdentity();
  const settings = await getShareSettings();
  const stream = await openPlaylistzStream(ownerNodeId);
  let reply: Message | null;
  try {
    await sendMessage(stream, {
      v: 1,
      type: "knock",
      nodeId: identity?.node_id ?? "",
      ...(settings.name ? { name: settings.name } : {}),
      ...(message ? { message } : {}),
      knockType: "doc_access",
      docId,
    });
    reply = await readMessage(stream);
  } finally {
    stream.close();
  }

  if (reply?.type !== "knock_status") {
    throw new Error("peer did not answer knock");
  }

  await upsertKnock({
    id: `out:${ownerNodeId}:doc:${docId}`,
    nodeId: ownerNodeId,
    direction: "outbound",
    name: "",
    message,
    status: reply.status === "denied" ? "rejected" : reply.status,
    createdAt: Date.now(),
    knockType: "doc_access",
    requestedDocId: docId,
    ...(reply.status !== "pending" ? { processedAt: Date.now() } : {}),
  });

  if (reply.status === "accepted") {
    const granted = reply.grantedDocIds ?? [docId];
    if (granted.includes(docId)) {
      await syncSharedDoc({ v: 1, n: ownerNodeId, d: docId, ...(titleHint ? { t: titleHint } : {}) });
    }
  }

  return { status: reply.status };
}

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

  // try to get the peer's avatar from any docIndex entry we already have
  const allEntries = await getAllDocIndexEntries().catch(() => [] as Awaited<ReturnType<typeof getAllDocIndexEntries>>);
  const peerEntry = allEntries.find((e) => e.remoteNodeId === knock.nodeId);

  await upsertAccessGrant({
    nodeId: knock.nodeId,
    name: knock.name,
    grantedAt: Date.now(),
    docIds,
    ...(peerEntry?.remoteAvatarDataUrl
      ? { avatarDataUrl: peerEntry.remoteAvatarDataUrl }
      : {}),
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

  // fire-and-forget: notify the peer they've been accepted so they don't
  // have to poll. if the peer is offline this fails silently.
  const identity = getIdentity();
  void (async () => {
    try {
      const stream = await openPlaylistzStream(knock.nodeId);
      try {
        await sendMessage(stream, {
          v: 1,
          type: "knock_notify",
          status: "accepted",
          docIds,
          ownerNodeId: identity?.node_id ?? "",
        });
      } finally {
        stream.close();
      }
    } catch {
      // peer offline or unreachable - they'll get the status on their next knock
    }
  })();

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

/** list outbound knocks (sent by us) for the pending-access UI. */
export async function getOutboundKnocks(): Promise<KnockRecord[]> {
  const knocks = await getAllKnocks();
  return knocks
    .filter((k) => k.direction === "outbound")
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
        ...(settings.avatarDataUrl ? { avatarDataUrl: settings.avatarDataUrl } : {}),
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
      const isDocAccessKnock = msg.knockType === "doc_access" && !!msg.docId;
      const existing = await getAccessGrant(msg.nodeId);

      if (isDocAccessKnock && msg.docId) {
        // doc_access knock: check if this peer already has a grant covering this doc
        if (existing && (!existing.docIds || existing.docIds.includes(msg.docId))) {
          await sendMessage(stream, {
            v: 1,
            type: "knock_status",
            status: "accepted",
            grantedDocIds: [msg.docId],
          });
          break;
        }
      } else if (existing) {
        // browse knock: check if any grant exists
        await sendMessage(stream, {
          v: 1,
          type: "knock_status",
          status: "accepted",
          grantedDocIds: existing.docIds ?? [],
        });
        break;
      }

      // check for a prior knock of the same type from this node
      const knocks = await getAllKnocks();
      const prior = knocks.find(
        (k) =>
          k.direction === "inbound" &&
          k.nodeId === msg.nodeId &&
          (isDocAccessKnock
            ? k.knockType === "doc_access" && k.requestedDocId === msg.docId
            : k.knockType !== "doc_access")
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
          knockType: isDocAccessKnock ? "doc_access" : "browse",
          ...(isDocAccessKnock && msg.docId ? { requestedDocId: msg.docId } : {}),
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

    case "knock_notify": {
      // the peer owner has accepted our knock and is notifying us proactively.
      // update our outbound knock record and sync the granted docs.
      const myNodeId = getIdentity()?.node_id ?? "";
      for (const docId of msg.docIds) {
        try {
          const handle = await findPlaylistDoc(docId as AutomergeUrl);
          const doc = handle.doc();
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
              remoteNodeId: msg.ownerNodeId,
            });
          }
        } catch (err) {
          log.warn("p2p.knock", "failed to sync granted doc from notify:", docId, err);
        }
      }
      // mark any matching outbound knock as accepted
      const allKnocks = await getAllKnocks();
      for (const k of allKnocks) {
        if (k.direction === "outbound" && k.nodeId === peerNodeId && k.status === "pending") {
          await upsertKnock({ ...k, status: "accepted", processedAt: Date.now() });
        }
      }
      notifyKnocksChanged();
      break;
    }

    case "identity_update": {
      // peer changed their name or avatar - update all our docIndex entries
      // and access grant records that reference this peer
      const updates: Promise<void>[] = [];
      const entries = await getAllDocIndexEntries();
      for (const entry of entries) {
        if (entry.remoteNodeId !== peerNodeId) continue;
        const updated = {
          ...entry,
          ...(msg.name !== undefined ? { remoteName: msg.name } : {}),
          ...(msg.avatarDataUrl !== undefined
            ? { remoteAvatarDataUrl: msg.avatarDataUrl }
            : {}),
        };
        updates.push(addDocIndexEntry(updated));
      }
      // also update the access grant record if we have one for this peer
      const grant = await getAccessGrant(peerNodeId).catch(() => undefined);
      if (grant) {
        updates.push(
          upsertAccessGrant({
            ...grant,
            ...(msg.name !== undefined ? { name: msg.name } : {}),
            ...(msg.avatarDataUrl !== undefined
              ? { avatarDataUrl: msg.avatarDataUrl }
              : {}),
          })
        );
      }
      await Promise.allSettled(updates);
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
  if (reconnectIntervalId !== null) {
    clearInterval(reconnectIntervalId);
    reconnectIntervalId = null;
  }
  knockListeners.clear();
}
