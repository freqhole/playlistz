// solid hook: reactive list of docIndex entries for the sidebar.
//
// follows the same live-query pattern as usePlaylistsQuery:
// - initial fetch on mount
// - BroadcastChannel listener for cross-tab invalidation
// - onCleanup closes the channel when the owner is disposed

import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import {
  getAllDocIndexEntries,
  DOC_INDEX_CHANGE_EVENT,
} from "../services/docIndexService.js";
import { DB_NAME, DOC_INDEX_STORE } from "../services/indexedDBService.js";
import type { DocIndexEntry } from "../services/indexedDBService.js";
import { log } from "../utils/log.js";

// returns a solid accessor that stays up-to-date with the docIndex store.
// call inside a component or createRoot.
export function createDocIndexQuery(): Accessor<DocIndexEntry[]> {
  const [entries, setEntries] = createSignal<DocIndexEntry[]>([], {
    equals: false,
  });

  let _refreshCalls = 0;
  async function refresh(): Promise<void> {
    _refreshCalls++;
    log.debug("docindex", "refresh #", String(_refreshCalls));
    const all = await getAllDocIndexEntries();
    log.debug(
      "docindex",
      "refresh #",
      String(_refreshCalls),
      "got",
      String(all.length),
      "entries"
    );
    setEntries(all);
  }

  void refresh();

  // BroadcastChannel: cross-tab invalidation
  const bc = new BroadcastChannel(`${DB_NAME}-changes`);
  bc.onmessage = (e: MessageEvent) => {
    if (e.data?.type === "mutation" && e.data.store === DOC_INDEX_STORE) {
      log.debug("docindex", "broadcast invalidation received");
      void refresh();
    }
  };

  // CustomEvent: same-page invalidation - works on file:// (null origin)
  // where BroadcastChannel may not deliver same-page messages reliably.
  const onDocIndexChanged = () => {
    void refresh();
  };
  window.addEventListener(DOC_INDEX_CHANGE_EVENT, onDocIndexChanged);

  onCleanup(() => {
    bc.close();
    window.removeEventListener(DOC_INDEX_CHANGE_EVENT, onDocIndexChanged);
  });

  return entries;
}
