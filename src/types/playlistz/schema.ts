// zod schemas for the playlistz automerge document model.
// plain objects + zod only - no automerge imports.
import * as z from "zod";

// the set of blob types a stored binary can represent
export const BlobKindSchema = z.union([
  z.literal("original"),
  z.literal("thumbnail"),
  z.literal("waveform"),
  z.literal("preview"),
]);
export type BlobKind = z.infer<typeof BlobKindSchema>;

// a reference to a binary stored in the blob store, keyed by sha256
export const ImageRefSchema = z.object({
  blobId: z.string(),
  isPrimary: z.boolean(),
  blobType: BlobKindSchema,
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

// a named url associated with a playlist or song
export const EntityUrlSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  url: z.string(),
});
export type EntityUrl = z.infer<typeof EntityUrlSchema>;

// a single song as stored in the playlist doc
export const SongEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  duration: z.number(),
  mimeType: z.string(),
  fileSize: z.number(),
  sha256: z.string(),
  blake3: z.string().optional(),
  images: z.array(ImageRefSchema).default([]),
  urls: z.array(EntityUrlSchema).default([]),
  lyrics: z.string().optional(),
});
export type SongEntry = z.infer<typeof SongEntrySchema>;

// the top-level automerge document for a playlist.
// all fields have defaults so schema.parse({}) succeeds for graceful degradation.
export const PlaylistDocSchema = z.object({
  version: z.literal(1).default(1),
  title: z.string().default(""),
  description: z.string().default(""),
  createdAt: z.string().default(() => new Date().toISOString()),
  lastModified: z.string().default(() => new Date().toISOString()),
  lastModifiedBy: z.string().default(""),
  images: z.array(ImageRefSchema).default([]),
  urls: z.array(EntityUrlSchema).default([]),
  songs: z.record(z.string(), SongEntrySchema).default({}),
  order: z.array(z.string()).default([]),
  peers: z
    .record(
      z.string(),
      z.object({
        nodeId: z.string(),
        joinedAt: z.string(),
        lastSeenAt: z.string().optional(),
      })
    )
    .default({}),
  acl: z
    .record(
      z.string(),
      z.object({
        role: z.union([
          z.literal("owner"),
          z.literal("editor"),
          z.literal("viewer"),
        ]),
      })
    )
    .optional(),
  deleted: z.boolean().optional(),
  // per-playlist sharing mode. unset = private (not shared).
  sharingMode: z.union([z.literal("public"), z.literal("knock")]).optional(),
  // when true, subscribers may edit the playlist in place and their changes
  // sync back to peers. when false/unset, subscriptions are read-only (fork to edit).
  collaborative: z.boolean().optional(),
  // display filter settings for the playlist background and cover
  bgFilterEnabled: z.boolean().optional(),
  bgFilterBlur: z.number().optional(),
  bgFilterContrast: z.number().optional(),
  bgFilterBrightness: z.number().optional(),
  coverFilterEnabled: z.boolean().optional(),
  coverFilterBlur: z.number().optional(),
  // background image layout
  bgSize: z.string().optional(), // css background-size, default: "cover"
  bgPosition: z.string().optional(), // css background-position, default: "top"
  bgRepeat: z.string().optional(), // css background-repeat, default: "no-repeat"
});
export type PlaylistDoc = z.infer<typeof PlaylistDocSchema>;

// recursively copy an object keeping only string-keyed enumerable props.
// automerge doc proxies carry symbol keys (_am_objectId, _am_datatype_) that
// zod records reject, so raw docs are plainified before parsing.
function plainify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainify);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = plainify((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// parse raw unknown data into a PlaylistDoc.
// on failure, logs a warning and returns schema defaults (graceful degradation).
export function parsePlaylistDoc(raw: unknown): PlaylistDoc {
  try {
    return PlaylistDocSchema.parse(plainify(raw ?? {}));
  } catch (err) {
    console.warn(
      "[playlistz:schema] parse failed - falling back to defaults. error:",
      err instanceof z.ZodError ? err.issues : err,
      "raw keys:",
      raw && typeof raw === "object" ? Object.keys(raw) : "null"
    );
    return PlaylistDocSchema.parse({});
  }
}

// create an empty PlaylistDoc, optionally merged with caller-supplied fields.
export function emptyPlaylistDoc(init?: Partial<PlaylistDoc>): PlaylistDoc {
  const now = new Date().toISOString();
  return PlaylistDocSchema.parse({
    createdAt: now,
    lastModified: now,
    ...init,
  });
}
