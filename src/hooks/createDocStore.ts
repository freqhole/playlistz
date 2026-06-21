// solid adapter over an automerge DocHandle for PlaylistDoc.
//
// usage inside a solid component or reactive root:
//
//   const handle = await findPlaylistDoc(url);
//   const { doc, loading } = createDocStore(handle);
//   // doc() is always a zod-parsed PlaylistDoc (defaults on corrupt/missing)
//   // loading() is true until the handle is ready or terminal

import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type {
  DocHandle,
  DocHandleChangePayload,
  DocHandleDeletePayload,
} from "@automerge/automerge-repo";
import {
  parsePlaylistDoc,
  type PlaylistDoc,
} from "@freqhole/api-client/playlistz";

export interface DocStore {
  doc: Accessor<PlaylistDoc>;
  loading: Accessor<boolean>;
}

// create a reactive solid store backed by an automerge DocHandle.
// the doc accessor is always a zod-validated PlaylistDoc snapshot -
// corrupt or future-versioned peer data degrades to defaults.
// loading becomes false once whenReady() resolves or rejects.
export function createDocStore(handle: DocHandle<unknown>): DocStore {
  // try to read whatever the handle has now (may be undefined before ready)
  let initialRaw: unknown;
  try {
    initialRaw = handle.doc();
  } catch {
    initialRaw = undefined;
  }

  const [loading, setLoading] = createSignal(initialRaw === undefined);
  const [doc, setDoc] = createSignal<PlaylistDoc>(
    parsePlaylistDoc(initialRaw),
    { equals: false }
  );

  // resolve handle readiness in the background
  handle
    .whenReady()
    .then(() => {
      let current: unknown;
      try {
        current = handle.doc();
      } catch {
        current = undefined;
      }
      setLoading(false);
      setDoc(parsePlaylistDoc(current));
    })
    .catch(() => {
      setLoading(false);
    });

  const changeHandler = (payload: DocHandleChangePayload<unknown>) => {
    setDoc(parsePlaylistDoc(payload.doc));
  };

  const deleteHandler = (_payload: DocHandleDeletePayload<unknown>) => {
    setLoading(false);
  };

  handle.on("change", changeHandler);
  handle.on("delete", deleteHandler);

  onCleanup(() => {
    handle.off("change", changeHandler);
    handle.off("delete", deleteHandler);
  });

  return { doc, loading };
}

// convenience wrapper: apply a mutation to a playlist doc handle.
// the mutatorFn receives a mutable automerge draft and should modify it
// in place (safe to call the shared mutation helpers from freqhole-api-client).
export function changeDoc(
  handle: DocHandle<PlaylistDoc>,
  mutatorFn: (draft: PlaylistDoc) => void
): void {
  handle.change(mutatorFn);
}
