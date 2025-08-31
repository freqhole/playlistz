// Global type declarations for playlistz

import type { StandaloneData } from "../services/standaloneService.js";

declare global {
  interface Window {
    STANDALONE_MODE?: boolean;
    DEFERRED_PLAYLIST_DATA?: StandaloneData;
    initializeStandalonePlaylist?: (playlistData: StandaloneData) => void;
  }
}

// This export is needed to make this file a module
export {};
