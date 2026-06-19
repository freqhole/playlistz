import { render } from "solid-js/web";
import { Playlistz } from "./components/index.js";
import { FreqholePlaylistzSchema } from "./utils/standaloneTemplates.js";
import { initializeStandalonePlaylist } from "./services/standaloneService.js";
import "./styles.css";

customElements.define(
  "freqhole-playlistz",
  class extends HTMLElement {
    static get observedAttributes() {
      return ["data-playlistz"];
    }

    connectedCallback() {
      render(() => <Playlistz />, this);

      const attr = this.getAttribute("data-playlistz");
      if (attr) {
        this._initFromJson(attr);
      }
    }

    // fired when data-playlistz is set after the element is already connected
    // (e.g. dynamically injected or set by a script that runs after registration)
    attributeChangedCallback(
      name: string,
      _old: string | null,
      val: string | null
    ) {
      if (name === "data-playlistz" && val) {
        this._initFromJson(val);
      }
    }

    private _initFromJson(json: string) {
      try {
        const parsed = JSON.parse(json);
        const result = FreqholePlaylistzSchema.safeParse(parsed);
        if (!result.success) {
          console.error("invalid data-playlistz attribute:", result.error);
          return;
        }
        this._initFromEntries(result.data);
      } catch (err) {
        console.error("failed to parse data-playlistz attribute:", err);
      }
    }

    private _initFromEntries(
      entries: ReturnType<typeof FreqholePlaylistzSchema.parse>
    ) {
      for (const entry of entries) {
        initializeStandalonePlaylist(entry, {
          setSelectedPlaylist: () => {},
          setPlaylistSongs: () => {},
          setSidebarCollapsed: () => {},
          setError: (err) => console.error("standalone init error:", err),
        }).catch((err) => console.error("standalone init failed:", err));
      }
    }
  }
);
