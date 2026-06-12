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

  // "knock first" should be the active mode
  const knockBtn = page.getByTestId("btn-mode-knock");
  await expect(knockBtn).toBeVisible();
  await expect(knockBtn).toHaveAttribute("aria-pressed", "true");
  const publicBtn = page.getByTestId("btn-mode-public");
  await expect(publicBtn).toHaveAttribute("aria-pressed", "false");
});

test("clicking anyone (public) switches the active mode", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  await page.getByTestId("btn-mode-public").click();

  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("btn-mode-knock")).toHaveAttribute("aria-pressed", "false");
});

test("mode setting persists after closing and reopening the share panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // switch to public
  await page.getByTestId("btn-mode-public").click();
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");

  // close and reopen
  await page.getByTestId("btn-close-panel").click();
  await openSharePanel(page);

  // mode should still be public
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");
});

test("mode setting persists across page reload", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // switch to public
  await page.getByTestId("btn-mode-public").click();
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");

  // close and reopen the share panel - confirms the IDB write completed
  // (aria-pressed updates sync but saveShareSettings is async)
  await page.getByTestId("btn-close-panel").click();
  await openSharePanel(page);
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");

  // reload
  await page.reload();
  await waitForApp(page);

  // reopen share panel
  await openSharePanel(page);

  // mode should still be public
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");
});

test("switching back to knock first from public persists", async ({ page }) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // switch to public then back to knock
  await page.getByTestId("btn-mode-public").click();
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("btn-mode-knock").click();
  await expect(page.getByTestId("btn-mode-knock")).toHaveAttribute("aria-pressed", "true");

  // close and reopen to confirm the IDB write landed before reload
  await page.getByTestId("btn-close-panel").click();
  await openSharePanel(page);
  await expect(page.getByTestId("btn-mode-knock")).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await waitForApp(page);
  await openSharePanel(page);

  await expect(page.getByTestId("btn-mode-knock")).toHaveAttribute("aria-pressed", "true");
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
