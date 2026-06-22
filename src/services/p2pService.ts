// p2p bootstrap service for playlistz.
//
// wires identity resolution (from freqhole-api-client/storage) with midden
// node lifecycle and web locks leader election.
//
// nothing wasm-related runs at import time. call startP2P() explicitly.

import { openDB } from "idb";
import {
  resolveIdentity,
  persistIdentity,
  acquireNodeLeadership,
  type P2PIdentity,
  type IdentityStore,
} from "@freqhole/api-client/storage";
import { AUTOMERGE_ALPN, PLAYLISTZ_ALPN } from "../types/playlistz";
import type {
  MiddenStreamNode,
  IrohNetworkAdapterOptions,
} from "@freqhole/api-client/automerge";

// --- local settings db for identity fallback ---

const SETTINGS_DB_NAME = "freqhole-playlistz-settings";
const SETTINGS_STORE = "settings";
const IDENTITY_KEY = "p2p_identity";

function createLocalStore(): IdentityStore {
  let db: Awaited<ReturnType<typeof openDB>> | null = null;

  async function getDb(): Promise<Awaited<ReturnType<typeof openDB>>> {
    if (!db) {
      db = await openDB(SETTINGS_DB_NAME, 1, {
        upgrade(database) {
          if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
            database.createObjectStore(SETTINGS_STORE);
          }
        },
      });
    }
    return db;
  }

  return {
    async get(): Promise<P2PIdentity | null> {
      const database = await getDb();
      const result = await database.get(SETTINGS_STORE, IDENTITY_KEY);
      return (result as P2PIdentity) ?? null;
    },
    async set(identity: P2PIdentity): Promise<void> {
      const database = await getDb();
      await database.put(SETTINGS_STORE, identity, IDENTITY_KEY);
    },
  };
}

// --- module-level singleton state ---

let _localStore: IdentityStore | null = null;

function getLocalStore(): IdentityStore {
  if (!_localStore) {
    _localStore = createLocalStore();
  }
  return _localStore;
}

let currentIdentity: P2PIdentity | null = null;
let currentNode: MiddenStreamNode | null = null;
let currentNodeAddr: string | null = null;
let leaderState = false;
let started = false;
let cancelLeadership: (() => void) | null = null;

// optional per-peer dial address hints keyed by node id. a hint is the full
// serialized endpoint addr (node id + relay url) which lets a dial skip
// discovery (pkarr/dns) lookup. empty in normal operation; only populated by
// callers that already know a peer's reachable addr (e.g. tests via dev hooks).
const peerDialAddrHints = new Map<string, string>();

// leadership phase: "unknown" until the lock request settles, then
// "leader" / "waiting" / "unsupported". used by waitForNode to short-circuit
// in tabs that will never hold the node
let leadershipPhase: "unknown" | "leader" | "waiting" | "unsupported" =
  "unknown";

// resolved when the local node comes up (or definitively won't)
const nodeWaiters = new Set<(node: MiddenStreamNode | null) => void>();

function flushNodeWaiters(node: MiddenStreamNode | null): void {
  for (const resolve of nodeWaiters) resolve(node);
  nodeWaiters.clear();
}

const identityListeners = new Set<(identity: P2PIdentity | null) => void>();
const leadershipListeners = new Set<(isLeader: boolean) => void>();

function notifyIdentityListeners(): void {
  for (const cb of identityListeners) {
    try {
      cb(currentIdentity);
    } catch {
      // ignore listener errors
    }
  }
}

function notifyLeadershipListeners(): void {
  for (const cb of leadershipListeners) {
    try {
      cb(leaderState);
    } catch {
      // ignore listener errors
    }
  }
}

// --- internal helpers ---

async function resolveOrCreateIdentity(): Promise<P2PIdentity> {
  const existing = await resolveIdentity(getLocalStore());
  if (existing) return existing;

  // no identity found anywhere - generate a new one.
  // node_id is filled in with the real iroh public key after midden boots.
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);
  const newIdentity: P2PIdentity = {
    id: "p2p_identity",
    secret_key: secretKey,
    node_id: "",
    created_at: Date.now(),
  };

  await persistIdentity(newIdentity, getLocalStore());
  return newIdentity;
}

async function bootMidden(
  secretKey: Uint8Array
): Promise<MiddenStreamNode | null> {
  try {
    // bundler target: wasm init happens at import time via vite-plugin-wasm.
    const midden = await import("@freqhole/midden");
    const node = await midden.MiddenNode.create_with_alpns(secretKey, [
      AUTOMERGE_ALPN,
      PLAYLISTZ_ALPN,
    ]);
    return node as unknown as MiddenStreamNode;
  } catch (err) {
    console.warn("[p2p] midden boot failed - p2p unavailable:", err);
    return null;
  }
}

// --- public api ---

/**
 * start the p2p subsystem.
 * resolves identity, acquires leadership, and boots the midden node if leader.
 * safe to call multiple times - no-ops if already started.
 */
export async function startP2P(): Promise<void> {
  if (started) return;
  started = true;

  try {
    currentIdentity = await resolveOrCreateIdentity();
    notifyIdentityListeners();
  } catch (err) {
    console.warn("[p2p] identity resolution failed:", err);
    started = false;
    return;
  }

  const identityAtStart = currentIdentity;

  cancelLeadership = acquireNodeLeadership({
    onAcquired: async () => {
      leaderState = true;
      leadershipPhase = "leader";
      notifyLeadershipListeners();

      const node = await bootMidden(identityAtStart.secret_key);
      if (node) {
        // expose the node BEFORE notifying listeners - the iroh adapter's
        // identity listener calls getNode() and would otherwise throw
        currentNode = node;
        // capture our own reachable addr (node id + relay url) so peers we
        // hand a share link to can dial us deterministically when available.
        try {
          currentNodeAddr = node.node_addr?.() ?? null;
        } catch {
          currentNodeAddr = null;
        }

        // update node_id from the real iroh public key
        const realNodeId = node.node_id();
        if (realNodeId !== identityAtStart.node_id) {
          currentIdentity = { ...identityAtStart, node_id: realNodeId };
          try {
            await persistIdentity(currentIdentity, getLocalStore());
          } catch {
            // non-fatal: node_id update will be retried on next boot
          }
        }
        // always notify: listeners subscribed before leadership was acquired
        // need to learn the node is now available
        notifyIdentityListeners();
      }
      flushNodeWaiters(node);
    },
    onStateChange: (state) => {
      if (state === "waiting") {
        leadershipPhase = "waiting";
        // another tab holds the node - local waiters resolve null
        flushNodeWaiters(null);
      } else if (state === "unsupported") {
        leadershipPhase = "unsupported";
      }
      if (state !== "leader" && leaderState) {
        leaderState = false;
        notifyLeadershipListeners();
      }
    },
  });
}

/**
 * stop p2p: release the leadership lock and clear the node reference.
 */
export function stopP2P(): void {
  started = false;
  cancelLeadership?.();
  cancelLeadership = null;
  currentNode = null;
  currentNodeAddr = null;
  if (leaderState) {
    leaderState = false;
    notifyLeadershipListeners();
  }
}

/** get the running midden node, or null if not leader or not yet started. */
export function getNode(): MiddenStreamNode | null {
  return currentNode;
}

/**
 * get this node's full serialized endpoint addr (node id + relay url), or null
 * if the node is not up or the binding does not expose it.
 */
export function getNodeAddr(): string | null {
  return currentNodeAddr;
}

/**
 * seed a dial address hint for a peer. the hint is the full serialized
 * endpoint addr; dials keyed by this node id can then skip discovery. used by
 * tests (via dev hooks) to make peer connections deterministic. no-op effect
 * on production share links, which only carry node ids.
 */
export function seedPeerAddr(nodeId: string, addr: string): void {
  if (!nodeId || !addr) return;
  peerDialAddrHints.set(nodeId, addr);
}

/** get a previously seeded dial address hint for a peer, if any. */
export function getPeerDialAddr(nodeId: string): string | undefined {
  return peerDialAddrHints.get(nodeId);
}

/**
 * wait for the local midden node to come up after startP2P.
 * resolves with the node once booted, or null when this tab is not the
 * leader (another tab holds the node), p2p was never started, or the
 * timeout elapses.
 */
export function waitForNode(
  timeoutMs = 30000
): Promise<MiddenStreamNode | null> {
  if (currentNode) return Promise.resolve(currentNode);
  if (!started || leadershipPhase === "waiting") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      nodeWaiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
    const waiter = (node: MiddenStreamNode | null) => {
      clearTimeout(timer);
      resolve(node);
    };
    nodeWaiters.add(waiter);
  });
}

/** get the current resolved identity, or null if not yet resolved. */
export function getIdentity(): P2PIdentity | null {
  return currentIdentity;
}

/**
 * check whether an identity is already persisted (without creating one).
 * used to auto-resume p2p on boot only for users who have enabled it.
 */
export async function hasExistingIdentity(): Promise<boolean> {
  try {
    const existing = await resolveIdentity(getLocalStore());
    return existing !== null;
  } catch {
    return false;
  }
}

/** returns true if this tab holds the iroh node leadership lock. */
export function isLeader(): boolean {
  return leaderState;
}

/**
 * subscribe to leadership state changes.
 * calls cb immediately with current state. returns an unsubscribe function.
 */
export function onLeadershipChange(
  cb: (isLeader: boolean) => void
): () => void {
  leadershipListeners.add(cb);
  cb(leaderState);
  return () => {
    leadershipListeners.delete(cb);
  };
}

/**
 * subscribe to identity changes. returns an unsubscribe function.
 * the signature satisfies IrohNetworkAdapterOptions.onIdentityChange.
 */
export function onIdentityChange(
  cb: (identity: P2PIdentity | null) => void
): () => void {
  identityListeners.add(cb);
  return () => {
    identityListeners.delete(cb);
  };
}

/**
 * returns options suitable for constructing an IrohNetworkAdapter.
 * pass directly to new IrohNetworkAdapter(getAdapterOptions()).
 */
export function getAdapterOptions(): IrohNetworkAdapterOptions {
  return {
    getNode: async () => {
      if (!currentNode) {
        throw new Error(
          "p2p: midden node is not available (not leader or not started)"
        );
      }
      return currentNode;
    },
    getIdentity: async () => currentIdentity,
    onIdentityChange: (cb) => onIdentityChange(cb),
    syncAlpn: AUTOMERGE_ALPN,
  };
}

/**
 * reset all module state. for use in tests only.
 */
export function _resetForTests(): void {
  started = false;
  currentIdentity = null;
  currentNode = null;
  leaderState = false;
  leadershipPhase = "unknown";
  cancelLeadership = null;
  _localStore = null;
  identityListeners.clear();
  leadershipListeners.clear();
  nodeWaiters.clear();
}
