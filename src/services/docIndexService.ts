// crud helpers for the automerge doc layer stores:
// docIndex, knocks, and accessGrants.
//
// all three stores live in musicPlaylistDB (same db as the rest of the app).
// docIndex entries are broadcast-invalidated for cross-tab reactivity;
// knocks and accessGrants are lower-traffic and not live-queried from here.

import {
  setupDB,
  DB_NAME,
  DOC_INDEX_STORE,
  KNOCKS_STORE,
  ACCESS_GRANTS_STORE,
} from "./indexedDBService.js";
import type {
  DocIndexEntry,
  KnockRecord,
  AccessGrantRecord,
} from "./indexedDBService.js";
import { log } from "../utils/log.js";

// event name for same-page doc index invalidation.
// used alongside BroadcastChannel so file:// (null origin) still works.
const DOC_INDEX_CHANGE_EVENT = "playlistz:docindex-changed";

// broadcast a docIndex mutation so same-tab queries and other tabs refresh.
function broadcastDocIndexChange(): void {
  log.trace("idb.docindex", "broadcast mutation");
  // CustomEvent works in any origin including file:// (null)
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DOC_INDEX_CHANGE_EVENT));
  }
  try {
    const bc = new BroadcastChannel(`${DB_NAME}-changes`);
    bc.postMessage({ type: "mutation", store: DOC_INDEX_STORE });
    bc.close();
  } catch {
    // broadcastchannel unavailable in some environments (workers, tests)
  }
}

export { DOC_INDEX_CHANGE_EVENT };

// --- docIndex ---

export async function addDocIndexEntry(entry: DocIndexEntry): Promise<void> {
  log.trace("idb.docindex", "addEntry", entry.docId);
  const db = await setupDB();
  await db.put(DOC_INDEX_STORE, entry);
  broadcastDocIndexChange();
}

export async function removeDocIndexEntry(docId: string): Promise<void> {
  log.trace("idb.docindex", "removeEntry", docId);
  const db = await setupDB();
  await db.delete(DOC_INDEX_STORE, docId);
  broadcastDocIndexChange();
}

export async function getDocIndexEntry(
  docId: string
): Promise<DocIndexEntry | undefined> {
  const db = await setupDB();
  return db.get(DOC_INDEX_STORE, docId);
}

export async function getAllDocIndexEntries(): Promise<DocIndexEntry[]> {
  const db = await setupDB();
  return db.getAll(DOC_INDEX_STORE);
}

// --- knocks ---

export async function upsertKnock(knock: KnockRecord): Promise<void> {
  const db = await setupDB();
  await db.put(KNOCKS_STORE, knock);
}

export async function getKnock(id: string): Promise<KnockRecord | undefined> {
  const db = await setupDB();
  return db.get(KNOCKS_STORE, id);
}

export async function getAllKnocks(): Promise<KnockRecord[]> {
  const db = await setupDB();
  return db.getAll(KNOCKS_STORE);
}

export async function deleteKnock(id: string): Promise<void> {
  const db = await setupDB();
  await db.delete(KNOCKS_STORE, id);
}

// --- accessGrants ---

export async function upsertAccessGrant(
  grant: AccessGrantRecord
): Promise<void> {
  const db = await setupDB();
  await db.put(ACCESS_GRANTS_STORE, grant);
}

export async function getAccessGrant(
  nodeId: string
): Promise<AccessGrantRecord | undefined> {
  const db = await setupDB();
  return db.get(ACCESS_GRANTS_STORE, nodeId);
}

export async function getAllAccessGrants(): Promise<AccessGrantRecord[]> {
  const db = await setupDB();
  return db.getAll(ACCESS_GRANTS_STORE);
}

export async function deleteAccessGrant(nodeId: string): Promise<void> {
  const db = await setupDB();
  await db.delete(ACCESS_GRANTS_STORE, nodeId);
}
