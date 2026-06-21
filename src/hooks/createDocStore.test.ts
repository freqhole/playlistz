// tests for createDocStore solid adapter.
//
// uses a lightweight mock DocHandle (no automerge wasm needed) to test
// the solid reactivity layer and zod facade independently.

import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import type {
  DocHandleChangePayload,
  DocHandleDeletePayload,
} from "@automerge/automerge-repo";
import { createDocStore, changeDoc } from "./createDocStore.js";
import type { DocHandle } from "@automerge/automerge-repo";
import type { PlaylistDoc } from "../types/playlistz";

// --- minimal mock DocHandle ---

type EventName = "change" | "delete";
type HandlerFn = (payload: unknown) => void;

function createMockHandle(initialDoc: unknown = undefined): {
  handle: DocHandle<unknown>;
  setDoc: (doc: unknown) => void;
  emitChange: (doc: unknown) => void;
  emitDelete: () => void;
  resolveReady: () => void;
  rejectReady: (err: unknown) => void;
  offSpy: ReturnType<typeof vi.fn>;
} {
  let currentDoc = initialDoc;
  const handlers = new Map<EventName, Set<HandlerFn>>();
  let readyResolve: () => void;
  let readyReject: (err: unknown) => void;

  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  const offSpy = vi.fn();

  const handle = {
    doc: () => currentDoc,
    whenReady: () => readyPromise,
    on: (event: EventName, handler: HandlerFn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: offSpy,
    change: vi.fn((fn: (d: unknown) => void) => {
      fn(currentDoc);
      const set = handlers.get("change");
      if (set) {
        const payload: DocHandleChangePayload<unknown> = {
          handle: handle as unknown as DocHandle<unknown>,
          doc: currentDoc as ReturnType<typeof handle.doc>,
          patches: [],
          patchInfo: {
            before: currentDoc as ReturnType<typeof handle.doc>,
            after: currentDoc as ReturnType<typeof handle.doc>,
            source: "change",
          },
        };
        set.forEach((h) => h(payload));
      }
    }),
  } as unknown as DocHandle<unknown>;

  return {
    handle,
    setDoc: (d: unknown) => {
      currentDoc = d;
    },
    emitChange: (doc: unknown) => {
      currentDoc = doc;
      const set = handlers.get("change");
      if (set) {
        const payload: DocHandleChangePayload<unknown> = {
          handle: handle as unknown as DocHandle<unknown>,
          doc: doc as ReturnType<typeof handle.doc>,
          patches: [],
          patchInfo: {
            before: doc as ReturnType<typeof handle.doc>,
            after: doc as ReturnType<typeof handle.doc>,
            source: "change",
          },
        };
        set.forEach((h) => h(payload));
      }
    },
    emitDelete: () => {
      const set = handlers.get("delete");
      if (set) {
        const payload: DocHandleDeletePayload<unknown> = {
          handle: handle as unknown as DocHandle<unknown>,
        };
        set.forEach((h) => h(payload));
      }
    },
    resolveReady: () => readyResolve(),
    rejectReady: (err: unknown) => readyReject(err),
    offSpy,
  };
}

describe("createDocStore", () => {
  it("returns loading=true and default doc when handle doc is undefined", () => {
    createRoot((dispose) => {
      const { handle } = createMockHandle(undefined);
      const { doc, loading } = createDocStore(handle);

      expect(loading()).toBe(true);
      // zod defaults produce version 1 empty doc
      expect(doc().version).toBe(1);
      expect(doc().title).toBe("");

      dispose();
    });
  });

  it("returns loading=false immediately when handle already has a doc", () => {
    createRoot((dispose) => {
      const initialDoc = {
        version: 1,
        title: "loaded",
        description: "",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        lastModifiedBy: "",
        images: [],
        urls: [],
        songs: {},
        order: [],
        peers: {},
      };
      const { handle } = createMockHandle(initialDoc);
      const { doc, loading } = createDocStore(handle);

      expect(loading()).toBe(false);
      expect(doc().title).toBe("loaded");

      dispose();
    });
  });

  it("updates doc signal on handle change event", () => {
    createRoot((dispose) => {
      const { handle, emitChange } = createMockHandle({
        version: 1,
        title: "original",
        description: "",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        lastModifiedBy: "",
        images: [],
        urls: [],
        songs: {},
        order: [],
        peers: {},
      });
      const { doc } = createDocStore(handle);

      expect(doc().title).toBe("original");

      emitChange({
        version: 1,
        title: "updated",
        description: "",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        lastModifiedBy: "",
        images: [],
        urls: [],
        songs: {},
        order: [],
        peers: {},
      });

      expect(doc().title).toBe("updated");

      dispose();
    });
  });

  it("degrades corrupt doc to zod defaults on change", () => {
    createRoot((dispose) => {
      const { handle, emitChange } = createMockHandle({ version: 1 });
      const { doc } = createDocStore(handle);

      // emit a corrupt doc that fails zod validation
      emitChange({ version: 999, badField: true });

      // zod degrades to defaults
      expect(doc().version).toBe(1);
      expect(doc().title).toBe("");

      dispose();
    });
  });

  it("sets loading=false when delete event fires", () => {
    createRoot((dispose) => {
      const { handle, emitDelete } = createMockHandle(undefined);
      const { loading } = createDocStore(handle);

      expect(loading()).toBe(true);
      emitDelete();
      expect(loading()).toBe(false);

      dispose();
    });
  });

  it("sets loading=false when whenReady resolves", async () => {
    await createRoot(async (dispose) => {
      const { handle, resolveReady, setDoc } = createMockHandle(undefined);
      const { loading } = createDocStore(handle);

      expect(loading()).toBe(true);

      setDoc({
        version: 1,
        title: "",
        description: "",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        lastModifiedBy: "",
        images: [],
        urls: [],
        songs: {},
        order: [],
        peers: {},
      });
      resolveReady();

      // flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(loading()).toBe(false);

      dispose();
    });
  });

  it("sets loading=false when whenReady rejects", async () => {
    await createRoot(async (dispose) => {
      const { handle, rejectReady } = createMockHandle(undefined);
      const { loading } = createDocStore(handle);

      rejectReady(new Error("unavailable"));

      await Promise.resolve();
      await Promise.resolve();

      expect(loading()).toBe(false);

      dispose();
    });
  });

  it("unsubscribes handlers on cleanup (off called with correct args)", () => {
    const { handle, offSpy } = createMockHandle({ version: 1 });

    const dispose = createRoot((disposeRoot) => {
      createDocStore(handle);
      return disposeRoot;
    });

    dispose();

    // off should have been called for both "change" and "delete"
    expect(offSpy).toHaveBeenCalledWith("change", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith("delete", expect.any(Function));
  });

  it("degrades null/undefined doc to zod defaults", () => {
    createRoot((dispose) => {
      const { handle, emitChange } = createMockHandle({ version: 1 });
      const { doc } = createDocStore(handle);

      emitChange(null);
      expect(doc().version).toBe(1);
      expect(doc().title).toBe("");

      dispose();
    });
  });
});

describe("changeDoc", () => {
  it("calls handle.change with the mutator function", () => {
    const mockChange = vi.fn();
    const handle = {
      change: mockChange,
    } as unknown as DocHandle<PlaylistDoc>;

    const mutator = vi.fn();
    changeDoc(handle, mutator);

    expect(mockChange).toHaveBeenCalledWith(mutator);
  });
});
