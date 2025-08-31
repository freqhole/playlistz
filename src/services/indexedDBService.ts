// indexeddb service with reactive queries
// based on the existing demo pattern but adapted for music playlists

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Playlist, Song } from "../types/playlist.js";
import { triggerSongUpdateWithOptions } from "./songReactivity.js";
import { calculateSHA256 } from "../utils/hashUtils.js";
import {
  isPlaylist,
  isSong,
  isValidStoreName,
  hasId,
  hasSongIds,
  hasAudioData,
  mergePlaylistUpdates,
  mergeSongUpdates,
  safeArray,
} from "../utils/typeGuards.js";

// simple signal implementation (matching the demo pattern)
interface Signal<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (fn: (value: T) => void) => () => void;
}

// using signal directly instead of empty interface extension

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
export const DB_VERSION = 3;
export const PLAYLISTS_STORE = "playlists";
export const SONGS_STORE = "songs";

// database schema definition
interface PlaylistDB extends DBSchema {
  playlists: {
    key: string;
    value: Playlist;
  };
  songs: {
    key: string;
    value: Song;
    indexes: { playlistId: string };
  };
}

// database connection cache to prevent excessive setupdb calls
let cachedDB: Promise<IDBPDatabase<PlaylistDB>> | null = null;

// database setup with caching
export async function setupDB(): Promise<IDBPDatabase<PlaylistDB>> {
  if (cachedDB) {
    return cachedDB;
  }

  cachedDB = openDB<PlaylistDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion) {
      // Create playlists store
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: "id" });
      }

      // Create songs store with playlist index
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        const songStore = db.createObjectStore(SONGS_STORE, { keyPath: "id" });
        songStore.createIndex("playlistId", "playlistId", { unique: false });
      }

      // Migration for version 3: Add thumbnail data support
      if (oldVersion < 3) {
        // Note: New thumbnailData fields will be undefined for existing records
        // They will be populated when users upload new covers or when songs are re-processed
      }
    },
  });

  return cachedDB;
}

/**
 * Reset the database cache - for testing purposes only
 */
export function resetDBCache(): void {
  cachedDB = null;
}

// Live query configuration
interface LiveQueryConfig {
  dbName: string;
  storeName: string;
  queryFn?: (item: unknown) => boolean;
  fields?: string[];
  limit?: number | null;
}

// simple diff function (avoiding microdiff dependency)
function arraysDiffer<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((item, index) => {
    if (typeof item === "object" && item !== null && b[index] !== null) {
      return JSON.stringify(item) !== JSON.stringify(b[index]);
    }
    return item !== b[index];
  });
}

// create live query (returns both custom signal and solidjs integration)
// global registry to track all live queries for direct updates
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

  async function fetchAndUpdate() {
    try {
      const db = await setupDB();
      if (!isValidStoreName(storeName)) {
        throw new Error(`invalid store name: ${storeName}`);
      }

      let items = await db.getAll(storeName);

      if (queryFn) items = items.filter(queryFn);
      if (limit) items = items.slice(0, limit);

      const filtered = items.map((item): T => {
        if (fields.length === 0) return item as T;

        if (!hasId(item)) {
          throw new Error("item missing required id field");
        }

        const out: Record<string, unknown> = { id: item.id };
        for (const f of fields) {
          if (typeof item === "object" && item !== null) {
            out[f] = (item as unknown as Record<string, unknown>)[f];
          }
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

  // register this query in the global registry for direct updates
  const registryKey = `${dbName}-${storeName}`;
  if (!globalQueryRegistry.has(registryKey)) {
    globalQueryRegistry.set(registryKey, new Set());
  }
  const querySet = globalQueryRegistry.get(registryKey)!;
  querySet.add(fetchAndUpdate);

  // broadcastchannel listener (for cross-tab updates)
  bc.onmessage = (e) => {
    if (e.data?.type === "mutation" && e.data.store === storeName) {
      fetchAndUpdate();
    }
  };

  // initial fetch
  fetchAndUpdate();

  // return signal with cleanup function
  const originalSignal = signal;
  return {
    ...originalSignal,
    subscribe: (fn: (value: T[]) => void) => {
      const unsubscribe = originalSignal.subscribe(fn);
      return () => {
        unsubscribe();
        // remove from registry when unsubscribing
        querySet.delete(fetchAndUpdate);
        if (querySet.size === 0) {
          globalQueryRegistry.delete(registryKey);
        }
        bc.close();
      };
    },
  };
}

// mutation with notification (matching demo pattern)
interface MutationConfig<T extends Playlist | Song> {
  dbName: string;
  storeName: string;
  key: string;
  updateFn: (current: T | null) => T;
}

async function mutatePlaylist(config: {
  key: string;
  updateFn: (current: Playlist | null) => Playlist;
}): Promise<void> {
  const db = await setupDB();
  const tx = db.transaction("playlists", "readwrite");
  const store = tx.objectStore("playlists");

  const current = await store.get(config.key);
  const currentPlaylist = current && isPlaylist(current) ? current : null;
  const updated = config.updateFn(currentPlaylist);

  await store.put(updated);
  await tx.done;
}

async function mutateSong(config: {
  key: string;
  updateFn: (current: Song | null) => Song;
}): Promise<void> {
  const db = await setupDB();
  const tx = db.transaction("songs", "readwrite");
  const store = tx.objectStore("songs");

  const current = await store.get(config.key);
  const currentSong = current && isSong(current) ? current : null;
  const updated = config.updateFn(currentSong);

  await store.put(updated);
  await tx.done;
}

export async function mutateAndNotify<T extends Playlist | Song>({
  dbName,
  storeName,
  key,
  updateFn,
}: MutationConfig<T>): Promise<void> {
  if (storeName === "playlists") {
    await mutatePlaylist({
      key,
      updateFn: updateFn as (current: Playlist | null) => Playlist,
    });
  } else if (storeName === "songs") {
    await mutateSong({
      key,
      updateFn: updateFn as (current: Song | null) => Song,
    });
  } else {
    throw new Error(`invalid store name: ${storeName}`);
  }

  // direct updates to same-tab queries (immediate)
  const registryKey = `${dbName}-${storeName}`;
  const querySet = globalQueryRegistry.get(registryKey);
  if (querySet) {
    for (const fetchAndUpdate of Array.from(querySet)) {
      try {
        fetchAndUpdate();
      } catch (error) {
        console.error("error in direct query update:", error);
      }
    }
  }

  // BroadcastChannel for cross-tab updates (async)
  const bc = new BroadcastChannel(`${dbName}-changes`);
  try {
    const message = { type: "mutation", store: storeName, id: key };
    bc.postMessage(message);
  } finally {
    bc.close();
  }
}

// Playlist operations
export async function createPlaylist(
  playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt">
): Promise<Playlist> {
  const id = crypto.randomUUID();
  const now = Date.now();

  const newPlaylist: Playlist = {
    id,
    createdAt: now,
    updatedAt: now,
    ...playlist,
    rev: playlist.rev ?? 0, // Use provided rev or default to 0
    songIds: playlist.songIds || [],
  };

  await mutateAndNotify({
    dbName: DB_NAME,
    storeName: PLAYLISTS_STORE,
    key: id,
    updateFn: () => newPlaylist,
  });

  return newPlaylist;
}

export async function updatePlaylist(
  id: string,
  updates: Partial<Playlist>
): Promise<void> {
  await mutatePlaylist({
    key: id,
    updateFn: (current) => {
      if (!current) {
        throw new Error(`playlist ${id} not found`);
      }
      return mergePlaylistUpdates(current, updates);
    },
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  const db = await setupDB();

  // Delete all songs in the playlist first
  const tx1 = db.transaction(SONGS_STORE, "readwrite");
  const songStore = tx1.objectStore(SONGS_STORE);
  const index = songStore.index("playlistId");

  let cursor = await index.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx1.done;

  // Delete the playlist
  const tx2 = db.transaction(PLAYLISTS_STORE, "readwrite");
  await tx2.objectStore(PLAYLISTS_STORE).delete(id);
  await tx2.done;

  const bc = new BroadcastChannel(`${DB_NAME}-changes`);
  try {
    bc.postMessage({ type: "mutation", store: PLAYLISTS_STORE, id });
    bc.postMessage({ type: "mutation", store: SONGS_STORE, id });
  } finally {
    bc.close();
  }
}

// Song operations
export async function addSongToPlaylist(
  playlistId: string,
  file: File,
  metadata: Partial<Song> = {}
): Promise<Song> {
  const songId = crypto.randomUUID();
  const now = Date.now();

  // Convert File to ArrayBuffer for persistent storage
  const audioData = await file.arrayBuffer();

  // Calculate SHA-256 hash of the audio data
  const sha = await calculateSHA256(audioData);

  const song: Song = {
    id: songId,
    file, // Temporary - only available during creation
    mimeType: file.type, // Store MIME type
    originalFilename: file.name, // Store original filename with extension
    title: metadata.title || file.name.replace(/\.[^/.]+$/, ""), // Remove file extension
    artist: metadata.artist || "Unknown Artist",
    album: metadata.album || "Unknown Album",
    duration: metadata.duration || 0,
    position: metadata.position || 0,
    playlistId,
    createdAt: now,
    updatedAt: now,
    sha, // Include calculated SHA
    ...metadata,
  };

  // Create version for IndexedDB with ArrayBuffer instead of File
  const songForDB = {
    ...song,
    file: undefined, // Remove File object
    audioData, // Store audio as ArrayBuffer
    mimeType: file.type, // Store MIME type to recreate blob
  };

  // Add song to songs store
  await mutateAndNotify({
    dbName: DB_NAME,
    storeName: SONGS_STORE,
    key: songId,
    updateFn: () => songForDB,
  });

  // update playlist's song list
  await mutatePlaylist({
    key: playlistId,
    updateFn: (playlist) => {
      if (!playlist) {
        throw new Error(`playlist ${playlistId} not found`);
      }
      const currentSongIds = safeArray(playlist, "songIds", []);
      return mergePlaylistUpdates(playlist, {
        songIds: [...currentSongIds, songId],
      });
    },
  });

  // trigger reactivity for ui updates
  triggerSongUpdateWithOptions({
    songId: song.id,
    type: "create",
    metadata: { playlistId, title: song.title },
  });

  return song;
}

export async function updateSong(
  id: string,
  updates: Partial<Song>
): Promise<void> {
  await mutateSong({
    key: id,
    updateFn: (current) => {
      if (!current) {
        throw new Error(`song ${id} not found`);
      }
      return mergeSongUpdates(current, updates);
    },
  });

  // trigger reactivity for ui updates
  triggerSongUpdateWithOptions({
    songId: id,
    type: "edit",
    metadata: { fields: Object.keys(updates) },
  });
}

export async function deleteSong(songId: string): Promise<void> {
  const db = await setupDB();

  // Get the song to find its playlist
  const song = await db.get(SONGS_STORE, songId);
  if (!song) return;

  // Remove song from playlist's songIds
  await mutatePlaylist({
    key: song.playlistId,
    updateFn: (playlist) => {
      if (!playlist) {
        throw new Error(`playlist ${song.playlistId} not found`);
      }
      const currentSongIds = safeArray(playlist, "songIds", []);
      return mergePlaylistUpdates(playlist, {
        songIds: currentSongIds.filter((id: string) => id !== songId),
      });
    },
  });

  // delete the song
  const tx = db.transaction(SONGS_STORE, "readwrite");
  await tx.objectStore(SONGS_STORE).delete(songId);
  await tx.done;

  const bc = new BroadcastChannel(`${DB_NAME}-changes`);
  try {
    bc.postMessage({ type: "mutation", store: SONGS_STORE, id: songId });
  } finally {
    bc.close();
  }
}

// Reorder songs in playlist
export async function reorderSongs(
  playlistId: string,
  fromIndex: number,
  toIndex: number
): Promise<void> {
  await mutatePlaylist({
    key: playlistId,
    updateFn: (playlist) => {
      if (!playlist) {
        throw new Error(`playlist ${playlistId} not found`);
      }
      const songIds = [...safeArray(playlist, "songIds", [])];
      const [movedSong] = songIds.splice(fromIndex, 1);
      if (movedSong) {
        songIds.splice(toIndex, 0, movedSong);
      }

      return mergePlaylistUpdates(playlist, { songIds });
    },
  });

  // update position field on all affected songs
  const db = await setupDB();
  const tx = db.transaction(SONGS_STORE, "readwrite");
  const store = tx.objectStore(SONGS_STORE);
  const index = store.index("playlistId");

  const updates: Promise<void>[] = [];
  let cursor = await index.openCursor(IDBKeyRange.only(playlistId));

  while (cursor) {
    const song = cursor.value;
    // Find new position in the reordered array
    // This is a simplified approach - in practice you might want to get the playlist first
    updates.push(
      mutateAndNotify({
        dbName: DB_NAME,
        storeName: SONGS_STORE,
        key: song.id,
        updateFn: (current) => {
          if (!current || !isSong(current)) {
            throw new Error(`song ${song.id} not found`);
          }
          return mergeSongUpdates(current, { position: 0 });
        },
      })
    );
    cursor = await cursor.continue();
  }

  await tx.done;
}

// Query helpers
export function createPlaylistsQuery() {
  return createLiveQuery<Playlist>({
    dbName: DB_NAME,
    storeName: PLAYLISTS_STORE,
    fields: [
      "title",
      "description",
      "imageData",
      "thumbnailData",
      "imageType",
      "createdAt",
      "updatedAt",
      "songIds",
      "rev",
    ],
  });
}

export function createPlaylistSongsQuery(playlistId: string) {
  return createLiveQuery<Song>({
    dbName: DB_NAME,
    storeName: SONGS_STORE,
    queryFn: (item: unknown) => {
      if (!isSong(item)) return false;
      return item.playlistId === playlistId;
    },
    fields: [
      "title",
      "artist",
      "album",
      "duration",
      "position",
      "imageData",
      "thumbnailData",
      "imageType",
      "createdAt",
      "updatedAt",
      "playlistId",
    ],
  });
}

// Direct query functions for fetching data
export async function getSongById(songId: string): Promise<Song | null> {
  try {
    const db = await setupDB();
    const songData = await db.get(SONGS_STORE, songId);
    if (!songData) return null;

    // Return song metadata without loading audio data
    return {
      ...songData,
      audioData: undefined, // Don't expose raw audio data in metadata
    };
  } catch (error) {
    console.error(`error fetching song ${songId}:`, error);
    return null;
  }
}

// Load audio data on-demand for playback
export async function loadSongAudioData(
  songId: string
): Promise<string | null> {
  try {
    const db = await setupDB();
    const songData = await db.get(SONGS_STORE, songId);

    if (!songData || !songData.audioData || !songData.mimeType) return null;

    // Create blob URL from stored audio data
    const blob = new Blob([songData.audioData], { type: songData.mimeType });
    const blobUrl = URL.createObjectURL(blob);

    return blobUrl;
  } catch (error) {
    console.error(`Error loading audio data for song ${songId}:`, error);
    return null;
  }
}

export async function getAllSongs(): Promise<Song[]> {
  try {
    const db = await setupDB();
    const songs = await db.getAll(SONGS_STORE);

    // Return songs with metadata only, no audio data
    return (
      songs.map((song) => ({
        ...song,
        audioData: undefined, // Don't expose raw audio data in metadata
      })) || []
    );
  } catch (error) {
    console.error("error fetching all songs:", error);
    return [];
  }
}

/**
 * Get songs with their audio data included (for download purposes)
 */
export async function getSongsWithAudioData(
  songIds: string[]
): Promise<Song[]> {
  try {
    const db = await setupDB();
    const songs: Song[] = [];

    for (const songId of songIds) {
      const songData = await db.get(SONGS_STORE, songId);
      if (songData) {
        songs.push(songData); // Include audioData
      }
    }

    return songs.sort((a, b) => {
      const aIndex = songIds.indexOf(a.id);
      const bIndex = songIds.indexOf(b.id);
      return aIndex - bIndex;
    });
  } catch (error) {
    console.error("error getting songs with audio data:", error);
    return [];
  }
}

/**
 * validate that a song has valid audio data
 */
export function hasValidAudioData(song: Song): boolean {
  return hasAudioData(song);
}

/**
 * clean up invalid songs that don't have proper audio data
 */
export async function cleanupInvalidSongs(): Promise<number> {
  try {
    const db = await setupDB();
    const songs = await db.getAll(SONGS_STORE);
    let cleanedCount = 0;

    for (const song of songs) {
      if (!hasValidAudioData(song)) {
        await db.delete(SONGS_STORE, song.id);
        cleanedCount++;
        console.warn(`removed invalid song: ${song.title}`);
      }
    }

    return cleanedCount;
  } catch (error) {
    console.error("error cleaning up invalid songs:", error);
    return 0;
  }
}

export async function getPlaylist(
  playlistId: string
): Promise<Playlist | null> {
  try {
    const db = await setupDB();
    const playlist = await db.get(PLAYLISTS_STORE, playlistId);
    return playlist || null;
  } catch (error) {
    console.error("error fetching playlist:", error);
    return null;
  }
}

export async function getAllPlaylists(): Promise<Playlist[]> {
  try {
    const db = await setupDB();
    const playlists = await db.getAll(PLAYLISTS_STORE);
    return playlists;
  } catch (error) {
    console.error("error fetching all playlists:", error);
    return [];
  }
}

// Remove song from playlist
export async function removeSongFromPlaylist(
  playlistId: string,
  songId: string
): Promise<void> {
  const db = await setupDB();

  // Remove song from playlist's songIds array
  await mutateAndNotify({
    dbName: DB_NAME,
    storeName: PLAYLISTS_STORE,
    key: playlistId,
    updateFn: (playlist) => {
      if (!playlist || !hasSongIds(playlist)) {
        console.warn(`playlist ${playlistId} not found or has no songids`);
        return (
          playlist || {
            id: playlistId,
            title: "",
            songIds: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
        );
      }
      return mergePlaylistUpdates(playlist, {
        songIds: playlist.songIds.filter((id: string) => id !== songId),
      });
    },
  });

  // Delete the song record itself
  const tx = db.transaction(SONGS_STORE, "readwrite");
  const store = tx.objectStore(SONGS_STORE);
  await store.delete(songId);
  await tx.done;

  // Broadcast the song deletion
  const bc = new BroadcastChannel(`${DB_NAME}-changes`);
  try {
    bc.postMessage({
      type: "mutation",
      store: SONGS_STORE,
      id: songId,
    });
  } finally {
    bc.close();
  }

  // trigger reactivity for ui updates
  triggerSongUpdateWithOptions({
    songId,
    type: "delete",
    metadata: { playlistId },
  });
}
