// type guards to avoid casting and improve type safety

import type { Playlist, Song } from "../types/playlist.js";

// type guard for checking if a value is a playlist
export function isPlaylist(value: unknown): value is Playlist {
  if (!value || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.title === "string" &&
    typeof obj.createdAt === "number" &&
    typeof obj.updatedAt === "number" &&
    Array.isArray(obj.songIds) &&
    obj.songIds.every((id: unknown) => typeof id === "string")
  );
}

// type guard for checking if a value is a song
export function isSong(value: unknown): value is Song {
  if (!value || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.mimeType === "string" &&
    typeof obj.originalFilename === "string" &&
    typeof obj.title === "string" &&
    typeof obj.artist === "string" &&
    typeof obj.album === "string" &&
    typeof obj.duration === "number" &&
    typeof obj.position === "number" &&
    typeof obj.createdAt === "number" &&
    typeof obj.updatedAt === "number" &&
    typeof obj.playlistId === "string"
  );
}

// type guard for valid store names
export function isValidStoreName(name: string): name is "playlists" | "songs" {
  return name === "playlists" || name === "songs";
}

// type guard for ensuring an object has an id
export function hasId(obj: unknown): obj is { id: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as any).id === "string"
  );
}

// type guard for ensuring an object has songIds array
export function hasSongIds(obj: unknown): obj is { songIds: string[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    Array.isArray((obj as any).songIds) &&
    (obj as any).songIds.every((id: unknown) => typeof id === "string")
  );
}

// type guard for checking if value has audio data
export function hasAudioData(
  obj: unknown
): obj is { audioData: ArrayBuffer; mimeType: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as any).audioData instanceof ArrayBuffer &&
    (obj as any).audioData.byteLength > 0 &&
    typeof (obj as any).mimeType === "string"
  );
}

// type guard for checking if value has image data
export function hasImageData(obj: unknown): obj is {
  imageData?: ArrayBuffer;
  thumbnailData?: ArrayBuffer;
  imageType?: string;
} {
  if (!obj || typeof obj !== "object") return false;

  const item = obj as any;
  const hasImage =
    item.imageData instanceof ArrayBuffer && item.imageData.byteLength > 0;
  const hasThumbnail =
    item.thumbnailData instanceof ArrayBuffer &&
    item.thumbnailData.byteLength > 0;
  const hasType = typeof item.imageType === "string";

  return (hasImage || hasThumbnail) && hasType;
}

// create a properly typed object from unknown, with validation
export function createTypedPlaylist(data: unknown): Playlist | null {
  if (!isPlaylist(data)) return null;
  return data;
}

// create a properly typed song from unknown, with validation
export function createTypedSong(data: unknown): Song | null {
  if (!isSong(data)) return null;
  return data;
}

// safe property access with default values
export function safeString(
  obj: unknown,
  key: string,
  defaultValue = ""
): string {
  if (!obj || typeof obj !== "object") return defaultValue;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : defaultValue;
}

export function safeNumber(
  obj: unknown,
  key: string,
  defaultValue = 0
): number {
  if (!obj || typeof obj !== "object") return defaultValue;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "number" ? value : defaultValue;
}

export function safeArray<T>(
  obj: unknown,
  key: string,
  defaultValue: T[] = []
): T[] {
  if (!obj || typeof obj !== "object") return defaultValue;
  const value = (obj as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : defaultValue;
}

// type narrowing helpers for mutations
export function assertPlaylist(value: unknown): asserts value is Playlist {
  if (!isPlaylist(value)) {
    throw new Error("expected playlist object");
  }
}

export function assertSong(value: unknown): asserts value is Song {
  if (!isSong(value)) {
    throw new Error("expected song object");
  }
}

// safe merge for updates (no casting needed)
export function mergePlaylistUpdates(
  existing: Playlist,
  updates: Partial<Playlist>
): Playlist {
  return {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
}

export function mergeSongUpdates(existing: Song, updates: Partial<Song>): Song {
  return {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
}
