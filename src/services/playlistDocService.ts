// doc-backed playlist and song crud.
// all playlist/song mutations go through automerge handles.
// audio and image bytes are stored in the shared opfs blob store keyed by sha256.

import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  createPlaylistDoc,
  findPlaylistDoc,
  deletePlaylistDoc,
} from "./automergeRepo.js";
import {
  parsePlaylistDoc,
  emptyPlaylistDoc,
  upsertSong,
  removeSong,
  reorderSongs as reorderSongsMutation,
  setMetadata,
  addImage,
  type PlaylistDoc,
  type SongEntry,
  type ImageRef,
} from "freqhole-api-client/playlistz";
import {
  storeBlob,
  getBlobObjectURL,
} from "freqhole-api-client/storage";
import {
  addDocIndexEntry,
  removeDocIndexEntry,
} from "./docIndexService.js";
import { calculateSHA256 } from "../utils/hashUtils.js";
import { triggerSpecificSongUpdate } from "./songReactivity.js";
import type { Playlist, Song } from "../types/playlist.js";
import type { DocIndexEntry } from "./indexedDBService.js";

// in-memory registry: songId -> { docId, entry, index } for getSongById lookups.
// populated whenever a playlist's songs are fetched or mutated.
const songRegistry = new Map<
  string,
  { docId: string; entry: SongEntry; index: number }
>();

// register all songs from a parsed doc into the registry
function registerDocSongs(docId: string, doc: PlaylistDoc): void {
  for (let i = 0; i < doc.order.length; i++) {
    const songId = doc.order[i]!;
    const entry = doc.songs[songId];
    if (entry) {
      songRegistry.set(songId, { docId, entry, index: i });
    }
  }
  // remove songs no longer in this doc from the registry
  for (const [id, reg] of songRegistry.entries()) {
    if (reg.docId === docId && !doc.songs[id]) {
      songRegistry.delete(id);
    }
  }
}

// derive a file extension from a mime type
function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
  };
  return map[mimeType] ?? "bin";
}

// strip solid store proxies / automerge proxies down to plain JSON values.
// anything crossing into handle.change() must be a plain object - automerge
// throws "Cannot create a reference to an existing document object" if a
// doc-derived proxy is re-inserted, and solid proxies confuse serialization.
function toPlain<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- view shape adapters ---

// map a PlaylistDoc + docId to the legacy Playlist view shape components consume.
export function docToPlaylist(docId: string, doc: PlaylistDoc): Playlist {
  return {
    id: docId,
    title: doc.title || "untitled playlist",
    description: doc.description || undefined,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
    updatedAt: doc.lastModified
      ? new Date(doc.lastModified).getTime()
      : Date.now(),
    songIds: [...doc.order],
    // image fields are not eagerly loaded - blob store access is on-demand
    imageData: undefined,
    thumbnailData: undefined,
    imageType: undefined,
    // primary image sha for display (callers can load via getSongImageObjectURL)
    _primaryImageSha: doc.images.find((i) => i.isPrimary)?.blobId,
    bgFilterEnabled: doc.bgFilterEnabled,
    bgFilterBlur: doc.bgFilterBlur,
    bgFilterContrast: doc.bgFilterContrast,
    bgFilterBrightness: doc.bgFilterBrightness,
    coverFilterEnabled: doc.coverFilterEnabled,
    coverFilterBlur: doc.coverFilterBlur,
  } as Playlist;
}

// map a SongEntry to the legacy Song view shape components consume.
// index is the position of the song in doc.order.
export function songEntryToSong(
  entry: SongEntry,
  docId: string,
  index: number
): Song {
  return {
    id: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    duration: entry.duration,
    mimeType: entry.mimeType,
    fileSize: entry.fileSize,
    originalFilename: `${entry.title}.${extFromMime(entry.mimeType)}`,
    position: index,
    playlistId: docId,
    sha: entry.sha256,
    sha256: entry.sha256,
    // timestamp fields not in SongEntry; derive from playlist's lastModified
    createdAt: 0,
    updatedAt: 0,
    // image fields: populated on-demand via getSongImageObjectURL or getSongById
    imageData: undefined,
    thumbnailData: undefined,
    imageType:
      entry.images.length > 0
        ? entry.images.find((i) => i.isPrimary)?.blobType
          ? undefined
          : undefined
        : undefined,
    // carry image refs so callers can load from blob store
    images: entry.images,
  };
}

// --- read helpers ---

// get all songs for a playlist doc as Song view objects.
// also populates the songRegistry for subsequent getSongById calls.
export async function getSongsForPlaylist(docId: string): Promise<Song[]> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  const raw = handle.doc();
  if (!raw) return [];
  const doc = parsePlaylistDoc(raw);
  registerDocSongs(docId, doc);
  return doc.order
    .map((id, i) => {
      const entry = doc.songs[id];
      if (!entry) return null;
      return songEntryToSong(entry, docId, i);
    })
    .filter((s): s is Song => s !== null);
}

// get a single song by id using the in-memory registry.
// falls back to null if the song is not in any currently-tracked doc.
export async function getSongById(songId: string): Promise<Song | null> {
  const reg = songRegistry.get(songId);
  if (!reg) return null;
  return songEntryToSong(reg.entry, reg.docId, reg.index);
}

// get an object url for a song's primary audio blob (sha256 key).
export async function getSongAudioObjectURL(
  sha256: string
): Promise<string | null> {
  if (!sha256) return null;
  return getBlobObjectURL(sha256);
}

// get an object url for a song's primary image blob.
export async function getSongImageObjectURL(
  entry: SongEntry | Song
): Promise<string | null> {
  const images =
    "images" in entry && Array.isArray(entry.images) ? entry.images : [];
  const primary =
    (images as ImageRef[]).find((i) => i.isPrimary) ||
    (images as ImageRef[])[0];
  if (!primary) return null;
  return getBlobObjectURL(primary.blobId);
}

// stub kept for playlistDownloadService compat (returns empty - real data is in docs)
export async function getSongsWithAudioData(
  _songIds: string[]
): Promise<Song[]> {
  console.warn(
    "getsongswithaudiodata: stub - export/import not yet doc-backed"
  );
  return [];
}

// --- mutations ---

// create a new playlist doc and add it to the docIndex.
export async function createPlaylist(fields: {
  title?: string;
  description?: string;
}): Promise<Playlist> {
  console.log("[trace] createPlaylist: creating doc");
  const { docId, handle } = createPlaylistDoc(
    emptyPlaylistDoc({
      title: fields.title ?? "new playlist",
      description: fields.description ?? "",
    })
  );
  console.log("[trace] createPlaylist: doc created", docId);

  const entry: DocIndexEntry = {
    docId,
    title: fields.title ?? "new playlist",
    addedAt: Date.now(),
    source: "local",
  };
  await addDocIndexEntry(entry);
  console.log("[trace] createPlaylist: docIndex entry added");

  const raw = handle.doc();
  console.log("[trace] createPlaylist: handle.doc() returned", raw != null);
  const doc = parsePlaylistDoc(raw ?? {});
  console.log("[trace] createPlaylist: parsed, returning");
  return docToPlaylist(docId, doc);
}

// update playlist metadata (title/description/display filters) via setMetadata mutation.
export async function updatePlaylist(
  docId: string,
  fields: {
    title?: string;
    description?: string;
    rev?: number;
    bgFilterEnabled?: boolean;
    bgFilterBlur?: number;
    bgFilterContrast?: number;
    bgFilterBrightness?: number;
    coverFilterEnabled?: boolean;
    coverFilterBlur?: number;
  }
): Promise<void> {
  console.log("[trace] updatePlaylist", docId, JSON.stringify(fields));
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  const { rev: _rev, ...metadataFields } = toPlain(fields);
  console.log("[trace] updatePlaylist: calling handle.change (setMetadata)");
  handle.change((doc) => setMetadata(doc, metadataFields));
  // update docIndex title if title changed
  if (fields.title !== undefined) {
    console.log("[trace] updatePlaylist: title changed, updating docIndex");
    const existing = await import("./docIndexService.js").then((m) =>
      m.getDocIndexEntry(docId)
    );
    if (existing) {
      await addDocIndexEntry({ ...existing, title: fields.title });
    }
  }
}

// tombstone and remove a playlist doc from the local repo and docIndex.
export async function deletePlaylist(docId: string): Promise<void> {
  await deletePlaylistDoc(docId as AutomergeUrl);
  await removeDocIndexEntry(docId);
  // clear all songs for this doc from the registry
  for (const [id, reg] of songRegistry.entries()) {
    if (reg.docId === docId) {
      songRegistry.delete(id);
    }
  }
}

// add a song to a playlist doc.
// audio bytes are stored in the blob store; the doc carries only metadata + sha256.
export async function addSongToPlaylist(
  docId: string,
  file: File,
  metadata: {
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    imageData?: ArrayBuffer;
    imageType?: string;
  } = {}
): Promise<Song> {
  const songId = crypto.randomUUID();

  // store audio bytes in blob store
  const audioBlob = new Blob([await file.arrayBuffer()], { type: file.type });
  const sha256 = await storeBlob(audioBlob, file.type);

  // store cover art in blob store if provided
  const imageRefs: ImageRef[] = [];
  if (metadata.imageData && metadata.imageType) {
    const imageBlob = new Blob([metadata.imageData], {
      type: metadata.imageType,
    });
    const imageSha = await storeBlob(imageBlob, metadata.imageType);
    imageRefs.push({ blobId: imageSha, isPrimary: true, blobType: "original" });
  }

  const entry: SongEntry = {
    id: songId,
    title: metadata.title || file.name.replace(/\.[^/.]+$/, "") || "untitled",
    artist: metadata.artist || "unknown artist",
    album: metadata.album || "unknown album",
    duration: metadata.duration || 0,
    mimeType: file.type || "audio/mpeg",
    fileSize: file.size,
    sha256,
    images: imageRefs,
    urls: [],
  };

  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => upsertSong(doc, toPlain(entry)));

  // update registry
  const raw = handle.doc();
  const doc = parsePlaylistDoc(raw ?? {});
  registerDocSongs(docId, doc);

  const index = doc.order.indexOf(songId);
  const song = songEntryToSong(entry, docId, index >= 0 ? index : doc.order.length - 1);
  triggerSpecificSongUpdate(songId);
  return song;
}

// update song metadata in the doc.
// only title, artist, album, duration, and image fields are supported.
export async function updateSongInDoc(
  docId: string,
  songId: string,
  updates: Partial<Pick<Song, "title" | "artist" | "album" | "duration" | "imageData" | "imageType">>
): Promise<void> {
  console.log("[trace] updateSongInDoc", docId, songId);
  const handle = await findPlaylistDoc(docId as AutomergeUrl);

  // store new image if provided
  let newImageRef: ImageRef | undefined;
  if (updates.imageData && updates.imageType) {
    const imageBlob = new Blob([updates.imageData], {
      type: updates.imageType,
    });
    const imageSha = await storeBlob(imageBlob, updates.imageType);
    newImageRef = { blobId: imageSha, isPrimary: true, blobType: "original" };
  }

  // plain scalar copies - never let solid proxies into the doc
  const title = updates.title;
  const artist = updates.artist;
  const album = updates.album;
  const duration = updates.duration;

  handle.change((doc) => {
    const existing = doc.songs[songId];
    if (!existing) return;

    // mutate fields in place - re-inserting a doc-derived object (e.g. via
    // spread + upsertSong) makes automerge throw "Cannot create a reference
    // to an existing document object"
    if (title !== undefined) existing.title = title;
    if (artist !== undefined) existing.artist = artist;
    if (album !== undefined) existing.album = album;
    if (duration !== undefined) existing.duration = duration;

    if (newImageRef) {
      // replace all images with the new one (fresh plain object)
      existing.images.splice(0, existing.images.length);
      existing.images.push(toPlain(newImageRef));
    }
  });

  // refresh registry
  const raw = handle.doc();
  const doc = parsePlaylistDoc(raw ?? {});
  registerDocSongs(docId, doc);

  triggerSpecificSongUpdate(songId);
}

// remove a song from the playlist doc.
// the audio blob is not deleted (may be shared or still needed for export).
export async function deleteSong(
  docId: string,
  songId: string
): Promise<void> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => removeSong(doc, songId));
  songRegistry.delete(songId);
  triggerSpecificSongUpdate(songId);
}

// reorder songs in a playlist doc by moving fromIndex to toIndex.
export async function reorderSongsInDoc(
  docId: string,
  fromIndex: number,
  toIndex: number
): Promise<void> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    const songId = doc.order[fromIndex];
    if (songId === undefined) return;
    reorderSongsMutation(doc, songId, toIndex);
  });

  // refresh registry with updated order
  const raw = handle.doc();
  const doc = parsePlaylistDoc(raw ?? {});
  registerDocSongs(docId, doc);
}

// add a cover image to a playlist doc.
// imageData bytes are stored in the blob store; an ImageRef is added to the doc.
export async function setPlaylistCoverImage(
  docId: string,
  imageData: ArrayBuffer,
  mimeType: string
): Promise<void> {
  const imageBlob = new Blob([imageData], { type: mimeType });
  const sha256 = await storeBlob(imageBlob, mimeType);

  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    addImage(doc, { blobId: sha256, isPrimary: true, blobType: "original" });
  });
}

// remove all playlist-level cover images from the doc.
// blob store bytes are not deleted (they may be referenced elsewhere).
export async function clearPlaylistCoverImage(docId: string): Promise<void> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    doc.images.splice(0, doc.images.length);
  });
}

// add or update a song's cover image.
export async function setSongCoverImage(
  docId: string,
  songId: string,
  imageData: ArrayBuffer,
  mimeType: string
): Promise<void> {
  const imageBlob = new Blob([imageData], { type: mimeType });
  const sha256 = await storeBlob(imageBlob, mimeType);

  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    addImage(
      doc,
      { blobId: sha256, isPrimary: true, blobType: "original" },
      { songId }
    );
  });

  triggerSpecificSongUpdate(songId);
}

// expose calculateSHA256 re-export for callers that already have the bytes
export { calculateSHA256 };
