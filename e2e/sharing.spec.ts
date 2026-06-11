// e2e: the share panel UI. covers opening the panel, settings
// persistence, and share-link paste validation. actual p2p transfer
// needs two browser contexts + relay connectivity, so it lives behind
// the PLAYLISTZ_E2E_P2P env var (off by default).

import { test, expect } from "@playwright/test";
import { resetAppState, createPlaylistViaUI, waitForApp } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

async function openSharePanel(page: import("@playwright/test").Page) {
  await page.getByTitle("open share panel").click();
  await expect(page.getByText("sharez")).toBeVisible();
}

test("share panel opens and closes from the sidebar", async ({ page }) => {
  await waitForApp(page);
  await openSharePanel(page);

  await expect(page.getByText("enable p2p sharing")).toBeVisible();
  await expect(page.getByText("no pending knockz")).toBeVisible();

  await page.getByTitle("close share panel").click();
  await expect(page.getByText("enable p2p sharing")).toHaveCount(0);
});

test("share settings persist across panel reopen and reload", async ({
  page,
}) => {
  await waitForApp(page);
  await openSharePanel(page);

  await page.locator("input[placeholder='anonymous']").fill("doomlord");
  await page.locator("input[placeholder='anonymous']").blur();
  await page.getByText("anyone (public)").click();
  await page.waitForTimeout(300);

  // reopen
  await page.getByTitle("close share panel").click();
  await openSharePanel(page);
  await expect(page.locator("input[placeholder='anonymous']")).toHaveValue(
    "doomlord"
  );

  // reload
  await page.reload();
  await waitForApp(page);
  await openSharePanel(page);
  await expect(page.locator("input[placeholder='anonymous']")).toHaveValue(
    "doomlord",
    { timeout: 10000 }
  );
});

test("pasting an invalid share link shows an error", async ({ page }) => {
  await waitForApp(page);
  await openSharePanel(page);

  await page
    .locator("input[placeholder='paste share link or token...']")
    .fill("definitely not a share link");
  await page.getByRole("button", { name: "open", exact: true }).click();

  await expect(page.getByText("invalid share link")).toBeVisible({
    timeout: 10000,
  });
});

test("copy p2p share link button is present on a playlist", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await expect(page.getByTitle("copy p2p share link")).toBeVisible();
});

// real two-peer sharing test: requires relay connectivity, so it only
// runs when explicitly requested via PLAYLISTZ_E2E_P2P=1
test("two browsers share a playlist over p2p", async ({ browser }) => {
  test.skip(!process.env.PLAYLISTZ_E2E_P2P, "set PLAYLISTZ_E2E_P2P=1 to run");
  test.setTimeout(120_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // peer a: create a playlist and enable p2p
    await resetAppState(pageA);
    await createPlaylistViaUI(pageA);
    const title = pageA.locator("input[placeholder='playlist title']");
    await title.fill("shared doom");
    await title.blur();
    await pageA.waitForTimeout(500);

    await pageA.getByTitle("open share panel").click();
    await pageA.getByText("enable p2p sharing").click();
    await expect(
      pageA.getByText("this tab runs the p2p node")
    ).toBeVisible({ timeout: 30_000 });
    await pageA.getByTitle("close share panel").click();

    // peer a: copy the share link (read it from the clipboard)
    await ctxA.grantPermissions(["clipboard-read", "clipboard-write"]);
    await pageA.getByTitle("copy p2p share link").click();
    await expect(pageA.getByTitle("share link copied!")).toBeVisible({
      timeout: 15_000,
    });
    const shareUrl = await pageA.evaluate(() =>
      navigator.clipboard.readText()
    );
    expect(shareUrl).toContain("#share/");

    // peer b: paste the link into the share panel
    await resetAppState(pageB);
    await pageB.getByTitle("open share panel").click();
    await pageB
      .locator("input[placeholder='paste share link or token...']")
      .fill(shareUrl);
    await pageB.getByRole("button", { name: "open", exact: true }).click();
    await expect(pageB.getByText("playlist added!")).toBeVisible({
      timeout: 60_000,
    });
    await pageB.getByTitle("close share panel").click();

    // peer b: the shared playlist shows up in the sidebar
    await expect(pageB.getByText("shared doom").first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
