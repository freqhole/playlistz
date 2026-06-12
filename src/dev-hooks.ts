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

registerAudioDevHooks();
registerBlobDevHooks();
