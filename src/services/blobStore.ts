// local blob storage for playlistz - audio files, song art, and playlist
// covers. bytes live in a content-addressed store shared with the rest of
// the freqhole world; metadata is keyed the way playlistz docs have
// always addressed media: by sha256.
//
// the underlying store is blake3-canonical (it hashes and indexes both
// blake3 and sha256 for every write), but every function here keeps the
// sha256-in, sha256-out contract playlist docs already rely on - a song's
// `sha256` field is exactly the id this module hands back from
// `storeBlob` and expects everywhere else.

import { createBlobStore } from "@freqhole/reliquary/blobs";

const store = createBlobStore({
  dbName: "freqhole_blobs",
  allowCacheFallback: true,
});

export interface BlobRecord {
  blob_id: string;
  mime_type: string;
  file_size: number;
  created_at: number;
}

/**
 * store a blob and return its sha256 id.
 */
export async function storeBlob(data: Blob, mimeType: string): Promise<string> {
  const buffer = await data.arrayBuffer();
  const record = await store.storeBlob(buffer, {
    filename: "",
    mime: mimeType,
  });
  // sha256 is always computed for a direct (non-streamed) storeBlob call -
  // return it so callers keep addressing this blob the way they always
  // have, even though the store's own primary key is now blake3.
  return record.sha256 ?? record.blake3;
}

/**
 * get blob data by sha256 id.
 */
export function getBlob(blobId: string): Promise<Blob | null> {
  return store.getBlob(blobId);
}

/**
 * get blob metadata by sha256 id.
 */
export async function getBlobMetadata(
  blobId: string
): Promise<BlobRecord | null> {
  const record = await store.getBlobMetadata(blobId);
  if (!record) return null;
  return {
    blob_id: record.blob_id,
    mime_type: record.mime,
    file_size: record.size,
    created_at: record.created_at,
  };
}

/**
 * get a cached object URL for a blob by sha256 id, or null if not stored.
 */
export function getBlobObjectURL(blobId: string): Promise<string | null> {
  return store.getBlobObjectURL(blobId);
}

/**
 * delete a blob by sha256 id.
 */
export async function deleteBlob(blobId: string): Promise<void> {
  const record = await store.resolveBlob(blobId);
  if (record) await store.deleteBlob(record.blob_id);
}
