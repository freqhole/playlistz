// pure mutation helpers for PlaylistDoc.
// each function mutates the doc draft in place - safe to call inside handle.change().
// no automerge imports: these are plain object mutations over plain objects.
import type { PlaylistDoc, SongEntry, ImageRef } from "./schema.js";

function nowIso(): string {
  return new Date().toISOString();
}

// bump lastModified to now, optionally setting lastModifiedBy
function bumpModified(doc: PlaylistDoc, by?: string): void {
  doc.lastModified = nowIso();
  if (by !== undefined) {
    doc.lastModifiedBy = by;
  }
}

// insert or replace a song in the doc, appending its id to order if not already present
export function upsertSong(doc: PlaylistDoc, song: SongEntry, by?: string): void {
  doc.songs[song.id] = song;
  if (!doc.order.includes(song.id)) {
    doc.order.push(song.id);
  }
  bumpModified(doc, by);
}

// remove a song from songs and order
export function removeSong(doc: PlaylistDoc, songId: string, by?: string): void {
  delete doc.songs[songId];
  const idx = doc.order.indexOf(songId);
  if (idx !== -1) {
    doc.order.splice(idx, 1);
  }
  bumpModified(doc, by);
}

// move a single song to a target index within order.
// single-item splice keeps automerge merge semantics sane.
export function reorderSongs(
  doc: PlaylistDoc,
  songId: string,
  toIndex: number,
  by?: string,
): void {
  const fromIdx = doc.order.indexOf(songId);
  if (fromIdx === -1) return;
  doc.order.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(toIndex, doc.order.length));
  doc.order.splice(clamped, 0, songId);
  bumpModified(doc, by);
}

// playlist metadata fields settable via setMetadata
type MetadataFields = Partial<
  Pick<
    PlaylistDoc,
    | "title"
    | "description"
    | "bgFilterEnabled"
    | "bgFilterBlur"
    | "bgFilterContrast"
    | "bgFilterBrightness"
    | "coverFilterEnabled"
    | "coverFilterBlur"
    | "bgSize"
    | "bgPosition"
    | "bgRepeat"
  >
>;

// update playlist-level metadata fields
export function setMetadata(
  doc: PlaylistDoc,
  fields: MetadataFields,
  by?: string,
): void {
  if (fields.title !== undefined) doc.title = fields.title;
  if (fields.description !== undefined) doc.description = fields.description;
  for (const key of [
    "bgFilterEnabled",
    "bgFilterBlur",
    "bgFilterContrast",
    "bgFilterBrightness",
    "coverFilterEnabled",
    "coverFilterBlur",
    "bgSize",
    "bgPosition",
    "bgRepeat",
  ] as const) {
    if (fields[key] !== undefined) {
      // assignment is type-safe per key; typescript can't narrow the loop var
      (doc as Record<string, unknown>)[key] = fields[key];
    }
  }
  bumpModified(doc, by);
}

// add an image ref to the playlist or to a specific song.
// if ref.isPrimary is true, clears isPrimary on all sibling images first.
export function addImage(
  doc: PlaylistDoc,
  ref: ImageRef,
  target?: { songId?: string },
  by?: string,
): void {
  const images =
    target?.songId != null
      ? doc.songs[target.songId]?.images
      : doc.images;

  if (!images) return;

  if (ref.isPrimary) {
    for (const img of images) {
      img.isPrimary = false;
    }
  }
  images.push(ref);
  bumpModified(doc, by);
}

// set the primary image by blobId, clearing isPrimary on all others.
// operates on playlist images or a specific song's images.
export function setPrimaryImage(
  doc: PlaylistDoc,
  blobId: string,
  target?: { songId?: string },
  by?: string,
): void {
  const images =
    target?.songId != null
      ? doc.songs[target.songId]?.images
      : doc.images;

  if (!images) return;

  for (const img of images) {
    img.isPrimary = img.blobId === blobId;
  }
  bumpModified(doc, by);
}

// record a peer joining this doc. idempotent - no-op if peer is already present.
// does not bump lastModified (peer bookkeeping is not a content edit).
export function addPeer(doc: PlaylistDoc, nodeId: string): void {
  if (doc.peers[nodeId]) return;
  doc.peers[nodeId] = {
    nodeId,
    joinedAt: nowIso(),
  };
}

// update lastSeenAt for an existing peer entry.
// does not bump lastModified (ephemeral presence, not a content edit).
export function stampLastSeen(doc: PlaylistDoc, nodeId: string): void {
  const peer = doc.peers[nodeId];
  if (peer) {
    peer.lastSeenAt = nowIso();
  }
}

// set or update the access role for a node in the acl
export function setAclRole(
  doc: PlaylistDoc,
  nodeId: string,
  role: "owner" | "editor" | "viewer",
  by?: string,
): void {
  if (!doc.acl) {
    doc.acl = {};
  }
  doc.acl[nodeId] = { role };
  bumpModified(doc, by);
}

// mark this playlist as deleted (tombstone).
// the doc remains in the repo; consumers check deleted before rendering.
export function tombstone(doc: PlaylistDoc, by?: string): void {
  doc.deleted = true;
  bumpModified(doc, by);
}
