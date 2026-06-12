// e2e: audio playback with synthetic WAV tones.

import { test, expect } from "@playwright/test";
import { resetAppState, createPlaylistViaUI, addSongs } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

test("double-clicking a song row starts playback", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 2, 2);

  // desktop rows play on double click
  await page.getByText("song-00").dblclick();

  // the playlist play button switches to its "playing" state (magenta bg + pause icon)
  await expect(page.locator("button.bg-magenta-500").first()).toBeVisible({
    timeout: 10000,
  });
});

test("decoded duration shows in the row", async ({ page }) => {
  await createPlaylistViaUI(page);
  // 2-second tone -> row should show 0:02 once metadata is decoded
  await addSongs(page, 1, 2);

  await expect(page.getByText("0:02").first()).toBeVisible({ timeout: 15000 });
});

test("all-playlists thumbnail shows a play icon while the playlist plays", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 2, 2);

  // start playback
  await page.getByText("song-00").dblclick();
  await expect(page.locator("button.bg-magenta-500").first()).toBeVisible({
    timeout: 10000,
  });

  // open the all-playlists panel - the currently-playing playlist row
  // shows a play icon overlay on its thumbnail
  await page.getByTitle("all playlistz").first().click();

  await expect(page.locator("div[title='playing']")).toBeVisible({
    timeout: 5000,
  });
});
