import { render } from "solid-js/web";
import { Playlistz } from "./components/index.js";
import { FreqholePlaylistzSchema } from "./utils/standaloneTemplates.js";
import { initializeStandalonePlaylist } from "./services/standaloneService.js";
import "./styles.css";

// expose a reset helper on window so devs can clear all playlistz state from
// the browser console: await window.__playlistzReset()
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__playlistzReset =
    async () => {
      // tell the service worker to clear its caches
      if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "PLAYLISTZ_RESET",
        });
      }
      // clear all playlistz IDB databases
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(
        dbs
          .filter((d) => d.name)
          .map(
            (d) =>
              new Promise<void>((res, rej) => {
                const req = indexedDB.deleteDatabase(d.name!);
                req.onsuccess = () => res();
                req.onerror = () => rej(req.error);
              })
          )
      );
      // clear all caches
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      console.log(
        "playlistz: all caches and IDB databases cleared. reload to restart fresh."
      );
    };
}

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
