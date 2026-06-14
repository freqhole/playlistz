// e2e: single-browser tests for the collaborative sharing ui.
//
// covers: subscribed (read-only) playlist mode, fork flow,
// edit/share buttons exiting all-playlists view, and remoteName
// display in playlist rows.
//
// all tests here use the __patchDocIndexEntry / __getDocIndexEntries dev hooks
// to inject remote-source state without needing a real p2p connection.

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  getDocIndexEntries,
  patchDocIndexEntry,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// get the docId of the only/first playlist in the docIndex
async function firstDocId(page: import("@playwright/test").Page): Promise<string> {
  const entries = await getDocIndexEntries(page);
  const id = entries[0]?.docId;
  if (!id) throw new Error("no docIndex entry found");
  return id;
}

// patch remoteNodeId onto the current playlist and wait for the reactive
// docIndex effect to propagate (no reload needed)
async function makeSubscribed(
  page: import("@playwright/test").Page,
  docId: string,
  opts: { remoteNodeId?: string; remoteName?: string } = {}
): Promise<void> {
  await patchDocIndexEntry(page, docId, {
    remoteNodeId: opts.remoteNodeId ?? "a".repeat(64),
    remoteName: opts.remoteName,
  });
  // give the createLiveQuery broadcast + reactive effect time to propagate
  await page.waitForTimeout(500);
}

// --- subscribed (read-only) mode ---

test("subscribed playlist disables title input", async ({ page }) => {
  await createPlaylistViaUI(page);
  const docId = await firstDocId(page);
  await makeSubscribed(page, docId);
  await expect(page.getByTestId("input-playlist-title")).toBeDisabled({
    timeout: 5000,
  });
  await expect(page.getByTestId("input-playlist-description")).toBeDisabled();
});

test("subscribed playlist hides remove-song button", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 1);

  // the remove button is in the hover overlay - hover the row to reveal it
  const songRow = page.getByTestId("song-row").first();
  await songRow.waitFor({ timeout: 10000 });
  await songRow.hover();
  await expect(page.getByTestId("btn-remove-song").first()).toBeVisible({
    timeout: 3000,
  });

  const docId = await firstDocId(page);
  await makeSubscribed(page, docId);

  await expect(page.getByTestId("btn-remove-song")).toHaveCount(0, {
    timeout: 5000,
  });
});

test("subscribed playlist shows fork and request-collaboration in edit panel", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  const docId = await firstDocId(page);
  await makeSubscribed(page, docId, { remoteName: "peer-dave" });

  await page.getByTestId("btn-edit-playlist").click();
  await page.getByTestId("edit-panel").waitFor({ timeout: 5000 });

  await expect(page.getByTestId("btn-fork-playlist")).toBeVisible();
  await expect(page.getByTestId("btn-request-collaboration")).toBeVisible();
  // banner should mention the remote name
  await expect(page.getByTestId("edit-panel")).toContainText("peer-dave");
});

// --- fork flow ---

test("fork creates a new local playlist and selects it", async ({ page }) => {
  await createPlaylistViaUI(page);

  const firstTitle = "original-playlist";
  await page.getByTestId("input-playlist-title").click({ clickCount: 3 });
  await page.getByTestId("input-playlist-title").fill(firstTitle);
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  const docId = await firstDocId(page);
  await makeSubscribed(page, docId);

  // confirm subscribed - title should be disabled
  await expect(page.getByTestId("input-playlist-title")).toBeDisabled({
    timeout: 5000,
  });

  // open edit panel and fork
  await page.getByTestId("btn-edit-playlist").click();
  await page.getByTestId("edit-panel").waitFor({ timeout: 5000 });
  await page.getByTestId("btn-fork-playlist").click();

  // after fork: a new local playlist is selected.
  // the subscribed banner (with fork button) should disappear.
  await expect(page.getByTestId("btn-fork-playlist")).not.toBeVisible({
    timeout: 8000,
  });

  // close the edit panel, then verify title is enabled on the forked playlist
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("input-playlist-title")).toBeEnabled({
    timeout: 5000,
  });

  // open all-playlists - the original (now subscribed/forked) should appear in the list
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
  await expect(
    page.getByTestId("all-playlists-panel").getByText(firstTitle)
  ).toBeVisible();
});

test("forked playlist is editable (title input enabled)", async ({ page }) => {
  await createPlaylistViaUI(page);
  const docId = await firstDocId(page);
  await makeSubscribed(page, docId);

  await expect(page.getByTestId("input-playlist-title")).toBeDisabled({
    timeout: 5000,
  });

  // fork
  await page.getByTestId("btn-edit-playlist").click();
  await page.getByTestId("edit-panel").waitFor({ timeout: 5000 });
  await page.getByTestId("btn-fork-playlist").click();
  // fork banner disappears once the new local playlist is selected
  await expect(page.getByTestId("btn-fork-playlist")).not.toBeVisible({
    timeout: 8000,
  });
  await page.keyboard.press("Escape");

  // fork is now selected - title should be editable
  await expect(page.getByTestId("input-playlist-title")).toBeEnabled({
    timeout: 5000,
  });

  // actually type in it to confirm
  await page.getByTestId("input-playlist-title").click({ clickCount: 3 });
  await page.getByTestId("input-playlist-title").fill("my-fork");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("my-fork");
});

// --- edit/share buttons close all-playlists panel ---

test("clicking edit button while all-playlists is open closes it", async ({
  page,
}) => {
  await createPlaylistViaUI(page);

  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();

  await page.getByTestId("btn-edit-playlist").click();

  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
  await expect(page.getByTestId("edit-panel")).toBeVisible();
});

test("clicking share button while all-playlists is open closes it", async ({
  page,
}) => {
  await createPlaylistViaUI(page);

  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();

  await page.getByTestId("btn-share-playlist").click();

  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
  await expect(page.getByTestId("share-panel")).toBeVisible();
});

// --- remoteName display in playlist rows ---

test("playlist row shows remoteName when set", async ({ page }) => {
  // create the subscribed playlist first
  await createPlaylistViaUI(page);
  const docId = await firstDocId(page);
  await makeSubscribed(page, docId, { remoteName: "peer-frank" });

  // create a second playlist so the first appears in the all-playlists panel
  // (the selected playlist is shown in the header, not in the panel list)
  await createPlaylistViaUI(page);

  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });

  await expect(page.getByTestId("all-playlists-panel")).toContainText(
    "peer-frank"
  );
});

// --- per-playlist sharing mode ---

test("mode buttons in share panel are visible", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-share-playlist").click();
  await page.getByTestId("share-panel").waitFor({ timeout: 5000 });

  await expect(page.getByTestId("btn-mode-public")).toBeVisible();
  await expect(page.getByTestId("btn-mode-knock")).toBeVisible();
});
