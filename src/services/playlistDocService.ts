// doc-backed playlist and song crud.
// all playlist/song mutations go through automerge handles.
// audio and image bytes are stored in the shared opfs blob store keyed by sha256.

import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  createPlaylistDoc,
  findPlaylistDoc,
  deletePlaylistDoc,
  flushDoc,
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
} from "../types/playlistz";
import {
  storeBlob,
  getBlobObjectURL,
  getBlobMetadata,
  deleteBlob,
} from "@freqhole/api-client/storage";
import {
  addDocIndexEntry,
  removeDocIndexEntry,
  getAllDocIndexEntries,
  getDocIndexEntry,
} from "./docIndexService.js";
import { calculateSHA256 } from "../utils/hashUtils.js";
import { triggerSpecificSongUpdate } from "./songReactivity.js";
import { fetchBlobForDoc } from "./blobTransferService.js";
import { log } from "../utils/log.js";
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

// clear the registry. for use in tests only (simulates a fresh page load).
export function _clearSongRegistryForTests(): void {
  songRegistry.clear();
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
    _primaryImageSha: (doc.images.find((i) => i.isPrimary) ?? doc.images[0])
      ?.blobId,
    bgFilterEnabled: doc.bgFilterEnabled,
    bgFilterBlur: doc.bgFilterBlur,
    bgFilterContrast: doc.bgFilterContrast,
    bgFilterBrightness: doc.bgFilterBrightness,
    coverFilterEnabled: doc.coverFilterEnabled,
    coverFilterBlur: doc.coverFilterBlur,
    bgSize: doc.bgSize,
    bgPosition: doc.bgPosition,
    bgRepeat: doc.bgRepeat,
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
    // timestamp fields not in SongEntry; use current time as a reasonable
    // "when was this added to my library" fallback. the real value is unknown
    // for received songs because the doc schema has no per-song timestamps.
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // image fields hydrated async via hydrateSongImage (blob store)
    imageData: undefined,
    thumbnailData: undefined,
    imageType: undefined,
    // carry image refs so callers can load from blob store
    images: entry.images,
  };
}

// hydrate a song view with its primary image from the blob store:
// sets imageFilePath (object url) and imageType so display components
// (getImageUrlForContext) can render it.
async function hydrateSongImage(song: Song): Promise<Song> {
  const primary =
    song.images?.find((i) => i.isPrimary) ?? song.images?.[0];
  if (!primary) return song;
  try {
    const url = await getBlobObjectURL(primary.blobId);
    if (!url) {
      // blob not in local store - trigger a background fetch from the
      // playlist's p2p peers and re-notify when it arrives so the row
      // can re-render with the image.
      if (song.playlistId) {
        void fetchBlobForDoc(song.playlistId, primary.blobId, primary.blobType ?? "image/jpeg")
          .then((result) => { if (result) triggerSpecificSongUpdate(song.id); })
          .catch(() => {});
      }
      return song;
    }
    const meta = await getBlobMetadata(primary.blobId);
    song.imageFilePath = url;
    song.imageType = meta?.mime_type ?? "image/jpeg";
  } catch {
    // blob missing - leave image fields unset
  }
  return song;
}

// async variant of docToPlaylist that hydrates the playlist cover image
// from the blob store (imageFilePath + imageType).
export async function docToPlaylistAsync(
  docId: string,
  doc: PlaylistDoc
): Promise<Playlist> {
  const playlist = docToPlaylist(docId, doc);
  if (playlist._primaryImageSha) {
    try {
      const url = await getBlobObjectURL(playlist._primaryImageSha);
      if (url) {
        playlist.imageFilePath = url;
        const meta = await getBlobMetadata(playlist._primaryImageSha);
        playlist.imageType = meta?.mime_type ?? "image/jpeg";
      } else {
        // blob not local - trigger background fetch from peers; the caller
        // can re-render when the playlist update arrives via doc subscription.
        void fetchBlobForDoc(docId, playlist._primaryImageSha, "image/jpeg")
          .catch(() => {});
      }
    } catch {
      // blob missing - leave image fields unset
    }
  }
  return playlist;
}

// --- read helpers ---

// get all songs for a playlist doc as Song view objects.
// also populates the songRegistry for subsequent getSongById calls.
export async function getSongsForPlaylist(docId: string): Promise<Song[]> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  return getSongsFromHandle(docId, handle);
}

// same as getSongsForPlaylist but accepts an already-resolved handle.
// use this in contexts where findPlaylistDoc has already been called (e.g.
// inside a doc change handler) to avoid a redundant repo.find() call.
export async function getSongsFromHandle(
  docId: string,
  handle: Awaited<ReturnType<typeof findPlaylistDoc>>
): Promise<Song[]> {
  const raw = handle.doc();
  if (!raw) { log.warn("playlist.doc", "getSongsFromHandle: handle.doc() returned null"); return []; }
  const doc = parsePlaylistDoc(raw);
  log.trace("playlist.doc", "getSongsFromHandle order=", String(doc.order.length), "songs=", String(Object.keys(doc.songs).length));
  registerDocSongs(docId, doc);
  const songs = doc.order
    .map((id, i) => {
      const entry = doc.songs[id];
      if (!entry) return null;
      return songEntryToSong(entry, docId, i);
    })
    .filter((s): s is Song => s !== null);
  return Promise.all(songs.map(hydrateSongImage));
}

// coalesces concurrent registry-rebuild requests into a single operation.
// without this, N SongRow components all firing getSongById on an empty
// registry each triggers their own findPlaylistDoc call in parallel.
let _registryRebuildPromise: Promise<void> | null = null;

// get a single song by id using the in-memory registry.
// on a registry miss (e.g. right after a page reload, before any playlist's
// songs have been fetched), rebuilds the registry from the docIndex.
export async function getSongById(songId: string): Promise<Song | null> {
  let reg = songRegistry.get(songId);

  if (!reg) {
    // coalesce all concurrent misses into a single rebuild so N SongRows
    // waiting on empty registry only call findPlaylistDoc once.
    if (!_registryRebuildPromise) {
      _registryRebuildPromise = (async () => {
        const entries = await getAllDocIndexEntries();
        for (const entry of entries) {
          try {
            const handle = await findPlaylistDoc(entry.docId as AutomergeUrl);
            const raw = handle.doc();
            if (!raw) continue;
            registerDocSongs(entry.docId, parsePlaylistDoc(raw));
          } catch {
            continue;
          }
        }
      })().finally(() => {
        _registryRebuildPromise = null;
      });
    }
    await _registryRebuildPromise;
    reg = songRegistry.get(songId);
  }

  if (!reg) return null;
  return hydrateSongImage(songEntryToSong(reg.entry, reg.docId, reg.index));
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
  log.trace("playlist.doc", "createPlaylist", fields.title ?? "(untitled)");
  const { docId, handle } = createPlaylistDoc(
    emptyPlaylistDoc({
      title: fields.title ?? "new playlist",
      description: fields.description ?? "",
    })
  );

  const entry: DocIndexEntry = {
    docId,
    title: fields.title ?? "new playlist",
    addedAt: Date.now(),
    source: "local",
  };
  await addDocIndexEntry(entry);

  const raw = handle.doc();
  const doc = parsePlaylistDoc(raw ?? {});
  await flushDoc(docId);
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
    bgSize?: string;
    bgPosition?: string;
    bgRepeat?: string;
  }
): Promise<void> {
  log.trace("playlist.doc", "updatePlaylist", docId);
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  const { rev: _rev, ...metadataFields } = toPlain(fields);
  handle.change((doc) => setMetadata(doc, metadataFields));
  await flushDoc(docId as AutomergeUrl);
  // update docIndex title if title changed
  if (fields.title !== undefined) {
    log.trace("playlist.doc", "updatePlaylist: title changed, updating docIndex");
    const existing = await getDocIndexEntry(docId);
    if (existing) {
      await addDocIndexEntry({ ...existing, title: fields.title });
    }
  }
}

// collect all sha256 refs across all docs except the given one.
// used for blob GC before deleting a doc.
async function shaRefsExcluding(excludeDocId: string): Promise<Set<string>> {
  const entries = await getAllDocIndexEntries();
  const refs = new Set<string>();
  await Promise.allSettled(
    entries
      .filter((e) => e.docId !== excludeDocId)
      .map(async (e) => {
        try {
          const h = await findPlaylistDoc(e.docId as AutomergeUrl);
          const raw = h.doc();
          if (!raw) return;
          const doc = parsePlaylistDoc(raw);
          for (const song of Object.values(doc.songs)) {
            if (song?.sha256) refs.add(song.sha256);
            for (const img of song?.images ?? []) refs.add(img.blobId);
          }
          for (const img of doc.images ?? []) refs.add(img.blobId);
        } catch { /* ignore unavailable docs */ }
      })
  );
  return refs;
}

// tombstone and remove a playlist doc from the local repo and docIndex.
export async function deletePlaylist(docId: string): Promise<void> {
  // collect sha refs from the doc being deleted before it's gone
  let deletedShas: string[] = [];
  try {
    const handle = await findPlaylistDoc(docId as AutomergeUrl);
    const raw = handle.doc();
    if (raw) {
      const doc = parsePlaylistDoc(raw);
      for (const song of Object.values(doc.songs)) {
        if (song?.sha256) deletedShas.push(song.sha256);
        for (const img of song?.images ?? []) deletedShas.push(img.blobId);
      }
      for (const img of doc.images ?? []) deletedShas.push(img.blobId);
    }
  } catch { /* best-effort */ }

  await deletePlaylistDoc(docId as AutomergeUrl);
  await removeDocIndexEntry(docId);
  // clear all songs for this doc from the registry
  for (const [id, reg] of songRegistry.entries()) {
    if (reg.docId === docId) {
      songRegistry.delete(id);
    }
  }

  // gc: delete blobs not referenced by any other playlist
  if (deletedShas.length > 0) {
    const stillReferenced = await shaRefsExcluding(docId);
    await Promise.allSettled(
      deletedShas
        .filter((sha) => !stillReferenced.has(sha))
        .map((sha) => deleteBlob(sha))
    );
  }
}

// add a song to a playlist doc.
// audio bytes are stored in the blob store; the doc carries only metadata + sha256.
export async function forkPlaylist(docId: string): Promise<Playlist> {
  const sourceHandle = await findPlaylistDoc(docId as AutomergeUrl);
  const raw = sourceHandle.doc();
  const sourceDoc = parsePlaylistDoc(raw ?? {});

  // build a fresh doc from the snapshot - strip peer/acl maps so it's fully local.
  // filter out undefined fields so automerge doesn't reject them (it does not
  // allow undefined values; emptyPlaylistDoc's defaults fill any gaps).
  const overrides = Object.fromEntries(
    Object.entries({
      title: sourceDoc.title,
      description: sourceDoc.description,
      images: sourceDoc.images,
      urls: sourceDoc.urls,
      songs: sourceDoc.songs,
      order: sourceDoc.order,
      bgFilterEnabled: sourceDoc.bgFilterEnabled,
      bgFilterBlur: sourceDoc.bgFilterBlur,
      bgFilterContrast: sourceDoc.bgFilterContrast,
      bgFilterBrightness: sourceDoc.bgFilterBrightness,
      coverFilterEnabled: sourceDoc.coverFilterEnabled,
      coverFilterBlur: sourceDoc.coverFilterBlur,
      bgSize: sourceDoc.bgSize,
      bgPosition: sourceDoc.bgPosition,
      bgRepeat: sourceDoc.bgRepeat,
      // do not copy peers/acl/sharingMode - this is a local fork
    }).filter(([, v]) => v !== undefined)
  );
  const seed = emptyPlaylistDoc(overrides);
  const { docId: newDocId, handle } = createPlaylistDoc(seed);

  await addDocIndexEntry({
    docId: newDocId,
    title: sourceDoc.title || "forked playlist",
    addedAt: Date.now(),
    source: "local",
  });

  // mark the original docIndex entry as forked so the UI knows
  const existing = await getDocIndexEntry(docId);
  if (existing) {
    await addDocIndexEntry({ ...existing, isForked: true });
  }

  const newDoc = parsePlaylistDoc(handle.doc() ?? {});
  await flushDoc(newDocId as AutomergeUrl);
  registerDocSongs(newDocId, newDoc);
  return docToPlaylist(newDocId, newDoc);
}

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

  // dedup: if a song with this sha already exists in the doc, return it
  const existingRaw = handle.doc();
  const existingDoc = parsePlaylistDoc(existingRaw ?? {});
  const dupId = Object.keys(existingDoc.songs).find(
    (id) => existingDoc.songs[id]?.sha256 === sha256
  );
  if (dupId) {
    log.debug("playlist.doc", "addSongToPlaylist: dedup, sha already in doc", sha256);
    const dupIndex = existingDoc.order.indexOf(dupId);
    return hydrateSongImage(
      songEntryToSong(existingDoc.songs[dupId]!, docId, dupIndex >= 0 ? dupIndex : 0)
    );
  }

  handle.change((doc) => upsertSong(doc, toPlain(entry)));
  await flushDoc(docId as AutomergeUrl);

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
  log.trace("playlist.doc", "updateSongInDoc", docId, songId);
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
  await flushDoc(docId as AutomergeUrl);

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
  await flushDoc(docId as AutomergeUrl);
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
  await flushDoc(docId as AutomergeUrl);

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
  await flushDoc(docId as AutomergeUrl);
}

// remove all playlist-level cover images from the doc.
// blob store bytes are not deleted (they may be referenced elsewhere).
export async function clearPlaylistCoverImage(docId: string): Promise<void> {
  const handle = await findPlaylistDoc(docId as AutomergeUrl);
  handle.change((doc) => {
    doc.images.splice(0, doc.images.length);
  });
  await flushDoc(docId as AutomergeUrl);
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
  await flushDoc(docId as AutomergeUrl);

  triggerSpecificSongUpdate(songId);
}

// expose calculateSHA256 re-export for callers that already have the bytes
export { calculateSHA256 };
