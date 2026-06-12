// dev-only mock implementations for blob transfer.
//
// this file is only loaded in DEV builds (imported by src/dev-hooks.ts which
// is dynamically imported under import.meta.env.DEV). never bundled for prod.
//
// exports a single factory function that creates the mock fetch override.
// the factory is called by dev-hooks.ts which also manages the active
// behaviour state and the window hook registration.

import {
  _devSetFetchOverride,
  _devSetBlobFetchTimeout,
  _devEvictBlob,
  _devFetchBlobBySha,
  type BlobFetchProgress,
} from "./blobTransferService.js";
import { storeBlob } from "freqhole-api-client/storage";

// the behaviour union mirrors global.d.ts Window["__mockBlobFetch"] parameter.
// keeping it here means the mock impl and its type live together.
export type MockBlobBehaviour = NonNullable<
  Window["__mockBlobFetch"]
> extends (b: infer B) => void
  ? B
  : never;

// --- synthetic blob data ---

// build a minimal valid 1s mono 16-bit PCM WAV (silence).
// used as a stand-in blob so the audio element gets something it can decode.
function makeSyntheticWav(): Uint8Array {
  const samples = 8000;
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const s = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  s(0, "RIFF"); v.setUint32(4, 36 + dataSize, true);
  s(8, "WAVE"); s(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);  // PCM mono
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); // 8kHz
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); s(36, "data");
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

// --- mock fetch implementation ---

async function mockFetchBlob(
  sha256: string,
  mimeType: string,
  onProgress: ((p: BlobFetchProgress) => void) | undefined,
  behaviour: MockBlobBehaviour
): Promise<string | null> {
  if (behaviour.type === "error") {
    throw new Error(`mock blob error: ${behaviour.code}`);
  }

  if (behaviour.type === "stall") {
    // hangs until the test clears the mock or the fetch timeout fires
    return new Promise<string | null>(() => {});
  }

  const bytes = makeSyntheticWav();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  const total = blob.size;

  if (behaviour.type === "instant") {
    await storeBlob(blob, mimeType);
    return sha256;
  }

  if (behaviour.type === "delayed") {
    await new Promise<void>((res) => setTimeout(res, behaviour.ms));
    await storeBlob(blob, mimeType);
    return sha256;
  }

  if (behaviour.type === "progress") {
    const chunkSize = Math.ceil(total / behaviour.chunks);
    let offset = 0;
    for (let i = 0; i < behaviour.chunks; i++) {
      await new Promise<void>((res) => setTimeout(res, behaviour.msPerChunk));
      offset = Math.min(offset + chunkSize, total);
      onProgress?.({ sha256, fraction: offset / total });
    }
    await storeBlob(blob, mimeType);
    return sha256;
  }

  return null;
}

// --- window hook registration ---

// call this once at app startup (from dev-hooks.ts) to register all blob
// transport mock hooks on the window object.
export function registerBlobDevHooks(): void {
  let activeBehaviour: MockBlobBehaviour | null = null;

  window.__mockBlobFetch = (behaviour) => {
    activeBehaviour = behaviour;
    _devSetFetchOverride((sha256, mimeType, onProgress) => {
      if (!activeBehaviour) return Promise.resolve(null);
      return mockFetchBlob(sha256, mimeType, onProgress, activeBehaviour);
    });
  };

  window.__clearMockBlobFetch = () => {
    activeBehaviour = null;
    _devSetFetchOverride(null);
  };

  window.__evictBlob = _devEvictBlob;
  window.__setBlobFetchTimeout = _devSetBlobFetchTimeout;
  window.__fetchBlobBySha = _devFetchBlobBySha;
}
