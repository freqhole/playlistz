
import { render } from "solid-js/web";
import { Playlistz } from "./components/index.js";
import { FreqholePlaylistzSchema } from "./utils/standaloneTemplates.js";
import { initializeStandalonePlaylist } from "./services/standaloneService.js";
import "./styles.css";

customElements.define(
  "freqhole-playlistz",
  class extends HTMLElement {
    connectedCallback() {
      render(() => <Playlistz />, this);

      // if standalone playlist data was set before the component mounted, initialize it now
      if (typeof window !== "undefined" && window.__PLAYLISTZ__) {
        const result = FreqholePlaylistzSchema.safeParse(window.__PLAYLISTZ__);
        if (!result.success) {
          console.error("invalid window.__PLAYLISTZ__ data:", result.error);
          return;
        }
        for (const entry of result.data) {
          initializeStandalonePlaylist(entry, {
            setSelectedPlaylist: () => {},
            setPlaylistSongs: () => {},
            setSidebarCollapsed: () => {},
            setError: (err) => console.error("standalone init error:", err),
          }).catch((err) => console.error("standalone init failed:", err));
        }
      }
    }
  }
);
