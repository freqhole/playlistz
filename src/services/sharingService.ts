// p2p sharing service for playlistz.
//
// provides:
//   - endpoint settings (name, avatar, public/knock mode)
//   - share link generation + the open-share-link flow
//   - peer reconnect on boot (registerAndReconnectPeers pattern)
//   - knock protocol requester + responder on the playlistz ALPN
//
// the responder also dispatches blob_request messages to the blob
// transfer service so a single stream handler covers the
// whole freqhole-playlistz/1 protocol.

import {
  PLAYLISTZ_ALPN,
  sendMessage,
  readMessage,
  addPeer as addPeerToDoc,
  type Message,
  type BiStreamLike,
} from "../types/playlistz";
import {
  encodeShareToken,
  decodeShareToken,
  shareFragment,
  type DocSharePayload,
} from "@freqhole/haruspex/share";
import {
  createIdbKnockStore,
  sendKnock,
  acceptKnock as haruspexAcceptKnock,
  denyKnock as haruspexDenyKnock,
  type KnockStore,
  type KnockRecord,
  type KnockScope,
  type KnockRequest,
  type KnockStatusReply,
  type KnockTransport,
  type KnockPolicy,
  type KnockPolicyResult,
} from "@freqhole/haruspex/knock";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getIrohAdapter,
  findPlaylistDoc,
  flushDoc,
  authorizePeerForDoc,
} from "./automergeRepo.js";
import {
  startP2P,
  getIdentity,
  getNode,
  getPeerDialAddr,
  waitForNode,
  onLeadershipChange,
  hasExistingIdentity,
} from "./p2pService.js";
import {
  addDocIndexEntry,
  getDocIndexEntry,
  getAllDocIndexEntries,
  upsertAccessGrant,
  getAccessGrant,
} from "./docIndexService.js";
import { loadSetting, saveSetting } from "./indexedDBService.js";
import { serveBlobRequest } from "./blobTransferService.js";
import { log } from "../utils/log.js";

// haruspex knock store for this app - lazily created to support test resets.
// deliberately a separate database from musicPlaylistDB: that database's own
// schema (indexedDBService.ts) already independently version-manages a bare
// "knocks" object store with no indexes for its own legacy code path -
// pointing this store at the same database name means createIdbKnockStore
// sees an object store that already "exists" and skips creating the
// nodeId/dedup indexes it actually needs, silently breaking dedup lookups.
const KNOCK_STORE_DB_NAME = "playlistz-knocks";

let knockStore: KnockStore | null = null;

function getKnockStore(): KnockStore {
  if (!knockStore) {
    knockStore = createIdbKnockStore({
      databaseName: KNOCK_STORE_DB_NAME,
      storeName: "knocks",
    });
  }
  return knockStore;
}


// playlistz-specific extension of haruspex's KnockRecord for UI compatibility.
// adds fields the UI expects but haruspex's core record doesn't track.
export interface PlaylistzKnockRecord extends Omit<KnockRecord, 'status'> {
  name: string;
  knockType: "browse" | "doc_access";
  requestedDocId?: string;
  status: "pending" | "accepted" | "rejected";
}

// an inbound knock's sender carries their display name alongside the wire
// message; haruspex's KnockRecord has no dedicated field for it, so it's
// stored in the record's generic metadata bag instead (see
// CreateKnockInput.metadata). outbound records never set this.
function inboundSenderName(record: KnockRecord): string {
  const name = record.metadata?.name;
  return typeof name === "string" ? name : "";
}

/** true when two knock scopes describe the same request (same kind and,
 *  for resource scope, the same resourceId) - browse and doc_access knocks
 *  from the same peer are distinct requests, tracked separately. */
function scopesMatch(a: KnockScope, b: KnockScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "resource" && b.kind === "resource") return a.resourceId === b.resourceId;
  if (a.kind === "account" && b.kind === "account") return a.requestedUsername === b.requestedUsername;
  return true;
}

// adapt haruspex's KnockRecord to playlistz's UI expectations
function toPlaylistzKnock(record: KnockRecord): PlaylistzKnockRecord {
  const knockType = record.scope.kind === "browse" ? "browse" : "doc_access";
  const requestedDocId = record.scope.kind === "resource" 
    ? record.scope.resourceId 
    : undefined;
  // map haruspex's "denied" to playlistz's "rejected" for UI compat
  const status = record.status === "denied" ? "rejected" : record.status;
  const name = record.direction === "inbound" ? inboundSenderName(record) : "";
  return {
    ...record,
    name,
    knockType,
    requestedDocId,
    status,
  };
}

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
  const entries = await getAllDocIndexEntries().catch(
    () => [] as Awaited<ReturnType<typeof getAllDocIndexEntries>>
  );
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
          reconnectIntervalId = setInterval(
            () => void reconnectKnownPeers(),
            90_000
          );
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
  const settings = await getShareSettings().catch(() => ({
    name: "",
    mode: "knock" as const,
  }));
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
          void adapter
            .addPeer(nodeId)
            .then(async () => {
              // refresh the peer's identity in docIndex + grant after connecting
              void refreshPeerIdentity(nodeId);
            })
            .catch((err) => {
              log.warn(
                "p2p.reconnect",
                "reconnect to peer failed:",
                nodeId.slice(0, 16),
                err
              );
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
  const payload: DocSharePayload = {
    kind: "doc",
    nodeId: identity.node_id,
    docId,
    ...(title ? { title } : {}),
    ...(settings.mode === "knock" ? { mode: "knock" } : {}),
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
  payload: DocSharePayload
): Promise<{ status: "synced"; docId: string }> {
  const identity = getIdentity();
  const adapter = getIrohAdapter();
  const mySettings = await getShareSettings();

  // pre-authorize the sharing peer so sharePolicy trusts them before the doc
  // arrives (the doc can't arrive if the policy already rejects the peer)
  authorizePeerForDoc(payload.docId as AutomergeUrl, payload.nodeId);

  // fetch name + avatar from the sharer via a hello exchange.
  // best-effort: failures are silently ignored so the main sync still proceeds.
  let peerName: string | undefined;
  let peerAvatarDataUrl: string | undefined;
  // bound the whole hello exchange (open + write + read) with one timeout. the
  // stream can open before its path is validated, leaving a subsequent write or
  // read blocked indefinitely; cap it so the flow falls through to the automerge
  // sync below instead of hanging.
  try {
    const helloDeadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("hello timed out")), 8_000)
    );
    await Promise.race([
      (async () => {
        const stream = await openPlaylistzStream(payload.nodeId);
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
      })(),
      helloDeadline,
    ]);
  } catch {
    // peer may be offline or reject hello - not fatal
  }

  const alreadyLocal = await getDocIndexEntry(payload.docId).catch(() => null);
  if (!alreadyLocal) {
    // dial the sharing peer. addPeer hands off to a background reconnect loop
    // with backoff on failure, so a single call is enough.
    const dial = adapter.addPeer(payload.nodeId);
    await Promise.race([
      dial,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("addPeer timed out")), 10_000)
      ),
    ]).catch((err) => {
      log.warn("p2p.connect", "initial dial to sharing peer failed:", err);
    });
  }

  // wait up to 30s for the doc to arrive; if it times out, proceed anyway -
  // automerge will sync in the background once a peer connection establishes
  let handle: Awaited<ReturnType<typeof findPlaylistDoc>> | undefined;
  try {
    handle = await Promise.race([
      findPlaylistDoc(payload.docId as AutomergeUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("doc sync timed out")), 30_000)
      ),
    ]);
  } catch {
    // doc not yet available - will sync in background
  }
  const doc = handle?.doc() ?? null;

  const myNodeId = identity?.node_id;
  if (doc && handle) {
    const peers = doc.peers ?? {};
    const missingSelf = !!myNodeId && !(myNodeId in peers);
    const missingSharer = !(payload.nodeId in peers);
    if (missingSelf || missingSharer) {
      handle.change((d) => {
        if (missingSelf && myNodeId) addPeerToDoc(d, myNodeId);
        if (missingSharer) addPeerToDoc(d, payload.nodeId);
      });
      await flushDoc(payload.docId as AutomergeUrl);
    }
  }

  const existing = await getDocIndexEntry(payload.docId);
  if (!existing) {
    await addDocIndexEntry({
      docId: payload.docId,
      title: doc?.title || payload.title || "shared playlist",
      addedAt: Date.now(),
      source: "shared",
      remoteNodeId: payload.nodeId,
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

  return { status: "synced", docId: payload.docId };
}

/**
 * open a share link (or raw token).
 * - if the link embeds `mode: "knock"`, returns knock_required without syncing.
 *   call knockForDocAccess() once the user confirms, then the doc syncs.
 * - otherwise syncs the doc immediately and returns { status: "synced" }.
 */
export async function openShareLink(
  input: string
): Promise<OpenShareLinkResult> {
  const payload = decodeShareToken(input);
  if (!payload || payload.kind !== "doc") {
    throw new Error("invalid share link");
  }

  await ensureSharingReady();

  // if already local, skip re-sync
  const alreadyLocal = await getDocIndexEntry(payload.docId).catch(() => null);
  if (alreadyLocal) {
    return { status: "synced", docId: payload.docId };
  }

  // knock mode encoded in the link: gate sync behind a knock
  if (payload.mode === "knock") {
    return {
      status: "knock_required",
      ownerNodeId: payload.nodeId,
      docId: payload.docId,
      title: payload.title,
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
  // race against a timeout so open_bi doesn't hang indefinitely when the
  // iroh relay hasn't yet propagated the peer's address. when a dial addr
  // hint is known for this peer we dial the full endpoint addr to skip the
  // discovery lookup entirely.
  const dialTarget = getPeerDialAddr(nodeId) ?? nodeId;
  return await Promise.race([
    node.open_bi(dialTarget, PLAYLISTZ_ALPN) as unknown as Promise<BiStreamLike>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("stream open timed out")), 15_000)
    ),
  ]);
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
  
  // implement the transport for sending knocks over the playlistz protocol
  const transport: KnockTransport = {
    async sendKnock(targetNodeId: string, request: KnockRequest): Promise<KnockStatusReply> {
      const stream = await openPlaylistzStream(targetNodeId);
      try {
        await sendMessage(stream, {
          v: 1,
          type: "knock",
          nodeId: identity?.node_id ?? "",
          ...(settings.name ? { name: settings.name } : {}),
          ...(request.message ? { message: request.message } : {}),
        });
        const reply = await readMessage(stream);
        if (reply?.type !== "knock_status") {
          throw new Error("peer did not answer knock");
        }
        return {
          status: reply.status,
          grantedResourceIds: reply.grantedDocIds,
        };
      } finally {
        stream.close();
      }
    },
    async checkKnockStatus(targetNodeId: string, request: KnockRequest): Promise<KnockStatusReply> {
      return this.sendKnock(targetNodeId, request);
    },
  };

  const scope: KnockScope = { kind: "browse" };
  const request: KnockRequest = {
    scope,
    message: message ?? "",
    requesterName: settings.name,
  };

  const record = await sendKnock(getKnockStore(), transport, nodeId, request);
  const docIds = record.grantedResourceIds ?? [];

  if (record.status === "accepted" && docIds.length > 0) {
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

  return { status: record.status, docIds };
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

  // implement the transport for sending knocks over the playlistz protocol
  const transport: KnockTransport = {
    async sendKnock(targetNodeId: string, request: KnockRequest): Promise<KnockStatusReply> {
      const stream = await openPlaylistzStream(targetNodeId);
      try {
        await sendMessage(stream, {
          v: 1,
          type: "knock",
          nodeId: identity?.node_id ?? "",
          ...(settings.name ? { name: settings.name } : {}),
          ...(request.message ? { message: request.message } : {}),
          knockType: "doc_access",
          docId: (request.scope as { kind: "resource"; resourceId: string }).resourceId,
        });
        const reply = await readMessage(stream);
        if (reply?.type !== "knock_status") {
          throw new Error("peer did not answer knock");
        }
        return {
          status: reply.status,
          grantedResourceIds: reply.grantedDocIds,
        };
      } finally {
        stream.close();
      }
    },
    async checkKnockStatus(targetNodeId: string, request: KnockRequest): Promise<KnockStatusReply> {
      return this.sendKnock(targetNodeId, request);
    },
  };

  const scope: KnockScope = { kind: "resource", resourceId: docId };
  const request: KnockRequest = {
    scope,
    message,
    requesterName: settings.name,
  };

  const record = await sendKnock(getKnockStore(), transport, ownerNodeId, request);

  if (record.status === "accepted") {
    const granted = record.grantedResourceIds ?? [docId];
    if (granted.includes(docId)) {
      await syncSharedDoc({
        kind: "doc",
        nodeId: ownerNodeId,
        docId,
        ...(titleHint ? { title: titleHint } : {}),
      });
    }
  }

  return { status: record.status };
}

/**
 * accept an inbound knock: persist the grant, record the peer in each
 * granted doc, and dial the peer so sync starts immediately.
 */
export async function acceptKnock(
  knockId: string,
  docIds: string[]
): Promise<void> {
  const record = await getKnockStore().getKnock(knockId);
  if (!record) throw new Error("knock not found");

  const identity = getIdentity();
  const myNodeId = identity?.node_id ?? "";

  // define the policy that haruspex will run - this is where we grant the resources
  const policy: KnockPolicy = async (): Promise<KnockPolicyResult> => {
    // persist the grant and mark the knock accepted up front, so a peer that
    // re-checks ("check if accepted") immediately after sees the grant rather
    // than racing the rest of this function.
    await upsertAccessGrant({
      nodeId: record.nodeId,
      name: inboundSenderName(record),
      grantedAt: Date.now(),
      docIds,
    });

    return {
      grantedResourceIds: docIds,
    };
  };

  // accept the knock using haruspex
  await haruspexAcceptKnock(getKnockStore(), knockId, policy, myNodeId);

  // best-effort: enrich the grant with the peer's avatar from a docIndex entry
  // if we already have one. not on the critical path for access.
  const allEntries = await getAllDocIndexEntries().catch(
    () => [] as Awaited<ReturnType<typeof getAllDocIndexEntries>>
  );
  const peerEntry = allEntries.find((e) => e.remoteNodeId === record.nodeId);
  if (peerEntry?.remoteAvatarDataUrl) {
    await upsertAccessGrant({
      nodeId: record.nodeId,
      name: inboundSenderName(record),
      grantedAt: Date.now(),
      docIds,
      avatarDataUrl: peerEntry.remoteAvatarDataUrl,
    });
  }

  for (const docId of docIds) {
    try {
      const handle = await findPlaylistDoc(docId as AutomergeUrl);
      const doc = handle.doc();
      if (doc && !(record.nodeId in (doc.peers ?? {}))) {
        handle.change((d) => addPeerToDoc(d, record.nodeId));
        await flushDoc(docId as AutomergeUrl);
      }
    } catch (err) {
      log.warn("p2p.knock", "failed to record peer in doc:", docId, err);
    }
  }

  const adapter = getIrohAdapter();
  await adapter.addPeer(record.nodeId).catch(() => {});

  // fire-and-forget: notify the peer they've been accepted so they don't
  // have to poll. if the peer is offline this fails silently.
  void (async () => {
    try {
      const stream = await openPlaylistzStream(record.nodeId);
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
  const identity = getIdentity();
  const myNodeId = identity?.node_id ?? "";
  await haruspexDenyKnock(getKnockStore(), knockId, myNodeId);
  notifyKnocksChanged();
}

/** list inbound knocks for the inbox UI (newest first). */
export async function getInboundKnocks(): Promise<PlaylistzKnockRecord[]> {
  const knocks = await getKnockStore().listAll();
  return knocks
    .filter((k) => k.direction === "inbound")
    .map(toPlaylistzKnock)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** list outbound knocks (sent by us) for the pending-access UI. */
export async function getOutboundKnocks(): Promise<PlaylistzKnockRecord[]> {
  const knocks = await getKnockStore().listAll();
  return knocks
    .filter((k) => k.direction === "outbound")
    .map(toPlaylistzKnock)
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
        ...(settings.avatarDataUrl
          ? { avatarDataUrl: settings.avatarDataUrl }
          : {}),
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
        // doc_access knock: confirm access when either the doc allows
        // collaborative editing (auto-accept) or the owner has already granted
        // this peer explicit access to the doc (e.g. accepted the knock from the
        // inbox). in public mode collaborative docs auto-accept; in knock mode the
        // peer needs a grant covering this doc.
        let isCollaborative = false;
        try {
          const handle = await findPlaylistDoc(msg.docId as AutomergeUrl);
          const doc = handle.doc() as Record<string, unknown> | undefined;
          isCollaborative = !!doc?.collaborative;
        } catch {
          /* doc not available */
        }

        const hasExplicitGrant =
          !!existing &&
          (!existing.docIds || existing.docIds.includes(msg.docId));
        const autoAccept =
          isCollaborative && (settings.mode === "public" || hasExplicitGrant);

        if (autoAccept) {
          await sendMessage(stream, {
            v: 1,
            type: "knock_status",
            status: "accepted",
            grantedDocIds: existing?.docIds ?? [msg.docId],
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

      // determine the scope for the knock record
      const scope: KnockScope = isDocAccessKnock && msg.docId
        ? { kind: "resource", resourceId: msg.docId }
        : { kind: "browse" };

      // check for a prior knock of the SAME scope from this node - browse
      // and doc_access knocks from the same peer are tracked separately.
      // findByNodeId only supports a nodeId-only lookup (deliberately, per
      // its own docs - it's a "most recent regardless of status" query),
      // so scope-matching is done here against the full inbound history.
      const priorForScope = (await getKnockStore().listAll()).find(
        (k) =>
          k.direction === "inbound" &&
          k.nodeId === msg.nodeId &&
          scopesMatch(k.scope, scope)
      );

      if (priorForScope) {
        const prior = priorForScope;
        if (prior.status === "denied") {
          await sendMessage(stream, {
            v: 1,
            type: "knock_status",
            status: "denied",
          });
          break;
        }
        if (prior.status === "accepted") {
          // the owner already approved this peer's request (e.g. accepted the
          // knock from the inbox), so confirm access on re-check.
          await sendMessage(stream, {
            v: 1,
            type: "knock_status",
            status: "accepted",
            grantedDocIds: prior.grantedResourceIds ?? (msg.docId ? [msg.docId] : []),
          });
          break;
        }
        // prior knock is pending - reply with pending status
        await sendMessage(stream, {
          v: 1,
          type: "knock_status",
          status: "pending",
        });
        break;
      }

      // no prior knock found - create a new one
      try {
        await getKnockStore().createKnock({
          nodeId: msg.nodeId,
          direction: "inbound",
          scope,
          message: msg.message ?? "",
          ...(msg.name ? { metadata: { name: msg.name } } : {}),
        });
        notifyKnocksChanged();
      } catch (err) {
        // knock already exists (dedup rule) - this can happen in a race
        // between two concurrent knock requests. just reply pending.
        log.trace("p2p.knock", "knock dedup on create:", err);
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
          log.warn(
            "p2p.knock",
            "failed to sync granted doc from notify:",
            docId,
            err
          );
        }
      }
      // mark any matching outbound knock as accepted
      const allKnocks = await getKnockStore().listAll();
      for (const k of allKnocks) {
        if (
          k.direction === "outbound" &&
          k.nodeId === peerNodeId &&
          k.status === "pending"
        ) {
          await getKnockStore().recordDecision(
            k.id,
            {
              byNodeId: peerNodeId,
              outcome: "accepted",
              at: Date.now(),
            },
            { grantedResourceIds: msg.docIds }
          );
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
  // reset knock store so it gets re-created with the test's fresh indexedDB
  knockStore = null;
}
