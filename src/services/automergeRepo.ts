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
import { IrohNetworkAdapter } from "freqhole-api-client/automerge";
import {
  parsePlaylistDoc,
  emptyPlaylistDoc,
  tombstone,
  type PlaylistDoc,
} from "freqhole-api-client/playlistz";
import { getAdapterOptions } from "./p2pService.js";

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
  if (_sharePolicyCalls % 100 === 1) {
    console.log("[trace] sharePolicy call #", _sharePolicyCalls, peerId, documentId);
  }
  if (!documentId) return false;
  const entry = docPeerCache.get(documentId);
  if (!entry) return false;
  return entry.peers.has(peerId) || entry.acl.has(peerId);
}

let _repo: Repo | null = null;

function buildRepo(): Repo {
  console.log("[trace] buildRepo: constructing adapters");
  const storage = new IndexedDBStorageAdapter("freqhole-automerge");
  const broadcastAdapter = new BroadcastChannelNetworkAdapter();
  const irohAdapter = new IrohNetworkAdapter(getAdapterOptions());

  console.log("[trace] buildRepo: constructing Repo");
  const repo = new Repo({
    storage,
    network: [broadcastAdapter, irohAdapter],
    sharePolicy,
  });
  console.log("[trace] buildRepo: done");
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
  console.log("[trace] watchHandle call #", _watchHandleCalls, documentId);
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
      console.log("[trace] doc change event (watchHandle)", documentId);
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
  console.log("[trace] createPlaylistDoc: getRepo");
  const repo = getRepo();
  const seed = emptyPlaylistDoc(initial);
  console.log("[trace] createPlaylistDoc: repo.create");
  const handle = repo.create<PlaylistDoc>(seed);
  console.log("[trace] createPlaylistDoc: created", handle.url);
  const { documentId } = parseAutomergeUrl(handle.url);
  watchHandle(handle, documentId);
  return { docId: handle.url, handle };
}

// find an existing playlist doc by its AutomergeUrl, waiting for the handle
// to reach a ready (or terminal) state before returning.
let _findCalls = 0;
export async function findPlaylistDoc(
  docId: AutomergeUrl
): Promise<DocHandle<PlaylistDoc>> {
  _findCalls++;
  console.log("[trace] findPlaylistDoc call #", _findCalls, docId);
  const repo = getRepo();
  const handle = await repo.find<PlaylistDoc>(docId);
  console.log("[trace] findPlaylistDoc: resolved", docId);
  const { documentId } = parseAutomergeUrl(handle.url);
  watchHandle(handle, documentId);
  return handle;
}

// tombstone the doc (sets deleted: true) then remove it from local storage.
export async function deletePlaylistDoc(docId: AutomergeUrl): Promise<void> {
  const repo = getRepo();
  const handle = await repo.find<PlaylistDoc>(docId);
  handle.change((doc) => tombstone(doc));
  const { documentId } = parseAutomergeUrl(docId);
  docPeerCache.delete(documentId);
  repo.delete(docId);
}

// reset all singleton state. for use in tests only.
export function _resetRepoForTests(): void {
  _repo = null;
  docPeerCache.clear();
  watchedDocs.clear();
}

// expose the share policy for unit testing.
export async function _testSharePolicy(
  peerId: PeerId,
  documentId: DocumentId
): Promise<boolean> {
  return sharePolicy(peerId, documentId);
}
