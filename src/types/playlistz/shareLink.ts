// share token encoding/decoding for playlistz p2p sharing.
// versioned base64url payload, no padding.
// format: base64url({ v: 1, n: nodeId, d: docId, t?: titleHint })
// url fragment: #share/<token>
import * as z from "zod";

// v1 share payload: node id, doc id, optional title hint, optional mode hint
const SharePayloadV1Schema = z.object({
  v: z.literal(1),
  n: z.string().min(1),
  d: z.string().min(1),
  t: z.string().optional(),
  m: z.enum(["public", "knock"]).optional(), // sharing mode at link-creation time
});
export type SharePayloadV1 = z.infer<typeof SharePayloadV1Schema>;

// convert standard base64 to base64url (no padding)
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// normalize base64url back to standard base64 for decoding
function fromBase64Url(b64url: string): string {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  // re-add padding
  while (s.length % 4 !== 0) {
    s += "=";
  }
  return s;
}

// encode a share payload to a base64url token (no padding)
export function encodeShareToken(payload: SharePayloadV1): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(json);
  return toBase64Url(b64);
}

// decode a share token back to a SharePayloadV1.
// forgiving: strips whitespace, full urls, "#share/" and "share/" prefixes.
// accepts both base64 and base64url.
// returns null on anything invalid.
export function decodeShareToken(input: string): SharePayloadV1 | null {
  try {
    let raw = input.trim();

    // strip full url up to and including the #share/ fragment
    const hashIdx = raw.indexOf("#share/");
    if (hashIdx !== -1) {
      raw = raw.slice(hashIdx + 7);
    } else if (raw.startsWith("share/")) {
      raw = raw.slice(6);
    }

    // strip any trailing fragment or query that may have been appended
    const ampIdx = raw.indexOf("&");
    if (ampIdx !== -1) raw = raw.slice(0, ampIdx);

    if (!raw) return null;

    const b64 = fromBase64Url(raw);
    const json = atob(b64);
    const parsed: unknown = JSON.parse(json);

    const result = SharePayloadV1Schema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

// build a url fragment for embedding in window.location.hash
export function shareFragment(payload: SharePayloadV1): string {
  return `#share/${encodeShareToken(payload)}`;
}
