// e2e: all-playlists panel - hamburger button, row interactions, keyboard nav.

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// --- panel open / close ---

test("hamburger opens the all-playlists panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  // rename so we can identify it
  await page.getByTestId("input-playlist-title").fill("alpha");
  await page.getByTestId("input-playlist-title").blur();

  // create a second playlist so the panel has something to show
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor({ timeout: 5000 });
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
  await page.getByTestId("input-playlist-title").fill("beta");
  await page.getByTestId("input-playlist-title").blur();

  // open panel again - should see the panel
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();
});

test("escape closes the all-playlists panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
});

test("hamburger button closes the all-playlists panel when open", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
});

// --- row contents ---

test("selected playlist is not shown in panel rows", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("selected one");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  // create a second playlist so panel has rows to show
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
  await page.getByTestId("input-playlist-title").fill("other one");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  // go back to selected one
  await page.getByTestId("btn-all-playlists").click();
  // find and click "selected one" row
  await page.getByText("selected one").first().click();
  await page.waitForTimeout(300);

  // open panel - "selected one" should NOT appear in the row list
  await page.getByTestId("btn-all-playlists").click();
  // the mini header shows the current playlist title ("selected one")
  // but it should NOT appear as a clickable row
  const rows = page.locator("[title*='play selected one']");
  await expect(rows).toHaveCount(0);
  // "other one" should be present as a row
  await expect(page.getByText("other one").first()).toBeVisible();
});

test("all other playlists are shown in panel rows", async ({ page }) => {
  // create three playlists
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("playlist a");
  await page.getByTestId("input-playlist-title").blur();

  for (const name of ["playlist b", "playlist c"]) {
    await page.getByTestId("btn-all-playlists").click();
    await page.getByTestId("btn-new-playlist").click();
    await page.getByTestId("btn-edit-playlist").waitFor();
    await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
    await page.getByTestId("input-playlist-title").fill(name);
    await page.getByTestId("input-playlist-title").blur();
    // wait for the doc to reflect the new title before navigating away
    await expect(page.getByTestId("input-playlist-title")).toHaveValue(name);
  }

  // currently selected is "playlist c" - panel should show a and b
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByText("playlist a")).toBeVisible();
  await expect(page.getByText("playlist b")).toBeVisible();
});

// --- row navigation ---

test("clicking a row selects the playlist and closes the panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("first");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
  await page.getByTestId("input-playlist-title").fill("second");
  await page.getByTestId("input-playlist-title").blur();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("second");

  // open panel and click "first"
  await page.getByTestId("btn-all-playlists").click();
  await page.getByText("first").first().click();

  // panel should close
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
  // "first" should now be the selected playlist shown in the title area
  await expect(page.getByTestId("input-playlist-title").or(page.getByText("first").first())).toBeVisible();
});

test("edit button in row opens edit panel for that playlist", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("edit me");
  await page.getByTestId("input-playlist-title").blur();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("edit me");

  // create a second playlist as the "currently selected" one
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
  await page.getByTestId("input-playlist-title").fill("currently selected");
  await page.getByTestId("input-playlist-title").blur();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("currently selected");

  // open panel, hover over "edit me" row and click its edit button
  await page.getByTestId("btn-all-playlists").click();
  // wait for panel rows to appear
  const panel = page.getByTestId("all-playlists-panel");
  await panel.waitFor({ timeout: 3000 });
  const row = panel.getByText("edit me").first();
  await row.hover();
  await panel.getByTestId("btn-edit-playlist-row").click();

  // panel closes, edit panel opens for "edit me"
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
  // the edit input should show "edit me"
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("edit me");
});

test("share button in row opens share panel for that playlist", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("input-playlist-title").fill("share me");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
  await page.getByTestId("input-playlist-title").fill("currently selected");
  await page.getByTestId("input-playlist-title").blur();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("currently selected");

  await page.getByTestId("btn-all-playlists").click();
  const panel = page.getByTestId("all-playlists-panel");
  await panel.waitFor({ timeout: 3000 });
  const row = panel.getByText("share me").first();
  await row.hover();
  await panel.getByTestId("btn-share-playlist-row").click();

  // share panel should be open
  await expect(page.getByTestId("share-panel")).toBeVisible();
});

// --- new playlist ---

test("new playlist row creates a playlist and closes the panel", async ({ page }) => {
  await createPlaylistViaUI(page);

  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();

  // panel should close and new playlist edit mode should be open
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible();
  await expect(page.getByTestId("btn-edit-playlist")).toBeVisible();
  await expect(page.getByTestId("input-playlist-title")).toHaveValue("new playlist");
});

// --- song count / panel with songs ---

test("row shows song count for playlists with songs", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3);
  await page.getByTestId("input-playlist-title").fill("has songs");
  await page.getByTestId("input-playlist-title").blur();
  await page.waitForTimeout(300);

  // create a second (selected) playlist
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("btn-new-playlist").click();
  await page.getByTestId("btn-edit-playlist").waitFor();
  await page.waitForTimeout(300);

  // open panel - "has songs" row should show "3 songz"
  await page.getByTestId("btn-all-playlists").click();
  await expect(page.getByTestId("row-song-count").first()).toContainText("3");
});
