// dev-only module: registers window.__* test hooks.
//
// this file is dynamically imported only when import.meta.env.DEV is true
// (see src/components/index.tsx). never present in production builds.
//
// the actual mock implementations live next to their service:
//   src/services/audioService.dev.ts       - __seekTo, __triggerTrackEnd, __triggerAudioError
//   src/services/blobTransferService.dev.ts - __mockBlobFetch, __clearMockBlobFetch,
//                                             __evictBlob, __setBlobFetchTimeout, __fetchBlobBySha
//
// this file only imports and calls the register functions.

import { registerAudioDevHooks } from "./services/audioService.dev.js";
import { registerBlobDevHooks } from "./services/blobTransferService.dev.js";
import { getAllDocIndexEntries, addDocIndexEntry } from "./services/docIndexService.js";
import type { DocIndexEntry } from "./services/indexedDBService.js";

registerAudioDevHooks();
registerBlobDevHooks();

// docIndex test hooks: allow e2e tests to read/patch docIndex entries without
// raw idb access, so they use the same service layer as the app.
(window as Window & {
  __getDocIndexEntries?: () => Promise<DocIndexEntry[]>;
  __patchDocIndexEntry?: (docId: string, patch: Partial<DocIndexEntry>) => Promise<void>;
}).__getDocIndexEntries = getAllDocIndexEntries;

(window as Window & {
  __patchDocIndexEntry?: (docId: string, patch: Partial<DocIndexEntry>) => Promise<void>;
}).__patchDocIndexEntry = async (docId: string, patch: unknown) => {
  const entries = await getAllDocIndexEntries();
  const existing = entries.find((e) => e.docId === docId);
  if (!existing) throw new Error(`docIndex entry not found: ${docId}`);
  await addDocIndexEntry({ ...existing, ...(patch as Partial<DocIndexEntry>) });
};
