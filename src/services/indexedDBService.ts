// indexeddb service - phase 4+ schema.
// musicPlaylistDB v1 contains only non-doc state:
//   playbackPositions, lastPlayed, settings, docIndex, knocks, accessGrants.
// playlist and song data live in automerge docs (freqhole-automerge idb via
// IndexedDBStorageAdapter). see playlistDocService for doc-backed crud.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// simple signal implementation for live queries
interface Signal<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (fn: (value: T) => void) => () => void;
}

function createSignal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<(value: T) => void>();

  return {
    get: () => value,
    set: (newVal) => {
      if (value !== newVal) {
        value = newVal;
        subs.forEach((fn) => fn(value));
      }
    },
    subscribe: (fn) => {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
  };
}

// database configuration
export const DB_NAME = "musicPlaylistDB";
export const DB_VERSION = 1;

// legacy store name constants kept for compatibility with standalone/streaming services.
// these stores are no longer created in musicPlaylistDB - data lives in automerge docs.
export const PLAYLISTS_STORE = "playlists";
export const SONGS_STORE = "songs";

export const PLAYBACK_POSITIONS_STORE = "playbackPositions";
export const LAST_PLAYED_STORE = "lastPlayed";
export const SETTINGS_STORE = "settings";
export const DOC_INDEX_STORE = "docIndex";
export const KNOCKS_STORE = "knocks";
export const ACCESS_GRANTS_STORE = "accessGrants";

// record shape stored per-song in the playbackPositions store
export interface PlaybackPositionRecord {
  songId: string;
  position: number;
  updatedAt: number;
}

export interface LastPlayedRecord {
  playlistId: string;
  songId: string;
  updatedAt: number;
}

// generic key-value record for ui/app settings
export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

// automerge doc index entry: maps an AutomergeUrl to display metadata.
// used to list known playlists in the sidebar without loading every doc.
export interface DocIndexEntry {
  docId: string; // AutomergeUrl, e.g. "automerge:abc123..."
  title: string;
  addedAt: number; // unix ms timestamp
  source: "local" | "shared" | "freqhole";
}

// inbound or outbound knock request record for the knock inbox/outbox ui.
export interface KnockRecord {
  id: string; // uuid
  nodeId: string; // requester (inbound) or responder (outbound) iroh node id
  direction: "inbound" | "outbound";
  name: string;
  message: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
  processedAt?: number;
}

// access grant written when an inbound knock is accepted.
export interface AccessGrantRecord {
  nodeId: string; // the granted peer's iroh node id (keyPath)
  name: string;
  grantedAt: number;
}

// database schema definition - v1 contains only non-doc state
interface PlaylistDB extends DBSchema {
  playbackPositions: {
    key: string;
    value: PlaybackPositionRecord;
  };
  lastPlayed: {
    key: string;
    value: LastPlayedRecord;
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
  docIndex: {
    key: string; // docId (AutomergeUrl)
    value: DocIndexEntry;
  };
  knocks: {
    key: string; // id
    value: KnockRecord;
  };
  accessGrants: {
    key: string; // nodeId
    value: AccessGrantRecord;
  };
}

// database connection cache
let cachedDB: Promise<IDBPDatabase<PlaylistDB>> | null = null;

export async function setupDB(): Promise<IDBPDatabase<PlaylistDB>> {
  if (cachedDB) {
    return cachedDB;
  }

  cachedDB = openDB<PlaylistDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(PLAYBACK_POSITIONS_STORE)) {
        db.createObjectStore(PLAYBACK_POSITIONS_STORE, { keyPath: "songId" });
      }
      if (!db.objectStoreNames.contains(LAST_PLAYED_STORE)) {
        db.createObjectStore(LAST_PLAYED_STORE, { keyPath: "playlistId" });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(DOC_INDEX_STORE)) {
        db.createObjectStore(DOC_INDEX_STORE, { keyPath: "docId" });
      }
      if (!db.objectStoreNames.contains(KNOCKS_STORE)) {
        db.createObjectStore(KNOCKS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ACCESS_GRANTS_STORE)) {
        db.createObjectStore(ACCESS_GRANTS_STORE, { keyPath: "nodeId" });
      }
    },
  });

  return cachedDB;
}

// reset the database cache - for testing only
export function resetDBCache(): void {
  cachedDB = null;
}

// live query configuration
interface LiveQueryConfig {
  dbName: string;
  storeName: string;
  queryFn?: (item: unknown) => boolean;
  fields?: string[];
  limit?: number | null;
}

function arraysDiffer<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((item, index) => {
    if (typeof item === "object" && item !== null && b[index] !== null) {
      return JSON.stringify(item) !== JSON.stringify(b[index]);
    }
    return item !== b[index];
  });
}

// global registry to track all live queries for direct same-tab updates
const globalQueryRegistry = new Map<string, Set<() => void>>();

export function createLiveQuery<T>({
  dbName,
  storeName,
  queryFn,
  fields = [],
  limit = null,
}: LiveQueryConfig): Signal<T[]> {
  const signal = createSignal<T[]>([]);
  const bc = new BroadcastChannel(`${dbName}-changes`);
  let last: T[] = [];

  const validStores = [
    PLAYBACK_POSITIONS_STORE,
    LAST_PLAYED_STORE,
    SETTINGS_STORE,
    DOC_INDEX_STORE,
    KNOCKS_STORE,
    ACCESS_GRANTS_STORE,
  ];

  async function fetchAndUpdate() {
    try {
      if (!validStores.includes(storeName)) {
        signal.set([]);
        return;
      }

      const db = await setupDB();
      let items = await (db as IDBPDatabase).getAll(storeName);

      if (queryFn) items = items.filter(queryFn);
      if (limit) items = items.slice(0, limit);

      const filtered = items.map((item): T => {
        if (fields.length === 0) return item as T;

        const rec = item as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        // copy whichever key field the record uses
        if (typeof rec.id === "string") out.id = rec.id;
        if (typeof rec.docId === "string") out.docId = rec.docId;
        if (typeof rec.songId === "string") out.songId = rec.songId;
        if (typeof rec.playlistId === "string") out.playlistId = rec.playlistId;
        if (typeof rec.nodeId === "string") out.nodeId = rec.nodeId;
        for (const f of fields) {
          out[f] = rec[f];
        }
        return out as T;
      });

      if (arraysDiffer(last, filtered)) {
        last = filtered;
        signal.set(filtered);
      }
    } catch (error) {
      console.error("error in fetchandupdate:", error);
    }
  }

  const registryKey = `${dbName}-${storeName}`;
  if (!globalQueryRegistry.has(registryKey)) {
    globalQueryRegistry.set(registryKey, new Set());
  }
  const querySet = globalQueryRegistry.get(registryKey)!;
  querySet.add(fetchAndUpdate);

  bc.onmessage = (e) => {
    if (e.data?.type === "mutation" && e.data.store === storeName) {
      fetchAndUpdate();
    }
  };

  fetchAndUpdate();

  const originalSignal = signal;
  return {
    ...originalSignal,
    subscribe: (fn: (value: T[]) => void) => {
      const unsubscribe = originalSignal.subscribe(fn);
      return () => {
        unsubscribe();
        querySet.delete(fetchAndUpdate);
        if (querySet.size === 0) {
          globalQueryRegistry.delete(registryKey);
        }
        bc.close();
      };
    },
  };
}

// --- playback positions ---

export async function loadAllPlaybackPositions(): Promise<Map<string, number>> {
  try {
    const db = await setupDB();
    const records = await db.getAll(PLAYBACK_POSITIONS_STORE);
    const map = new Map<string, number>();
    for (const r of records) {
      map.set(r.songId, r.position);
    }
    return map;
  } catch (error) {
    console.warn("error loading playback positions:", error);
    return new Map();
  }
}

export async function savePlaybackPosition(
  songId: string,
  position: number
): Promise<void> {
  try {
    const db = await setupDB();
    await db.put(PLAYBACK_POSITIONS_STORE, {
      songId,
      position,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.warn(`error saving playback position for ${songId}:`, error);
  }
}

export async function deletePlaybackPosition(songId: string): Promise<void> {
  try {
    const db = await setupDB();
    await db.delete(PLAYBACK_POSITIONS_STORE, songId);
  } catch (error) {
    console.warn(`error deleting playback position for ${songId}:`, error);
  }
}

// --- last played ---

export async function saveLastPlayed(
  playlistId: string,
  songId: string
): Promise<void> {
  try {
    const db = await setupDB();
    await db.put(LAST_PLAYED_STORE, {
      playlistId,
      songId,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.warn(`error saving last played for playlist ${playlistId}:`, error);
  }
}

export async function loadLastPlayed(
  playlistId: string
): Promise<string | null> {
  try {
    const db = await setupDB();
    const record = await db.get(LAST_PLAYED_STORE, playlistId);
    return record?.songId ?? null;
  } catch (error) {
    console.warn(
      `error loading last played for playlist ${playlistId}:`,
      error
    );
    return null;
  }
}

// --- settings ---

export async function saveSetting(key: string, value: unknown): Promise<void> {
  try {
    const db = await setupDB();
    await db.put(SETTINGS_STORE, { key, value, updatedAt: Date.now() });
  } catch (error) {
    console.warn(`error saving setting ${key}:`, error);
  }
}

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const db = await setupDB();
    const record = await db.get(SETTINGS_STORE, key);
    return record === undefined ? null : (record.value as T);
  } catch (error) {
    console.warn(`error loading setting ${key}:`, error);
    return null;
  }
}

// --- compatibility stubs ---
// kept for services that get minimal-compile-fix treatment only:
// standaloneService, playlistDownloadService, streamingAudioService.
// they are no-ops at runtime; real implementations are in playlistDocService.

import type { Playlist, Song } from "../types/playlist.js";

export interface MutationConfig<T> {
  dbName: string;
  storeName: string;
  key: string;
  updateFn: (current: T | null) => T;
}

// no-op stub - real mutations go through playlistDocService
export async function mutateAndNotify<T extends Playlist | Song>(
  _config: MutationConfig<T>
): Promise<void> {
  console.warn(
    "mutateandnotify: called on stub - data is doc-backed, use playlistDocService"
  );
}

// stub - returns empty array; real impl in playlistDocService
export async function getSongsWithAudioData(
  _songIds: string[]
): Promise<Song[]> {
  console.warn(
    "getsongswithaudiodata: stub - use playlistDocService instead"
  );
  return [];
}

// stub - no-op
export async function updatePlaylist(
  _id: string,
  _updates: Partial<Playlist>
): Promise<void> {
  console.warn("updateplaylist: stub - use playlistDocService instead");
}

// stub - no-op
export async function updateSong(
  _id: string,
  _updates: Partial<Song>
): Promise<void> {
  console.warn("updatesong: stub - use playlistDocService instead");
}
