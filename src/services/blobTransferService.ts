// p2p blob transfer service for playlistz.
//
// docs carry sha256 hashes; bytes live in the shared blob store. when a
// blob is missing locally, this service fetches it from a doc's peers
// using iroh-blobs verified streaming:
//
//   requester                         owner
//   ---------                         -----
//   open_bi(freqhole-playlistz/1)
//   blob_request { sha256 }   ---->   getBlob(sha256) from blob store
//                                     import_blob into iroh-blobs store
//   blob_ready { blake3, size } <----
//   download_verified_streaming_with_ensure(blake3)  [iroh-blobs ALPN]
//   assemble chunks -> storeBlob
//
// staging a blob for a peer to download (the serve side's import cache
// and release timer) and downloading a blob's verified bytes once its
// blake3 + size are known (the fetch side) are both generic, blake3-native
// operations - handled by @freqhole/reliquary/transfer's BlobServer and
// snatchBlob. the sha256-keyed blob_request/blob_ready handshake that maps
// a doc's sha256 reference onto a peer's blake3 stays here: it is what
// lets a peer stage a blob it only knows by sha256 before a verified
// download can address it by blake3 at all.
import { getBlob, getBlobMetadata, storeBlob } from "./blobStore.js";
import {
  BlobServer,
  serveBlobRequest as resolveServedBlob,
  snatchBlob,
  createPrefetcher,
  type BlobCapableNode,
} from "@freqhole/reliquary/transfer";
import { createTransferProgress } from "@freqhole/reliquary/solid";
import type { Accessor } from "solid-js";
import {
  PLAYLISTZ_ALPN,
  sendMessage,
  readMessage,
  type BiStreamLike,
} from "../types/playlistz";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { getNode } from "./p2pService.js";
import { getIrohAdapter, findPlaylistDoc } from "./automergeRepo.js";
import { getIdentity } from "./p2pService.js";
import { getSongsForPlaylist } from "./playlistDocService.js";
import type { Playlist, Song } from "../types/playlist.js";

// midden node surface used here, beyond the stream interface declared in
// @freqhole/reliquary/automerge. structural cast - midden provides these.
// `on_chunk`'s buffer type is narrowed to plain ArrayBuffer (never
// SharedArrayBuffer) to match `BlobCapableNode`'s own contract - midden's
// wasm-bindgen bindings only ever hand back ArrayBuffer-backed views.
interface MiddenBlobNode {
  node_id(): string;
  open_bi(peer_addr: string, alpn: string): Promise<unknown>;
  import_blob(data: Uint8Array): Promise<string>;
  release_blob(blake3_hash: string): void;
  download_verified_streaming_with_ensure(
    peer_addr: string,
    blake3_hash: string,
    total_size: number,
    on_chunk: (chunk: Uint8Array<ArrayBuffer>, offset: number) => void,
    on_progress: (fraction: number) => void
  ): Promise<number>;
}

function getBlobNode(): MiddenBlobNode | null {
  return getNode() as unknown as MiddenBlobNode | null;
}

// a stable facade over the currently-running midden node: playlistz's node
// instance can change across a leadership handoff or restart, so every
// method here resolves the live node at call time rather than closing
// over one captured at construction. handed to BlobServer/snatchBlob,
// which are built to hold a single node reference for their lifetime.
const nodeFacade: BlobCapableNode = {
  node_id: () => getBlobNode()?.node_id() ?? "",
  import_blob: (data) => {
    const node = getBlobNode();
    if (!node) return Promise.reject(new Error("p2p node is not running"));
    return node.import_blob(data);
  },
  release_blob: (blake3) => {
    getBlobNode()?.release_blob(blake3);
  },
  download_verified_streaming_with_ensure: (
    peerAddr,
    blake3Hash,
    totalSize,
    onChunk,
    onProgress,
    downloadId
  ) => {
    const node = getBlobNode();
    if (!node) return Promise.reject(new Error("p2p node is not running"));
    void downloadId; // old midden's streaming method has no download id param
    return node.download_verified_streaming_with_ensure(
      peerAddr,
      blake3Hash,
      totalSize,
      onChunk,
      onProgress
    );
  },
};

// --- serving side ---

// import cache + release timer for blobs staged for a peer to download,
// keyed by sha256 (the id playlist docs and blob_request messages use).
const blobServer = new BlobServer(nodeFacade);

// count of in-progress outbound serve requests (we are serving a blob to a peer)
let activeServes = 0;

/**
 * answer a blob_request on an open protocol stream: import the local
 * blob into the iroh-blobs store and reply with its blake3 + size.
 * called from the sharing service's stream handler.
 */
export async function serveBlobRequest(
  stream: BiStreamLike,
  sha256: string
): Promise<void> {
  activeServes++;
  notifyTransferListeners();
  try {
    await _serveBlobRequest(stream, sha256);
  } finally {
    activeServes--;
    notifyTransferListeners();
  }
}

async function _serveBlobRequest(
  stream: BiStreamLike,
  sha256: string
): Promise<void> {
  const node = getBlobNode();
  if (!node) {
    await sendMessage(stream, {
      v: 1,
      type: "error",
      code: "no_node",
      message: "p2p node is not running",
    });
    return;
  }

  const info = await resolveServedBlob(blobServer, sha256, async (id) => {
    const blob = await getBlob(id);
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), size: blob.size };
  });

  if (!info) {
    await sendMessage(stream, {
      v: 1,
      type: "error",
      code: "blob_not_found",
      message: `no blob with sha256 ${sha256}`,
    });
    return;
  }

  await sendMessage(stream, {
    v: 1,
    type: "blob_ready",
    sha256,
    blake3: info.blake3,
    size: info.size,
  });
}

// --- per-sha download state (reactive) ---

export type BlobDownloadState = "downloading" | "pending" | "error";

// sha256 -> current download state for in-progress or failed fetches.
// absence = not currently tracked (either cached or not yet started).
const blobProgress = createTransferProgress<BlobDownloadState>();

export const blobDownloadStates: Accessor<ReadonlyMap<string, BlobDownloadState>> =
  blobProgress.states;

function setBlobState(sha256: string, state: BlobDownloadState | null): void {
  blobProgress.setState(sha256, state);
}

// clear a tracked key only while it still holds a specific state, so this
// never clobbers a different state something else already moved it to.
function clearIfState(sha256: string, state: BlobDownloadState): void {
  if (blobProgress.states().get(sha256) === state) {
    setBlobState(sha256, null);
  }
}

// --- fetching side ---

export interface BlobFetchProgress {
  sha256: string;
  fraction: number; // 0..1
}

// max concurrent outbound playlistz streams per peer. QUIC peers can reject
// streams if too many are opened simultaneously - keep this conservative.
const MAX_CONCURRENT_STREAMS_PER_PEER = 2;

// per-peer active stream count + queued waiters
const peerStreamCounts = new Map<string, number>();
const peerStreamWaiters = new Map<string, Array<() => void>>();

function acquirePeerStream(peerNodeId: string): Promise<void> {
  const count = peerStreamCounts.get(peerNodeId) ?? 0;
  if (count < MAX_CONCURRENT_STREAMS_PER_PEER) {
    peerStreamCounts.set(peerNodeId, count + 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let waiters = peerStreamWaiters.get(peerNodeId);
    if (!waiters) {
      waiters = [];
      peerStreamWaiters.set(peerNodeId, waiters);
    }
    waiters.push(resolve);
  });
}

function releasePeerStream(peerNodeId: string): void {
  const waiters = peerStreamWaiters.get(peerNodeId);
  if (waiters && waiters.length > 0) {
    const next = waiters.shift()!;
    // count stays the same - the waiter takes the slot
    next();
    return;
  }
  const count = peerStreamCounts.get(peerNodeId) ?? 1;
  peerStreamCounts.set(peerNodeId, Math.max(0, count - 1));
}

// in-flight fetches deduped by sha256
const inflight = new Map<string, Promise<string | null>>();

// timeout for individual blob fetches (configurable by dev hook)
let BLOB_FETCH_TIMEOUT_MS = 30_000;

export function _devSetBlobFetchTimeout(ms: number): void {
  BLOB_FETCH_TIMEOUT_MS = ms;
}

// --- transfer count listeners (used by sharingState for ui signals) ---

const _transferListeners = new Set<() => void>();

function notifyTransferListeners(): void {
  for (const cb of _transferListeners) {
    try {
      cb();
    } catch {
      /* ignore listener errors */
    }
  }
}

export function onTransferCountChange(cb: () => void): () => void {
  _transferListeners.add(cb);
  return () => _transferListeners.delete(cb);
}

export function getActiveTransferCount(): number {
  return inflight.size + activeServes;
}

/** returns true if the blob with the given sha256 exists in the local blob store. */
export async function isBlobCachedLocally(
  sha: string | undefined
): Promise<boolean> {
  if (!sha) return false;
  return (await getBlobMetadata(sha)) !== null;
}

/**
 * fetch a blob from a specific peer. returns the stored blobId (sha256)
 * or null on failure.
 */
async function fetchBlobFromPeer(
  peerNodeId: string,
  sha256: string,
  mimeType: string,
  onProgress?: (p: BlobFetchProgress) => void
): Promise<string | null> {
  const node = getBlobNode();
  if (!node) return null;

  let blake3: string;
  let size: number;

  // throttle concurrent streams to avoid overwhelming the QUIC connection
  await acquirePeerStream(peerNodeId);
  // ask the peer to stage the blob for verified download
  const stream = (await node.open_bi(
    peerNodeId,
    PLAYLISTZ_ALPN
  )) as BiStreamLike;
  try {
    await sendMessage(stream, { v: 1, type: "blob_request", sha256 });
    const reply = await readMessage(stream);
    if (reply?.type !== "blob_ready") {
      return null;
    }
    blake3 = reply.blake3;
    size = reply.size;
  } finally {
    stream.close();
    releasePeerStream(peerNodeId);
  }

  // the peer has staged the blob and told us its blake3 + size; the
  // actual verified download no longer needs the app-level protocol -
  // it addresses the peer directly by hash.
  const result = await snatchBlob(
    nodeFacade,
    [peerNodeId],
    { blake3, size, mime: mimeType },
    { onProgress: (fraction) => onProgress?.({ sha256, fraction }) }
  );

  const blob = new Blob([result.bytes as BlobPart], { type: mimeType });
  const storedId = await storeBlob(blob, mimeType);
  if (storedId !== sha256) {
    console.warn(
      "[blobs] stored blob hash mismatch: expected",
      sha256,
      "got",
      storedId
    );
  }
  return storedId;
}

/**
 * fetch a blob from any peer recorded in a doc's peers map.
 * tries currently-connected peers first. resolves to the blobId or null.
 * deduplicates concurrent fetches of the same sha256.
 */
export async function fetchBlobForDoc(
  docId: string,
  sha256: string,
  mimeType: string,
  onProgress?: (p: BlobFetchProgress) => void
): Promise<string | null> {
  // already local?
  if (await getBlobMetadata(sha256)) return sha256;

  const existing = inflight.get(sha256);
  if (existing) return existing;

  // dev override: bypass real p2p transport (set by dev-hooks.ts)
  if (import.meta.env.DEV && _devFetchOverride) {
    setBlobState(sha256, "downloading");
    notifyTransferListeners();
    const devTask = _devFetchOverride(sha256, mimeType, onProgress);
    const withTimeout = new Promise<string | null>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error("blob fetch timeout")),
        BLOB_FETCH_TIMEOUT_MS
      );
      devTask.finally(() => clearTimeout(t));
    });
    const task = Promise.race([devTask, withTimeout]).then(
      (r) => {
        inflight.delete(sha256);
        clearIfState(sha256, "downloading");
        notifyTransferListeners();
        return r as string | null;
      },
      (err: unknown) => {
        inflight.delete(sha256);
        setBlobState(sha256, "error");
        notifyTransferListeners();
        throw err;
      }
    );
    inflight.set(sha256, task);
    return task;
  }

  const task = (async () => {
    const myNodeId = getIdentity()?.node_id ?? "";
    let peers: string[] = [];
    try {
      const handle = await findPlaylistDoc(docId as AutomergeUrl);
      const doc = handle.doc();
      peers = Object.keys(doc?.peers ?? {}).filter((n) => n && n !== myNodeId);
    } catch {
      return null;
    }
    if (peers.length === 0) return null;

    // prefer peers with an active stream
    const adapter = getIrohAdapter();
    peers.sort((a, b) => {
      const ca = adapter.isConnected(a) ? 0 : 1;
      const cb = adapter.isConnected(b) ? 0 : 1;
      return ca - cb;
    });

    for (const peer of peers) {
      // try each peer up to 2 times with a short delay on first failure
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await fetchBlobFromPeer(
            peer,
            sha256,
            mimeType,
            onProgress
          );
          if (result) return result;
          break; // null result (peer doesn't have it) - no point retrying
        } catch (err) {
          if (attempt === 0) {
            // brief pause before retry - transient QUIC stream errors often clear
            await new Promise((r) => setTimeout(r, 500));
          } else {
            console.warn(
              "[blobs] fetch from peer failed (giving up):",
              peer.slice(0, 16),
              err
            );
          }
        }
      }
    }
    return null;
  })();

  const withTimeout = new Promise<string | null>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error("blob fetch timeout")),
      BLOB_FETCH_TIMEOUT_MS
    );
    task.finally(() => clearTimeout(t));
  });
  const racedTask = Promise.race([task, withTimeout]) as Promise<string | null>;
  inflight.set(sha256, racedTask);
  setBlobState(sha256, "downloading");
  notifyTransferListeners();
  try {
    const result = await racedTask;
    return result;
  } catch {
    setBlobState(sha256, "error");
    return null;
  } finally {
    inflight.delete(sha256);
    // clear downloading state on success (error state stays until next attempt)
    clearIfState(sha256, "downloading");
    notifyTransferListeners();
  }
}

/**
 * fetch a song's audio blob from the peers of its playlist doc.
 * song.playlistId is the docId for doc-backed songs.
 */
export async function fetchSongBlob(
  song: Song,
  onProgress?: (p: BlobFetchProgress) => void
): Promise<string | null> {
  const sha = song.sha ?? song.sha256;
  if (!sha || !song.playlistId) return null;
  return fetchBlobForDoc(
    song.playlistId,
    sha,
    song.mimeType || "audio/mpeg",
    onProgress
  );
}

// --- prefetch + save offline ---

// upcoming-playback prefetch window
const PREFETCH_WINDOW_SECONDS = 30 * 60;
const PREFETCH_CONCURRENCY = 3;

const prefetcher = createPrefetcher<Song>();

function songSha(song: Song): string | undefined {
  return song.sha ?? song.sha256;
}

/**
 * prefetch audio blobs for upcoming songs in a playlist, starting after
 * the given song, until ~30 minutes of playback are locally available.
 * currentSongRemaining: seconds left in the currently-playing song - this
 * is included in the budget so the window is always relative to now, not
 * the start of the next song.
 * fire-and-forget; a new call supersedes the previous run.
 */
export function prefetchUpcoming(
  playlist: Playlist,
  currentSongId: string,
  currentSongRemaining = 0
): void {
  void (async () => {
    const songs = await getSongsForPlaylist(playlist.id).catch(
      () => [] as Song[]
    );
    const startIdx = songs.findIndex((s) => s.id === currentSongId);
    if (startIdx === -1) return;

    prefetcher.run(songs.slice(startIdx + 1), {
      budget: PREFETCH_WINDOW_SECONDS - currentSongRemaining,
      costOf: (song) => song.duration || 0,
      concurrency: PREFETCH_CONCURRENCY,
      fetchItem: async (song) => {
        await fetchSongBlob(song);
      },
      onPending: (song) => {
        const sha = songSha(song);
        if (sha) setBlobState(sha, "pending");
      },
      onSettled: (song) => {
        const sha = songSha(song);
        if (sha) clearIfState(sha, "pending");
      },
    });
  })();
}

export interface OfflineProgress {
  done: number;
  total: number;
  currentTitle: string;
  fraction: number; // overall 0..1
}

/**
 * fetch every missing blob (audio + images) for a playlist so it can
 * play fully offline. sequential, with per-item progress callbacks.
 * returns the number of blobs fetched (0 = everything was local).
 */
export async function savePlaylistOffline(
  playlist: Playlist,
  onProgress?: (p: OfflineProgress) => void
): Promise<number> {
  const docId = playlist.id;
  const missing = await collectMissingBlobs(playlist);

  let fetched = 0;
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i]!;
    onProgress?.({
      done: i,
      total: missing.length,
      currentTitle: item.title,
      fraction: missing.length === 0 ? 1 : i / missing.length,
    });
    const result = await fetchBlobForDoc(docId, item.sha, item.mime, (p) => {
      onProgress?.({
        done: i,
        total: missing.length,
        currentTitle: item.title,
        fraction: (i + p.fraction) / missing.length,
      });
    });
    if (result) fetched++;
  }

  onProgress?.({
    done: missing.length,
    total: missing.length,
    currentTitle: "",
    fraction: 1,
  });
  return fetched;
}

/**
 * true when any blob the playlist references (audio or images) is not
 * yet in the local blob store. used to hide "save offline" once a
 * playlist is fully cached.
 */
export async function playlistHasMissingBlobs(
  playlist: Playlist
): Promise<boolean> {
  const missing = await collectMissingBlobs(playlist);
  return missing.length > 0;
}

// gather every blob a playlist references (song audio, song images,
// playlist covers), deduped, and return the subset missing locally.
// cover images come first so the playlist looks good as soon as possible.
async function collectMissingBlobs(
  playlist: Playlist
): Promise<{ sha: string; mime: string; title: string }[]> {
  const docId = playlist.id;
  const coverItems: { sha: string; mime: string; title: string }[] = [];
  const audioItems: { sha: string; mime: string; title: string }[] = [];
  const imageItems: { sha: string; mime: string; title: string }[] = [];

  const songs = await getSongsForPlaylist(docId).catch(() => [] as Song[]);
  for (const song of songs) {
    const sha = song.sha ?? song.sha256;
    if (sha) {
      audioItems.push({
        sha,
        mime: song.mimeType || "audio/mpeg",
        title: song.title,
      });
    }
    for (const img of song.images ?? []) {
      if (img.blobId) {
        imageItems.push({
          sha: img.blobId,
          mime: "image/jpeg",
          title: `${song.title} (image)`,
        });
      }
    }
  }

  // playlist cover images - fetched before song audio for fast visual loading
  try {
    const handle = await findPlaylistDoc(docId as AutomergeUrl);
    const doc = handle.doc();
    for (const img of doc?.images ?? []) {
      if (img.blobId) {
        coverItems.push({
          sha: img.blobId,
          mime: "image/jpeg",
          title: "playlist cover",
        });
      }
    }
  } catch {
    // doc unavailable - song list already covers most blobs
  }

  // dedupe: covers → song images → audio
  const wanted = [...coverItems, ...imageItems, ...audioItems];
  const seen = new Set<string>();
  const missing: typeof wanted = [];
  for (const item of wanted) {
    if (seen.has(item.sha)) continue;
    seen.add(item.sha);
    if (!(await getBlobMetadata(item.sha))) {
      missing.push(item);
    }
  }
  return missing;
}

/** reset module state. for use in tests only. */
export function _resetBlobTransferForTests(): void {
  blobServer.dispose();
  inflight.clear();
  blobProgress.reset();
  prefetcher.run([], { budget: 0, costOf: () => 0, fetchItem: async () => {} });
  _devFetchOverride = null;
  BLOB_FETCH_TIMEOUT_MS = 30_000;
}

// --- dev hook slot (implementation lives in src/dev-hooks.ts) ---

// override function for fetchBlobForDoc - set by dev-hooks.ts in DEV builds only.
// checked under `import.meta.env.DEV` so the branch is eliminated in production.
let _devFetchOverride:
  | ((
      sha256: string,
      mimeType: string,
      onProgress?: (p: BlobFetchProgress) => void
    ) => Promise<string | null>)
  | null = null;

// set the fetch override (called from dev-hooks.ts)
export function _devSetFetchOverride(fn: typeof _devFetchOverride): void {
  _devFetchOverride = fn;
}

// evict a blob from local store - for simulating cache misses in tests
export async function _devEvictBlob(sha256: string): Promise<void> {
  const { deleteBlob } = await import("./blobStore.js");
  await deleteBlob(sha256).catch(() => {});
}

// fetch a blob directly by sha256 - used in tests to trigger retry without a UI click.
// passes an empty docId because mock overrides don't use it.
export async function _devFetchBlobBySha(
  sha256: string
): Promise<string | null> {
  return fetchBlobForDoc("", sha256, "audio/wav");
}
