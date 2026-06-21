// p2p blob transfer for playlistz (phase 6).
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
//   download_verified_streaming(blake3)  [iroh-blobs ALPN, rust-side]
//   assemble chunks -> storeBlob
//
// the serving side keeps an import cache with a release timer so repeat
// requests skip the bao recomputation and memory is bounded.

import {
  getBlob,
  getBlobMetadata,
  storeBlob,
} from "@freqhole/api-client/storage";
import { createSignal } from "solid-js";
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
// freqhole-api-client/automerge. structural cast - midden provides these.
interface BlobCapableNode {
  node_id(): string;
  open_bi(peer_addr: string, alpn: string): Promise<unknown>;
  import_blob(data: Uint8Array): Promise<string>;
  release_blob(blake3_hash: string): void;
  download_verified_streaming(
    peer_addr: string,
    blake3_hash: string,
    total_size: number,
    on_chunk: (chunk: Uint8Array, offset: number) => void,
    on_progress: (fraction: number) => void
  ): Promise<number>;
}

function getBlobNode(): BlobCapableNode | null {
  return getNode() as unknown as BlobCapableNode | null;
}

// --- serving side ---

// sha256 -> blake3 for blobs currently imported into the iroh-blobs store
const servedBlobs = new Map<
  string,
  { blake3: string; releaseTimer: ReturnType<typeof setTimeout> }
>();

// how long an imported blob stays available after the last request
const RELEASE_AFTER_MS = 10 * 60 * 1000;

// count of in-progress outbound serve requests (we are serving a blob to a peer)
let activeServes = 0;

function scheduleRelease(sha256: string, blake3: string): void {
  const existing = servedBlobs.get(sha256);
  if (existing) {
    clearTimeout(existing.releaseTimer);
  }
  const releaseTimer = setTimeout(() => {
    servedBlobs.delete(sha256);
    try {
      getBlobNode()?.release_blob(blake3);
    } catch {
      // node may be gone
    }
  }, RELEASE_AFTER_MS);
  servedBlobs.set(sha256, { blake3, releaseTimer });
}

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

  const blob = await getBlob(sha256);
  if (!blob) {
    await sendMessage(stream, {
      v: 1,
      type: "error",
      code: "blob_not_found",
      message: `no blob with sha256 ${sha256}`,
    });
    return;
  }

  let blake3 = servedBlobs.get(sha256)?.blake3;
  if (!blake3) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    blake3 = await node.import_blob(bytes);
  }
  scheduleRelease(sha256, blake3);

  await sendMessage(stream, {
    v: 1,
    type: "blob_ready",
    sha256,
    blake3,
    size: blob.size,
  });
}

// --- per-sha download state (reactive) ---

export type BlobDownloadState = "downloading" | "pending" | "error";

// sha256 -> current download state for in-progress or failed fetches.
// absence = not currently tracked (either cached or not yet started).
const [_blobDownloadStates, _setBlobDownloadStates] = createSignal<
  ReadonlyMap<string, BlobDownloadState>
>(new Map(), { equals: false });

export const blobDownloadStates = _blobDownloadStates;

function setBlobState(sha256: string, state: BlobDownloadState | null): void {
  _setBlobDownloadStates((prev) => {
    const next = new Map(prev);
    if (state === null) next.delete(sha256);
    else next.set(sha256, state);
    return next;
  });
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
    try { cb(); } catch { /* ignore listener errors */ }
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

  // verified streaming download over the iroh-blobs ALPN
  const parts: Uint8Array[] = [];
  await node.download_verified_streaming(
    peerNodeId,
    blake3,
    size,
    (chunk) => {
      // copy: the wasm-side buffer may be reused
      parts.push(chunk.slice());
    },
    (fraction) => {
      onProgress?.({ sha256, fraction });
    }
  );

  const blob = new Blob(parts as BlobPart[], { type: mimeType });
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
      const t = setTimeout(() => reject(new Error("blob fetch timeout")), BLOB_FETCH_TIMEOUT_MS);
      devTask.finally(() => clearTimeout(t));
    });
    const task = Promise.race([devTask, withTimeout]).then(
      (r) => {
        inflight.delete(sha256);
        _setBlobDownloadStates((prev) => {
          if (prev.get(sha256) === "downloading") {
            const next = new Map(prev);
            next.delete(sha256);
            return next;
          }
          return prev;
        });
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
      peers = Object.keys(doc?.peers ?? {}).filter(
        (n) => n && n !== myNodeId
      );
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
    const t = setTimeout(() => reject(new Error("blob fetch timeout")), BLOB_FETCH_TIMEOUT_MS);
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
    _setBlobDownloadStates((prev) => {
      if (prev.get(sha256) === "downloading") {
        const next = new Map(prev);
        next.delete(sha256);
        return next;
      }
      return prev;
    });
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

let prefetchRun = 0;

/**
 * prefetch audio blobs for upcoming songs in a playlist, starting after
 * the given song, until ~30 minutes of playback are locally available.
 * currentSongRemaining: seconds left in the currently-playing song - this
 * is included in the budget so the window is always relative to now, not
 * the start of the next song.
 * fire-and-forget; a new call cancels the previous run.
 */
export function prefetchUpcoming(playlist: Playlist, currentSongId: string, currentSongRemaining = 0): void {
  const run = ++prefetchRun;
  void (async () => {
    const songs = await getSongsForPlaylist(playlist.id).catch(
      () => [] as Song[]
    );
    const startIdx = songs.findIndex((s) => s.id === currentSongId);
    if (startIdx === -1) return;

    // collect songs within the budget window that need fetching
    let budget = PREFETCH_WINDOW_SECONDS - currentSongRemaining;
    const toFetch: Song[] = [];
    const pendingShas: string[] = [];

    const clearPending = () => {
      for (const sha of pendingShas) {
        _setBlobDownloadStates((prev) => {
          if (prev.get(sha) === "pending") {
            const next = new Map(prev);
            next.delete(sha);
            return next;
          }
          return prev;
        });
      }
    };

    for (let i = startIdx + 1; i < songs.length && budget > 0; i++) {
      if (run !== prefetchRun) {
        clearPending();
        return;
      }
      const song = songs[i]!;
      budget -= song.duration || 0;
      const sha = song.sha ?? song.sha256;
      if (!sha) continue;
      if (await getBlobMetadata(sha)) continue; // already local
      setBlobState(sha, "pending");
      pendingShas.push(sha);
      toFetch.push(song);
    }

    // fetch in concurrent batches
    for (let i = 0; i < toFetch.length; i += PREFETCH_CONCURRENCY) {
      if (run !== prefetchRun) {
        clearPending();
        return;
      }
      const batch = toFetch.slice(i, i + PREFETCH_CONCURRENCY);
      await Promise.allSettled(batch.map((s) => fetchSongBlob(s)));
    }

    // clear any remaining pending states after normal completion
    clearPending();
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
  for (const { releaseTimer } of servedBlobs.values()) {
    clearTimeout(releaseTimer);
  }
  servedBlobs.clear();
  inflight.clear();
  _setBlobDownloadStates(new Map());
  prefetchRun++;
  _devFetchOverride = null;
  BLOB_FETCH_TIMEOUT_MS = 30_000;
}

// --- dev hook slot (implementation lives in src/dev-hooks.ts) ---

// override function for fetchBlobForDoc - set by dev-hooks.ts in DEV builds only.
// checked under `import.meta.env.DEV` so the branch is eliminated in production.
let _devFetchOverride: (
  | ((
      sha256: string,
      mimeType: string,
      onProgress?: (p: BlobFetchProgress) => void
    ) => Promise<string | null>)
  | null
) = null;

// set the fetch override (called from dev-hooks.ts)
export function _devSetFetchOverride(
  fn: typeof _devFetchOverride
): void {
  _devFetchOverride = fn;
}

// evict a blob from local store - for simulating cache misses in tests
export async function _devEvictBlob(sha256: string): Promise<void> {
  const { deleteBlob } = await import("@freqhole/api-client/storage");
  await deleteBlob(sha256).catch(() => {});
}

// fetch a blob directly by sha256 - used in tests to trigger retry without a UI click.
// passes an empty docId because mock overrides don't use it.
export async function _devFetchBlobBySha(sha256: string): Promise<string | null> {
  return fetchBlobForDoc("", sha256, "audio/wav");
}
