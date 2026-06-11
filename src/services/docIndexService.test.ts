// tests for docIndexService crud helpers.
// uses fake-indexeddb (wired via test-setup.ts) so no real IDB needed.

import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBCache } from "./indexedDBService.js";
import {
  addDocIndexEntry,
  removeDocIndexEntry,
  getDocIndexEntry,
  getAllDocIndexEntries,
  upsertKnock,
  getKnock,
  getAllKnocks,
  deleteKnock,
  upsertAccessGrant,
  getAccessGrant,
  getAllAccessGrants,
  deleteAccessGrant,
} from "./docIndexService.js";
import type { DocIndexEntry, KnockRecord, AccessGrantRecord } from "./indexedDBService.js";

// fresh idb + db connection for each test (avoids data leaking across tests)
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDBCache();
});

// --- helpers ---

function makeEntry(overrides: Partial<DocIndexEntry> = {}): DocIndexEntry {
  return {
    docId: "automerge:abc123",
    title: "test playlist",
    addedAt: 1_000_000,
    source: "local",
    ...overrides,
  };
}

function makeKnock(overrides: Partial<KnockRecord> = {}): KnockRecord {
  return {
    id: "knock-1",
    nodeId: "node-abc",
    direction: "inbound",
    name: "alice",
    message: "let me in",
    status: "pending",
    createdAt: 1_000_000,
    ...overrides,
  };
}

function makeGrant(overrides: Partial<AccessGrantRecord> = {}): AccessGrantRecord {
  return {
    nodeId: "node-abc",
    name: "alice",
    grantedAt: 1_000_000,
    ...overrides,
  };
}

// --- docIndex ---

describe("docIndex CRUD", () => {
  it("addDocIndexEntry and getDocIndexEntry round-trip", async () => {
    const entry = makeEntry({ docId: "automerge:abc", title: "my list" });
    await addDocIndexEntry(entry);
    const fetched = await getDocIndexEntry("automerge:abc");
    expect(fetched).toEqual(entry);
  });

  it("getDocIndexEntry returns undefined for missing key", async () => {
    const result = await getDocIndexEntry("automerge:missing");
    expect(result).toBeUndefined();
  });

  it("getAllDocIndexEntries returns all entries", async () => {
    await addDocIndexEntry(makeEntry({ docId: "automerge:a", title: "A" }));
    await addDocIndexEntry(makeEntry({ docId: "automerge:b", title: "B" }));
    const all = await getAllDocIndexEntries();
    expect(all).toHaveLength(2);
    const titles = all.map((e) => e.title).sort();
    expect(titles).toEqual(["A", "B"]);
  });

  it("removeDocIndexEntry removes the entry", async () => {
    await addDocIndexEntry(makeEntry({ docId: "automerge:del" }));
    await removeDocIndexEntry("automerge:del");
    const result = await getDocIndexEntry("automerge:del");
    expect(result).toBeUndefined();
  });

  it("removeDocIndexEntry is idempotent for missing key", async () => {
    // should not throw
    await expect(
      removeDocIndexEntry("automerge:never-existed")
    ).resolves.toBeUndefined();
  });

  it("addDocIndexEntry overwrites an existing entry", async () => {
    await addDocIndexEntry(makeEntry({ docId: "automerge:x", title: "old" }));
    await addDocIndexEntry(makeEntry({ docId: "automerge:x", title: "new" }));
    const fetched = await getDocIndexEntry("automerge:x");
    expect(fetched?.title).toBe("new");
  });

  it("source field round-trips for all source types", async () => {
    for (const source of ["local", "shared", "freqhole"] as const) {
      await addDocIndexEntry(
        makeEntry({ docId: `automerge:${source}`, source })
      );
      const result = await getDocIndexEntry(`automerge:${source}`);
      expect(result?.source).toBe(source);
    }
  });
});

// --- knocks ---

describe("knocks CRUD", () => {
  it("upsertKnock and getKnock round-trip", async () => {
    const knock = makeKnock();
    await upsertKnock(knock);
    const fetched = await getKnock("knock-1");
    expect(fetched).toEqual(knock);
  });

  it("getAllKnocks returns all records", async () => {
    await upsertKnock(makeKnock({ id: "k1" }));
    await upsertKnock(makeKnock({ id: "k2", direction: "outbound" }));
    const all = await getAllKnocks();
    expect(all).toHaveLength(2);
  });

  it("deleteKnock removes the record", async () => {
    await upsertKnock(makeKnock({ id: "k-del" }));
    await deleteKnock("k-del");
    expect(await getKnock("k-del")).toBeUndefined();
  });

  it("upsertKnock updates an existing record", async () => {
    await upsertKnock(makeKnock({ id: "k-upd", status: "pending" }));
    await upsertKnock(makeKnock({ id: "k-upd", status: "accepted" }));
    const result = await getKnock("k-upd");
    expect(result?.status).toBe("accepted");
  });
});

// --- accessGrants ---

describe("accessGrants CRUD", () => {
  it("upsertAccessGrant and getAccessGrant round-trip", async () => {
    const grant = makeGrant();
    await upsertAccessGrant(grant);
    const fetched = await getAccessGrant("node-abc");
    expect(fetched).toEqual(grant);
  });

  it("getAllAccessGrants returns all records", async () => {
    await upsertAccessGrant(makeGrant({ nodeId: "n1", name: "alice" }));
    await upsertAccessGrant(makeGrant({ nodeId: "n2", name: "bob" }));
    const all = await getAllAccessGrants();
    expect(all).toHaveLength(2);
  });

  it("deleteAccessGrant removes the record", async () => {
    await upsertAccessGrant(makeGrant({ nodeId: "n-del" }));
    await deleteAccessGrant("n-del");
    expect(await getAccessGrant("n-del")).toBeUndefined();
  });

  it("upsertAccessGrant overwrites an existing record", async () => {
    await upsertAccessGrant(makeGrant({ nodeId: "n-upd", name: "old" }));
    await upsertAccessGrant(makeGrant({ nodeId: "n-upd", name: "new" }));
    const result = await getAccessGrant("n-upd");
    expect(result?.name).toBe("new");
  });
});
