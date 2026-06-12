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
  await page.locator("input[placeholder='playlist title']").fill("alpha");
  await page.locator("input[placeholder='playlist title']").blur();

  // create a second playlist so the panel has something to show
  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor({ timeout: 5000 });
  await page.locator("input[placeholder='playlist title']").fill("beta");
  await page.locator("input[placeholder='playlist title']").blur();

  // open panel again - should see the mini-header label
  await page.getByTitle("all playlistz").click();
  await expect(page.getByText("all playlistz").first()).toBeVisible();
});

test("escape closes the all-playlists panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTitle("all playlistz").click();
  await expect(page.getByTitle("close all playlists").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTitle("close all playlists")).not.toBeVisible();
});

test("close button closes the all-playlists panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTitle("all playlistz").click();
  await page.getByTitle("close all playlists").first().click();
  await expect(page.getByTitle("close all playlists")).not.toBeVisible();
});

// --- row contents ---

test("selected playlist is not shown in panel rows", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.locator("input[placeholder='playlist title']").fill("selected one");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // create a second playlist so panel has rows to show
  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor();
  await page.locator("input[placeholder='playlist title']").fill("other one");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // go back to selected one
  await page.getByTitle("all playlistz").click();
  // find and click "selected one" row
  await page.getByText("selected one").first().click();
  await page.waitForTimeout(300);

  // open panel - "selected one" should NOT appear in the row list
  await page.getByTitle("all playlistz").click();
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
  await page.locator("input[placeholder='playlist title']").fill("playlist a");
  await page.locator("input[placeholder='playlist title']").blur();

  for (const name of ["playlist b", "playlist c"]) {
    await page.getByTitle("all playlistz").click();
    await page.getByRole("button", { name: "new playlist" }).first().click();
    await page.getByTitle("edit playlist").first().waitFor();
    await page.locator("input[placeholder='playlist title']").fill(name);
    await page.locator("input[placeholder='playlist title']").blur();
    await page.waitForTimeout(300);
  }

  // currently selected is "playlist c" - panel should show a and b
  await page.getByTitle("all playlistz").click();
  await expect(page.getByText("playlist a")).toBeVisible();
  await expect(page.getByText("playlist b")).toBeVisible();
});

// --- row navigation ---

test("clicking a row selects the playlist and closes the panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.locator("input[placeholder='playlist title']").fill("first");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor();
  await page.locator("input[placeholder='playlist title']").fill("second");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // open panel and click "first"
  await page.getByTitle("all playlistz").click();
  await page.getByText("first").first().click();

  // panel should close (no close button visible)
  await expect(page.getByTitle("close all playlists")).not.toBeVisible({ timeout: 5000 });
  // "first" should now be the selected playlist shown in the mini header / title area
  await expect(page.locator("input[placeholder='playlist title']").or(page.getByText("first").first())).toBeVisible();
});

test("edit button in row opens edit panel for that playlist", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.locator("input[placeholder='playlist title']").fill("edit me");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // create a second playlist as the "currently selected" one
  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor();
  await page.locator("input[placeholder='playlist title']").fill("currently selected");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // open panel, hover over "edit me" row and click its edit button
  await page.getByTitle("all playlistz").click();
  // wait for panel rows to appear
  const panel = page.getByTestId("all-playlists-panel");
  await panel.waitFor({ timeout: 3000 });
  const row = panel.getByText("edit me").first();
  await row.hover();
  await panel.getByTitle("edit playlist").first().click();

  // panel closes, edit panel opens for "edit me"
  await expect(page.getByTitle("close all playlists")).not.toBeVisible({ timeout: 5000 });
  // the edit input should show "edit me"
  await expect(page.locator("input[placeholder='playlist title']")).toHaveValue("edit me", { timeout: 5000 });
});

test("share button in row opens share panel for that playlist", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.locator("input[placeholder='playlist title']").fill("share me");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor();
  await page.locator("input[placeholder='playlist title']").fill("currently selected");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  await page.getByTitle("all playlistz").click();
  const panel = page.getByTestId("all-playlists-panel");
  await panel.waitFor({ timeout: 3000 });
  const row = panel.getByText("share me").first();
  await row.hover();
  await panel.getByTitle("share playlist").first().click();

  // share panel should be open
  await expect(page.getByTitle("close share panel")).toBeVisible({ timeout: 5000 });
});

// --- new playlist ---

test("new playlist row creates a playlist and closes the panel", async ({ page }) => {
  await createPlaylistViaUI(page);

  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();

  // panel should close and new playlist edit mode should be open
  await expect(page.getByTitle("close all playlists")).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTitle("edit playlist").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("input[placeholder='playlist title']")).toHaveValue("new playlist");
});

// --- song count / panel with songs ---

test("row shows song count for playlists with songs", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3);
  await page.locator("input[placeholder='playlist title']").fill("has songs");
  await page.locator("input[placeholder='playlist title']").blur();
  await page.waitForTimeout(300);

  // create a second (selected) playlist
  await page.getByTitle("all playlistz").click();
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").first().waitFor();
  await page.waitForTimeout(300);

  // open panel - "has songs" row should show "3 songz"
  await page.getByTitle("all playlistz").click();
  await expect(page.getByText("3 songz").first()).toBeVisible();
});
