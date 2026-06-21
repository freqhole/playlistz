// freqhole-playlistz/1 discovery and knock protocol.
// zod-validated message envelopes + BiStream encode/decode helpers.
// no midden or automerge imports.
import * as z from "zod";

// ALPN strings used when registering iroh endpoints
export const PLAYLISTZ_ALPN = "freqhole-playlistz/1";
export const AUTOMERGE_ALPN = "iroh/automerge-repo/1";

// ---- message schemas ----

const HelloSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  nodeId: z.string(),
  name: z.string().optional(),
  avatarBlobId: z.string().optional(),
});

const HelloOkSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello_ok"),
  nodeId: z.string(),
  name: z.string().optional(),
  avatarDataUrl: z.string().optional(),
  public: z.boolean(),
});

const ListPlaylistsSchema = z.object({
  v: z.literal(1),
  type: z.literal("list_playlists"),
});

const PlaylistItemSchema = z.object({
  docId: z.string(),
  title: z.string(),
  songCount: z.number(),
});

const PlaylistsSchema = z.object({
  v: z.literal(1),
  type: z.literal("playlists"),
  items: z.array(PlaylistItemSchema),
});

const KnockSchema = z.object({
  v: z.literal(1),
  type: z.literal("knock"),
  nodeId: z.string(),
  name: z.string().optional(),
  message: z.string().optional(),
  knockType: z.enum(["browse", "doc_access"]).optional(), // default: "browse"
  docId: z.string().optional(), // present when knockType is "doc_access"
});

const KnockStatusSchema = z.object({
  v: z.literal(1),
  type: z.literal("knock_status"),
  status: z.union([
    z.literal("pending"),
    z.literal("accepted"),
    z.literal("denied"),
  ]),
  grantedDocIds: z.array(z.string()).optional(),
});

// ask a peer to make a blob available for iroh-blobs verified download.
// sha256 is the blob store key carried in playlist docs.
const BlobRequestSchema = z.object({
  v: z.literal(1),
  type: z.literal("blob_request"),
  sha256: z.string(),
});

// reply: the peer imported the blob into its iroh-blobs store.
// blake3 + size are what download_verified_streaming needs.
const BlobReadySchema = z.object({
  v: z.literal(1),
  type: z.literal("blob_ready"),
  sha256: z.string(),
  blake3: z.string(),
  size: z.number(),
});

const ErrorSchema = z.object({
  v: z.literal(1),
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

// proactive acceptance notification: owner opens a stream to the peer and
// sends this after accepting their knock, so the peer doesn't have to poll.
const KnockNotifySchema = z.object({
  v: z.literal(1),
  type: z.literal("knock_notify"),
  status: z.literal("accepted"),
  docIds: z.array(z.string()),
  ownerNodeId: z.string(),
});

// proactive identity update: a peer broadcasts their current name/avatar
// to all peers they have established connections with.
const IdentityUpdateSchema = z.object({
  v: z.literal(1),
  type: z.literal("identity_update"),
  name: z.string().optional(),
  avatarDataUrl: z.string().optional(),
});

// discriminated union of all protocol messages
export const MessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HelloOkSchema,
  ListPlaylistsSchema,
  PlaylistsSchema,
  KnockSchema,
  KnockStatusSchema,
  BlobRequestSchema,
  BlobReadySchema,
  ErrorSchema,
  KnockNotifySchema,
  IdentityUpdateSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

// convenience inferred types per message kind
export type HelloMessage = z.infer<typeof HelloSchema>;
export type HelloOkMessage = z.infer<typeof HelloOkSchema>;
export type ListPlaylistsMessage = z.infer<typeof ListPlaylistsSchema>;
export type PlaylistsMessage = z.infer<typeof PlaylistsSchema>;
export type KnockMessage = z.infer<typeof KnockSchema>;
export type KnockStatusMessage = z.infer<typeof KnockStatusSchema>;
export type BlobRequestMessage = z.infer<typeof BlobRequestSchema>;
export type BlobReadyMessage = z.infer<typeof BlobReadySchema>;
export type ErrorMessage = z.infer<typeof ErrorSchema>;
export type KnockNotifyMessage = z.infer<typeof KnockNotifySchema>;

// ---- BiStream structural interface ----
// matches the shape provided by midden without importing it

export interface BiStreamLike {
  write_message(data: Uint8Array): Promise<void>;
  read_message(): Promise<Uint8Array | null>;
  close(): void;
  peer_node_id(): string;
  alpn(): string;
}

// ---- codec ----

// error thrown when decoding an invalid or unrecognized message
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// serialize a message to utf-8 JSON bytes
export function encodeMessage(msg: Message): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

// parse utf-8 JSON bytes back to a Message.
// throws ProtocolError with a descriptive code on invalid input.
export function decodeMessage(bytes: Uint8Array): Message {
  let json: string;
  try {
    json = decoder.decode(bytes);
  } catch (err) {
    throw new ProtocolError(
      "decode_error",
      `failed to decode utf-8: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ProtocolError(
      "parse_error",
      `failed to parse json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = MessageSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new ProtocolError(
      "schema_error",
      `invalid message: ${firstIssue?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

// write a message to a BiStream
export async function sendMessage(
  stream: BiStreamLike,
  msg: Message,
): Promise<void> {
  await stream.write_message(encodeMessage(msg));
}

// read the next message from a BiStream.
// returns null on clean EOF (read_message returned null).
// throws ProtocolError on invalid data.
export async function readMessage(
  stream: BiStreamLike,
): Promise<Message | null> {
  const bytes = await stream.read_message();
  if (bytes === null) return null;
  return decodeMessage(bytes);
}
