import { createSignal, createEffect } from "solid-js";
import { createDocIndexQuery } from "./createDocIndexQuery.js";
import { findPlaylistDoc } from "../services/automergeRepo.js";
import { parsePlaylistDoc } from "@freqhole/api-client/playlistz";
import { docToPlaylist } from "../services/playlistDocService.js";
import type { Playlist } from "../types/playlist.js";
import type { AutomergeUrl } from "@automerge/automerge-repo";

// solid hook that creates a reactive playlist list backed by the docIndex.
// replaces the old idb live-query approach.
export function usePlaylistsQuery() {
  const [playlists, setPlaylists] = createSignal<Playlist[]>([], {
    equals: false,
  });

  const entries = createDocIndexQuery();

  createEffect(() => {
    const list = entries();
    Promise.all(
      list.map(async (entry) => {
        try {
          const handle = await findPlaylistDoc(entry.docId as AutomergeUrl);
          const raw = handle.doc();
          const doc = parsePlaylistDoc(raw ?? {});
          return docToPlaylist(entry.docId, doc);
        } catch {
          return {
            id: entry.docId,
            title: entry.title,
            description: undefined,
            createdAt: entry.addedAt,
            updatedAt: entry.addedAt,
            songIds: [],
          } as Playlist;
        }
      })
    ).then((resolved) => setPlaylists(resolved));
  });

  return {
    playlists,
  };
}
