// e2e: playlist creation, song adding, and persistence across reloads.

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  waitForApp,
  makePng,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

test("create a playlist via the sidebar", async ({ page }) => {
  await createPlaylistViaUI(page);
  await expect(page.getByTestId("empty-songs")).toBeVisible();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue(
    "new playlist"
  );
});

test("add songs via drag and drop", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3);

  await expect(page.getByText("song-00")).toBeVisible();
  await expect(page.getByText("song-01")).toBeVisible();
  await expect(page.getByText("song-02")).toBeVisible();
  await expect(page.getByTestId("playlist-song-count").first()).toBeVisible();
});

test("songs survive a page reload", async ({ page }) => {
  // regression: after reload the song registry was empty and every
  // row rendered "song not found"
  await createPlaylistViaUI(page);
  await addSongs(page, 2);

  await page.reload();
  await waitForApp(page);

  await expect(page.getByText("song-00")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("song-01")).toBeVisible();
  await expect(page.getByText("song not found")).toHaveCount(0);
});

test("playlist title edit persists across reload", async ({ page }) => {
  await createPlaylistViaUI(page);

  const title = page.getByTestId("input-playlist-title");
  await title.fill("doom mix");
  await title.blur();
  await page.waitForTimeout(500);

  await page.reload();
  await waitForApp(page);

  await expect(page.getByTestId("input-playlist-title")).toHaveValue(
    "doom mix",
    { timeout: 10000 }
  );
});

test("playlist cover image persists across reload", async ({ page }) => {
  // regression: images appeared once then were "lost" after reload
  await createPlaylistViaUI(page);
  await addSongs(page, 1);

  // open the edit panel and upload a cover
  await page.getByTestId("btn-edit-playlist").click();
  const fileInput = page.locator("input[type='file']").first();
  await fileInput.waitFor({ state: "attached", timeout: 5000 });

  const png = await makePng(page, { color: "#00ffcc", label: "cover" });
  await fileInput.setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from(png),
  });

  // cover preview appears in the edit panel
  await expect(page.getByTestId("edit-panel").locator("img[alt='playlist cover']").first()).toBeVisible(
    { timeout: 10000 }
  );

  await page.reload();
  await waitForApp(page);

  // re-open edit panel and confirm the cover is still there from blob store
  await page.getByTestId("btn-edit-playlist").click();
  await expect(page.getByTestId("edit-panel").locator("img[alt='playlist cover']").first()).toBeVisible({
    timeout: 10000,
  });
});

test("selected playlist is restored after a page reload", async ({ page }) => {
  // create two playlists and select the second one, then reload.
  // the app should re-select the second playlist rather than defaulting
  // to the first one.
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("first");
  await page.getByTestId("input-playlist-title").blur();

  // create a second playlist via the all-playlists panel
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor({ timeout: 5000 });
  await page.getByTestId("input-playlist-title").click({ clickCount: 3 });
  await page.getByTestId("input-playlist-title").fill("second");
  await page.getByTestId("input-playlist-title").blur();

  // "second" is currently selected
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("second");

  // wait a moment for the saveSetting idb write to complete
  await page.waitForTimeout(300);

  await page.reload();
  await waitForApp(page);

  // should restore "second", not fall back to "first"
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("second", {
    timeout: 10000,
  });
});
