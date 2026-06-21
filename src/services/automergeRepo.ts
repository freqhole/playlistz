// automerge-repo singleton for playlistz.
//
// wires together:
//   - IndexedDBStorageAdapter ("freqhole-automerge" db)
//   - BroadcastChannelNetworkAdapter (cross-tab sync)
//   - IrohNetworkAdapter (p2p via midden; defers until identity is available)
//
// all playlist docs live in this single repo instance. the repo is lazily
// constructed on first call to getRepo().

import {
  Repo,
  parseAutomergeUrl,
  type DocHandle,
  type AutomergeUrl,
  type PeerId,
  type DocumentId,
} from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IrohNetworkAdapter } from "@freqhole/api-client/automerge";
import {
  parsePlaylistDoc,
  emptyPlaylistDoc,
  tombstone,
  type PlaylistDoc,
} from "../types/playlistz";
import { getAdapterOptions } from "./p2pService.js";
import { log } from "../utils/log.js";

// per-doc peer registry used by sharePolicy to avoid a round-trip through
// repo.find(). keyed by DocumentId (the base58 part of the AutomergeUrl).
// updated whenever a doc is created, found, or receives a change event.
const docPeerCache = new Map<
  DocumentId,
  { peers: Set<string>; acl: Set<string> }
>();

function updateCacheFromDoc(documentId: DocumentId, rawDoc: unknown): void {
  const doc = parsePlaylistDoc(rawDoc);
  docPeerCache.set(documentId, {
    peers: new Set(Object.keys(doc.peers)),
    acl: new Set(Object.keys(doc.acl ?? {})),
  });
}

// share policy: only announce a doc to a peer recorded in that doc's
// peers map or acl. docs not in the cache (unknown to this instance) are
// not announced. this matches the plan's access model - the doc id is an
// unguessable bearer capability; unsolicited announcement is off by default.
let _sharePolicyCalls = 0;
async function sharePolicy(
  peerId: PeerId,
  documentId?: DocumentId
): Promise<boolean> {
  _sharePolicyCalls++;
  if (!documentId) return false;
  const entry = docPeerCache.get(documentId);
  if (!entry) return false;
  return entry.peers.has(peerId) || entry.acl.has(peerId);
}

let _repo: Repo | null = null;
let _irohAdapter: IrohNetworkAdapter | null = null;

function buildRepo(): Repo {
  log.trace("automerge.repo", "buildRepo: constructing");
  const storage = new IndexedDBStorageAdapter("freqhole-automerge");
  const broadcastAdapter = new BroadcastChannelNetworkAdapter();
  const irohAdapter = new IrohNetworkAdapter(getAdapterOptions());
  _irohAdapter = irohAdapter;

  const repo = new Repo({
    storage,
    network: [broadcastAdapter, irohAdapter],
    sharePolicy,
  });
  return repo;
}

// returns the lazily-constructed repo singleton.
// subsequent calls return the same instance.
export function getRepo(): Repo {
  if (!_repo) {
    _repo = buildRepo();
  }
  return _repo;
}

// returns the iroh network adapter wired into the repo. constructing the
// repo if needed. used by sharing/blob services for addPeer, alpn handlers
// and connection state.
export function getIrohAdapter(): IrohNetworkAdapter {
  if (!_irohAdapter) {
    getRepo();
  }
  return _irohAdapter!;
}

// attach a change listener that keeps the peer cache current for a handle.
// also seeds the cache from whatever the handle has now (if ready).
// documentIds that already have a change listener attached via watchHandle.
// prevents unbounded listener growth when findPlaylistDoc is called repeatedly.
const watchedDocs = new Set<DocumentId>();

let _watchHandleCalls = 0;
function watchHandle(
  handle: DocHandle<PlaylistDoc>,
  documentId: DocumentId
): void {
  _watchHandleCalls++;
  let rawDoc: unknown;
  try {
    rawDoc = handle.doc();
  } catch {
    rawDoc = undefined;
  }
  if (rawDoc !== undefined) {
    updateCacheFromDoc(documentId, rawDoc);
  }
  if (!watchedDocs.has(documentId)) {
    watchedDocs.add(documentId);
    handle.on("change", ({ doc }) => {
      log.trace("automerge.repo", "doc change event", documentId);
      updateCacheFromDoc(documentId, doc);
    });
  }
}

// create a new playlist doc seeded with emptyPlaylistDoc + optional overrides.
// returns the AutomergeUrl (docId) and the DocHandle synchronously.
export function createPlaylistDoc(initial?: Partial<PlaylistDoc>): {
  docId: AutomergeUrl;
  handle: DocHandle<PlaylistDoc>;
} {
  const repo = getRepo();
  const seed = emptyPlaylistDoc(initial);
  const handle = repo.create<PlaylistDoc>(seed);
  log.trace("automerge.repo", "createPlaylistDoc:", handle.url);
  const { documentId } = parseAutomergeUrl(handle.url);
  watchHandle(handle, documentId);
  return { docId: handle.url, handle };
}

// pre-authorize a peer for a doc we don't have yet. seeds the peer cache
// so sharePolicy lets us request the doc from (and sync it with) that peer
// before the doc has arrived locally. without this, opening a share link
// dead-ends: the policy only trusts peers recorded in the doc, but the doc
// can't arrive until the policy trusts the peer.
export function authorizePeerForDoc(docId: AutomergeUrl, nodeId: string): void {
  const { documentId } = parseAutomergeUrl(docId);
  const entry = docPeerCache.get(documentId) ?? {
    peers: new Set<string>(),
    acl: new Set<string>(),
  };
  entry.peers.add(nodeId);
  docPeerCache.set(documentId, entry);
}

// per-docId promise cache so repeated calls for the same doc share one
// repo.find() call and one watchHandle setup. the cache holds a promise
// (not a resolved handle) so concurrent first-callers coalesce correctly.
const _handleCache = new Map<AutomergeUrl, Promise<DocHandle<PlaylistDoc>>>();

// find an existing playlist doc by its AutomergeUrl, waiting for the handle
// to reach a ready (or terminal) state before returning.
// cached: subsequent calls for the same docId return the same promise.
let _findCalls = 0;
export async function findPlaylistDoc(
  docId: AutomergeUrl
): Promise<DocHandle<PlaylistDoc>> {
  const cached = _handleCache.get(docId);
  if (cached) return cached;

  _findCalls++;
  log.trace("automerge.repo", "findPlaylistDoc call #", String(_findCalls), docId);

  const promise = (async () => {
    const repo = getRepo();
    const handle = await repo.find<PlaylistDoc>(docId);
    log.trace("automerge.repo", "findPlaylistDoc resolved", docId);
    const { documentId } = parseAutomergeUrl(handle.url);
    watchHandle(handle, documentId);
    return handle;
  })();

  _handleCache.set(docId, promise);
  return promise;
}

// tombstone the doc (sets deleted: true) then remove it from local storage.
export async function deletePlaylistDoc(docId: AutomergeUrl): Promise<void> {
  _handleCache.delete(docId);
  const repo = getRepo();
  const handle = await repo.find<PlaylistDoc>(docId);
  handle.change((doc) => tombstone(doc));
  const { documentId } = parseAutomergeUrl(docId);
  docPeerCache.delete(documentId);
  repo.delete(docId);
}

// flush a doc's pending changes to indexeddb. the repo debounces storage
// writes, so without this a reload (or tab close) shortly after a mutation
// can lose data.
export async function flushDoc(docId: AutomergeUrl): Promise<void> {
  const repo = getRepo();
  const { documentId } = parseAutomergeUrl(docId);
  await repo.flush([documentId]);
}

// reset all singleton state. for use in tests only.
export function _resetRepoForTests(): void {
  _repo = null;
  _irohAdapter = null;
  docPeerCache.clear();
  watchedDocs.clear();
  _handleCache.clear();
}

// expose the share policy for unit testing.
export async function _testSharePolicy(
  peerId: PeerId,
  documentId: DocumentId
): Promise<boolean> {
  return sharePolicy(peerId, documentId);
}
