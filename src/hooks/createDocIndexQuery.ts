// solid hook: reactive list of docIndex entries for the sidebar.
//
// follows the same live-query pattern as usePlaylistsQuery:
// - initial fetch on mount
// - BroadcastChannel listener for cross-tab invalidation
// - onCleanup closes the channel when the owner is disposed

import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { getAllDocIndexEntries } from "../services/docIndexService.js";
import { DB_NAME, DOC_INDEX_STORE } from "../services/indexedDBService.js";
import type { DocIndexEntry } from "../services/indexedDBService.js";

// returns a solid accessor that stays up-to-date with the docIndex store.
// call inside a component or createRoot.
export function createDocIndexQuery(): Accessor<DocIndexEntry[]> {
  const [entries, setEntries] = createSignal<DocIndexEntry[]>([], {
    equals: false,
  });

  async function refresh(): Promise<void> {
    const all = await getAllDocIndexEntries();
    setEntries(all);
  }

  void refresh();

  const bc = new BroadcastChannel(`${DB_NAME}-changes`);
  bc.onmessage = (e: MessageEvent) => {
    if (e.data?.type === "mutation" && e.data.store === DOC_INDEX_STORE) {
      void refresh();
    }
  };

  onCleanup(() => {
    bc.close();
  });

  return entries;
}
