// e2e: share link auto-play - navigate to /?#share/<token> with a local doc.
//
// the share link auto-play flow (§3a) works even without p2p for docs that
// are already in local idb - repo.find() resolves from local storage.
// we construct a synthetic #share/ token pointing at a real docId read
// from the idb docIndex after creating a playlist.

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  waitForApp,
} from "./helpers.js";

// read the first docId from the app's musicPlaylistDB docIndex store.
// returns null if the store is empty.
async function readFirstDocId(page: ReturnType<typeof import("@playwright/test")["test"]["info"]> extends never ? never : import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(() => {
    return new Promise<string | null>((resolve) => {
      const req = indexedDB.open("musicPlaylistDB");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("docIndex")) { resolve(null); return; }
        const tx = db.transaction("docIndex", "readonly");
        const store = tx.objectStore("docIndex");
        const all = store.getAll();
        all.onsuccess = () => {
          const entries = all.result as Array<{ docId: string }>;
          resolve(entries.length > 0 ? entries[0]!.docId : null);
        };
        all.onerror = () => resolve(null);
      };
    });
  });
}

// base64url-encode a share token (matches encodeShareToken in freqhole-api-client).
// done in Node.js so we don't need a browser context.
function buildShareToken(docId: string, nodeId = "local", title = "test playlist"): string {
  const payload = JSON.stringify({ v: 1, n: nodeId, d: docId, t: title });
  const b64 = Buffer.from(payload).toString("base64");
  // base64url: replace + with -, / with _, strip =
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

test("navigating to a #share/ link selects the playlist", async ({ page }) => {
  // set up: create a playlist with songs
  await createPlaylistViaUI(page);
  await addSongs(page, 2);
  await page.locator("input[placeholder='playlist title']").fill("share target");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(500);

  // read the docId from idb
  const docId = await readFirstDocId(page);
  expect(docId).toBeTruthy();

  // navigate to a share link pointing at that docId
  const token = buildShareToken(docId!);
  await page.goto(`/?#share/${token}`);
  await waitForApp(page);

  // the playlist with that title should be selected
  // (either in the edit input or as the active playlist header)
  await expect(
    page.locator("input[placeholder='playlist title']").or(
      page.getByText("share target").first()
    )
  ).toBeVisible({ timeout: 10000 });
});

test("#share/ link for a doc already in idb does not show an error", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 1);
  await page.waitForTimeout(500);

  const docId = await readFirstDocId(page);
  expect(docId).toBeTruthy();

  // capture console errors
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  const token = buildShareToken(docId!);
  await page.goto(`/?#share/${token}`);
  await waitForApp(page);
  await page.waitForTimeout(1000);

  // no app-level error banner
  await expect(page.getByText(/failed to initialize/i)).not.toBeVisible();
  // no js errors about the share link itself
  const shareErrors = errors.filter((e) => e.includes("share") || e.includes("invalid share link"));
  expect(shareErrors).toHaveLength(0);
});

test("#share/ fragment is cleared from the url after processing", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.waitForTimeout(500);

  const docId = await readFirstDocId(page);
  expect(docId).toBeTruthy();

  const token = buildShareToken(docId!);
  await page.goto(`/?#share/${token}`);
  await waitForApp(page);
  await page.waitForTimeout(1000);

  // handleShareFragment calls history.replaceState to clear the fragment
  const url = page.url();
  expect(url).not.toContain("#share/");
});

test("invalid #share/ token shows no crash and loads app normally", async ({ page }) => {
  await page.goto("/?#share/thisisnotavalidtoken");
  await waitForApp(page);
  // app should still load without a white screen
  await expect(page.getByRole("heading", { name: "playlistz" })).toBeAttached();
});
