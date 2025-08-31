// Global type declarations for playlistz

declare global {
  interface Window {
    STANDALONE_MODE?: boolean;
    DEFERRED_PLAYLIST_DATA?: unknown;
    initializeStandalonePlaylist?: (playlistData: unknown) => void;
  }
}

// This export is needed to make this file a module
export {};
