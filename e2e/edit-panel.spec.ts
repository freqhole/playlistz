// e2e: edit panel open/close behaviour.
//
// covers the "panel only opens every other time" bug: with songs present,
// toggling the edit button repeatedly must show the panel on every open.

import { test, expect } from "@playwright/test";
import { resetAppState, createPlaylistViaUI, addSongs } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// detect the edit panel by its root testid
const panel = (page: import("@playwright/test").Page) =>
  page.getByTestId("edit-panel");

test("edit panel opens on every toggle (empty playlist)", async ({ page }) => {
  await createPlaylistViaUI(page);

  for (let i = 0; i < 4; i++) {
    await page.getByTestId("btn-edit-playlist").click();
    await expect(panel(page)).toBeAttached({ timeout: 3000 });

    await page.getByTestId("btn-edit-playlist").click();
    await expect(panel(page)).not.toBeAttached({ timeout: 3000 });
    await expect(page.getByTestId("btn-edit-playlist")).toBeVisible();
  }
});

test("edit panel opens on every toggle (playlist with songs)", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 5);

  for (let i = 0; i < 4; i++) {
    await page.getByTestId("btn-edit-playlist").click();
    await expect(panel(page)).toBeAttached({ timeout: 3000 });

    await page.getByTestId("btn-edit-playlist").click();
    await expect(panel(page)).not.toBeAttached({ timeout: 3000 });
    // rows fly back in
    await expect(page.getByText("song-00")).toBeVisible({ timeout: 3000 });
  }
});

test("rapid double-toggle does not wedge the panel", async ({ page }) => {
  // open then immediately close before the row exit animation finishes,
  // then open again - the panel must still appear
  await createPlaylistViaUI(page);
  await addSongs(page, 5);

  await page.getByTestId("btn-edit-playlist").click();
  // close mid-animation
  await page.getByTestId("btn-edit-playlist").click();
  // re-open
  await page.getByTestId("btn-edit-playlist").click();

  await expect(panel(page)).toBeAttached({ timeout: 3000 });
});

test("escape closes the edit panel", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-edit-playlist").click();
  await expect(panel(page)).toBeAttached({ timeout: 3000 });

  await page.keyboard.press("Escape");
  await expect(panel(page)).not.toBeAttached({ timeout: 3000 });
});

test("song edit panel opens from a row and shows the title", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3);

  // rows expose an edit button on hover
  const row = page.getByText("song-00");
  await row.hover();
  await page.locator("button[title='edit song']").first().click();

  // the song edit panel shows the title input prefilled
  await expect(
    page.locator("input[value='song-00'], input[placeholder*='title']").first()
  ).toBeVisible();
});
