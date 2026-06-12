// dev-only module: registers window.__* test hooks.
//
// this file is dynamically imported only when import.meta.env.DEV is true
// (see src/components/index.tsx). it is never present in production builds.
//
// all mock implementations live here - nothing in the production service
// files knows about mock behaviour, synthetic blobs, or window assignment.

import {
  _devSeekTo,
  _devTriggerTrackEnd,
  _devTriggerAudioError,
} from "./services/audioService.js";
import {
  _devSetFetchOverride,
  _devEvictBlob,
  _devSetBlobFetchTimeout,
  _devFetchBlobBySha,
  type BlobFetchProgress,
} from "./services/blobTransferService.js";
import { storeBlob } from "freqhole-api-client/storage";

// --- synthetic audio ---

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

type MockBlobBehaviour = NonNullable<Window["__mockBlobFetch"]> extends (b: infer B) => void ? B : never;

async function mockFetchBlob(
  sha256: string,
  mimeType: string,
  onProgress?: (p: BlobFetchProgress) => void
): Promise<string | null> {
  const b = activeBehaviour;
  if (!b) return null;

  if (b.type === "error") {
    throw new Error(`mock blob error: ${b.code}`);
  }

  if (b.type === "stall") {
    // hangs until the test clears the mock or the test times out
    return new Promise<string | null>(() => {});
  }

  const bytes = makeSyntheticWav();
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  const total = blob.size;

  if (b.type === "instant") {
    await storeBlob(blob, mimeType);
    return sha256;
  }

  if (b.type === "delayed") {
    await new Promise<void>((res) => setTimeout(res, b.ms));
    await storeBlob(blob, mimeType);
    return sha256;
  }

  if (b.type === "progress") {
    const chunkSize = Math.ceil(total / b.chunks);
    let offset = 0;
    for (let i = 0; i < b.chunks; i++) {
      await new Promise<void>((res) => setTimeout(res, b.msPerChunk));
      offset = Math.min(offset + chunkSize, total);
      onProgress?.({ sha256, fraction: offset / total });
    }
    await storeBlob(blob, mimeType);
    return sha256;
  }

  return null;
}

// active mock behaviour - null means use the real p2p transport
let activeBehaviour: MockBlobBehaviour | null = null;

// --- register window hooks ---

// audio element control
window.__seekTo = _devSeekTo;
window.__triggerTrackEnd = _devTriggerTrackEnd;
window.__triggerAudioError = _devTriggerAudioError;

// blob store control
window.__evictBlob = _devEvictBlob;

window.__mockBlobFetch = (behaviour) => {
  activeBehaviour = behaviour;
  _devSetFetchOverride((sha256, mimeType, onProgress) =>
    mockFetchBlob(sha256, mimeType, onProgress)
  );
};

window.__clearMockBlobFetch = () => {
  activeBehaviour = null;
  _devSetFetchOverride(null);
};

window.__setBlobFetchTimeout = _devSetBlobFetchTimeout;
window.__fetchBlobBySha = _devFetchBlobBySha;
