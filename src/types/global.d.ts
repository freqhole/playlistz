// global type declarations for playlistz

import type { FreqholePlaylistz } from "../utils/standaloneTemplates.js";

declare global {
  interface Window {
    __PLAYLISTZ__?: FreqholePlaylistz;
  }
}

export {};
