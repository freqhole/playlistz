// re-export shim - the helpers have been split into e2e/helpers/:
//
//   helpers/media.ts  - makeWav, fixture loading (no Page deps)
//   helpers/app.ts    - resetAppState, createPlaylistViaUI, addSongs, etc.
//   helpers/hooks.ts  - window.__* dev hook wrappers + MockBlobBehaviour type
//
// existing spec imports ("./helpers.js") continue to work unchanged.
// new spec files should import directly from the sub-modules for clarity.

export * from "./helpers/index.js";
