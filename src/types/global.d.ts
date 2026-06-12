// global type declarations for playlistz

import type { FreqholePlaylistz } from "../utils/standaloneTemplates.js";

// behaviour modes for the __mockBlobFetch dev hook
type MockBlobBehaviour =
  | { type: "instant" }
  | { type: "delayed"; ms: number }
  | { type: "progress"; chunks: number; msPerChunk: number }
  | { type: "error"; code: "not_found" | "timeout" | "peer_gone" }
  | { type: "stall" };

declare global {
  interface Window {
    __PLAYLISTZ__?: FreqholePlaylistz;
    STANDALONE_MODE?: boolean;
    DEFERRED_PLAYLIST_DATA?: FreqholePlaylistz;

    // dev/test hooks (DEV builds only - not present in production)

    // file import hook (set in components/index.tsx)
    __processFiles?: (files: File[]) => Promise<void>;

    // audio element control
    __seekTo?: (seconds: number) => void;
    __triggerTrackEnd?: () => void;
    __triggerAudioError?: (code?: number) => void;

    // blob store control
    __evictBlob?: (sha256: string) => Promise<void>;
    __mockBlobFetch?: (behaviour: MockBlobBehaviour) => void;
    __clearMockBlobFetch?: () => void;
    __setBlobFetchTimeout?: (ms: number) => void;
    __fetchBlobBySha?: (sha256: string) => Promise<string | null>;
  }
}

export {};
