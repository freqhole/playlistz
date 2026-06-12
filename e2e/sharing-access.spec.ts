// e2e: sharing access control - mode toggle, settings persistence, knock inbox ui.
// all tests here are single-browser (no real p2p needed).
// two-browser p2p tests are in sharing.spec.ts @p2p.

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  waitForApp,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// helper: open the share panel for the current playlist
async function openSharePanel(page: import("@playwright/test").Page) {
  // open via the share icon button in the playlist header
  await page.getByTestId("btn-share-playlist").click();
  // wait for the panel to be visible
  await page.getByTestId("btn-close-panel").waitFor({ timeout: 5000 });
}

// --- mode toggle ---

test("share panel shows mode toggle buttons", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await expect(page.getByTestId("btn-mode-public")).toBeVisible();
  await expect(page.getByTestId("btn-mode-knock")).toBeVisible();
});

test("default mode is knock first", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // "knock first" should have the active styling (magenta border class)
  const knockBtn = page.getByTestId("btn-mode-knock");
  await expect(knockBtn).toBeVisible();
  // active button has magenta border; inactive has gray
  await expect(knockBtn).toHaveClass(/border-magenta/);
  const publicBtn = page.getByTestId("btn-mode-public");
  await expect(publicBtn).not.toHaveClass(/border-magenta/);
});

test("clicking anyone (public) switches the active mode", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await page.getByTestId("btn-mode-public").click();
  await page.waitForTimeout(300);

  await expect(page.getByTestId("btn-mode-public")).toHaveClass(/border-magenta/);
  await expect(page.getByTestId("btn-mode-knock")).not.toHaveClass(/border-magenta/);
});

test("mode setting persists after closing and reopening the share panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // switch to public
  await page.getByTestId("btn-mode-public").click();
  await page.waitForTimeout(500);

  // close panel
  await page.getByTestId("btn-close-panel").click();
  await page.waitForTimeout(300);

  // reopen
  await openSharePanel(page);

  // mode should still be public
  await expect(page.getByTestId("btn-mode-public")).toHaveClass(/border-magenta/);
});

test("mode setting persists across page reload", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // switch to public
  await page.getByTestId("btn-mode-public").click();
  await page.waitForTimeout(500);

  // reload
  await page.reload();
  await waitForApp(page);

  // reopen share panel
  await openSharePanel(page);

  // mode should still be public
  await expect(page.getByTestId("btn-mode-public")).toHaveClass(/border-magenta/);
});

test("switching back to knock first from public persists", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // first switch to public
  await page.getByTestId("btn-mode-public").click();
  await page.waitForTimeout(300);
  // then back to knock
  await page.getByTestId("btn-mode-knock").click();
  await page.waitForTimeout(500);

  await page.reload();
  await waitForApp(page);
  await openSharePanel(page);

  await expect(page.getByTestId("btn-mode-knock")).toHaveClass(/border-magenta/);
});

// --- knock inbox ---

test("knock inbox section is visible in share panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await expect(page.getByTestId("knock-inbox")).toBeVisible();
});

test("knock inbox shows no pending knockz when empty", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await expect(page.getByTestId("empty-knock-inbox")).toBeVisible();
});

// --- endpoint toggle ---

test("endpoint toggle button is present", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // button shows "enable endpoint" or "disable endpoint" depending on state
  const toggleBtn = page.getByTestId("btn-toggle-endpoint");
  await expect(toggleBtn).toBeVisible();
});

// --- close ---

test("close share panel button closes the panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await page.getByTestId("btn-close-panel").click();
  await expect(page.getByTestId("btn-close-panel")).not.toBeVisible();
});

test("escape key closes the share panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-close-panel")).not.toBeVisible();
});

// --- browse a peer section ---

test("browse a peer section is visible when share panel is open", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await expect(page.getByText("browse a peer's playlistz")).toBeVisible();
});
