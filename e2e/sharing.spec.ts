// e2e: the share panel UI. covers opening the panel, settings
// persistence, share-link paste validation, and a real two-browser
// p2p transfer over the iroh relay (slow; tagged @p2p so you can
// skip it with: npm run test:e2e -- --grep-invert @p2p)

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  waitForApp,
  logTs,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

async function openSharePanel(page: import("@playwright/test").Page) {
  // the share panel lives in the playlist header - a playlist must be selected
  const shareBtn = page.getByTitle("share playlist");
  if (!(await shareBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    await createPlaylistViaUI(page);
  }
  await shareBtn.click();
  // "sharez" label appears in the share panel header bar
  await expect(page.getByText("sharez")).toBeVisible();
}

test("share panel opens and closes from the playlist header", async ({
  page,
}) => {
  await waitForApp(page);
  await openSharePanel(page);

  await expect(page.getByText("enable p2p sharing")).toBeVisible();
  await expect(page.getByText("no pending knockz")).toBeVisible();

  await page.getByTestId("btn-close-panel").click();
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
  await page.getByTestId("btn-close-panel").click();
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

test("playlist header has a share button that opens the share panel", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await expect(
    page.locator("input[placeholder='playlist title']")
  ).toBeVisible();
  // share button is in the playlist header action row
  await expect(page.getByTitle("share playlist")).toBeVisible();
  await page.getByTitle("share playlist").click();
  await expect(page.getByText("enable p2p sharing")).toBeVisible();
});

// real two-peer sharing test over the iroh relay. slow (node boot takes
// 1-2 min per peer) but it exercises the full share-link flow end to end.
// tagged @p2p - skip with: npm run test:e2e -- --grep-invert @p2p
test("two browsers share a playlist over p2p @p2p", async ({ browser }) => {
  test.setTimeout(480_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // surface browser console output (timestamped) so stalls are diagnosable
  const forward = (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
    logTs(`[${tag}] ${msg.text()}`);
  };
  pageA.on("console", forward("peerA"));
  pageB.on("console", forward("peerB"));
  pageA.on("pageerror", (err) => logTs(`[peerA pageerror] ${err}`));
  pageB.on("pageerror", (err) => logTs(`[peerB pageerror] ${err}`));

  try {
    // boot both peers' p2p nodes in parallel - each takes ~1-2 min to
    // come online (relay handshake), so doing them sequentially is slow
    const setupA = async () => {
      // peer a: create a playlist and enable p2p
      await resetAppState(pageA);
      await createPlaylistViaUI(pageA);
      const title = pageA.locator("input[placeholder='playlist title']");
      await title.fill("shared doom");
      await title.blur();
      await pageA.waitForTimeout(500);

      // peer a: open the edit panel and enable p2p from the share column
      // (the sidebar auto-collapses once a playlist is selected, so the
      // sidebar share panel is off-screen here)
      logTs("[e2e] peer a: enabling p2p from the edit panel...");
      await pageA.getByTitle("edit playlist").click();
      await pageA.getByText("enable p2p sharing").click();

      // once the node is up the share column shows the link + copy button
      const copyBtn = pageA.getByRole("button", { name: "copy share link" });
      await expect(copyBtn).toBeEnabled({ timeout: 180_000 });
      logTs("[e2e] peer a: p2p node online");
    };

    const setupB = async () => {
      // peer b: pre-boot the p2p node. the share panel lives in the playlist
      // header, so we need a playlist selected first.
      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await pageB.getByTitle("share playlist").click();
      logTs("[e2e] peer b: enabling p2p from the share panel...");
      await pageB.getByText("enable p2p sharing").click();
      await expect(pageB.getByText("online")).toBeVisible({
        timeout: 180_000,
      });
      logTs("[e2e] peer b: p2p node online");
    };

    await Promise.all([setupA(), setupB()]);

    // read the share url straight from the readonly input (no clipboard)
    const shareUrl = await pageA
      .locator("input[readonly]")
      .first()
      .inputValue();
    expect(shareUrl).toContain("#share/");
    logTs(`[e2e] peer a: share url: ${shareUrl.slice(0, 60)}...`);

    // peer b: paste the link into the share panel
    await pageB
      .locator("input[placeholder='paste share link or token...']")
      .fill(shareUrl);
    await pageB.getByRole("button", { name: "open", exact: true }).click();
    logTs("[e2e] peer b: opening share link...");
    await expect(pageB.getByText("playlist added!")).toBeVisible({
      timeout: 120_000,
    });
    logTs("[e2e] peer b: playlist added");

    // the synced playlist auto-selects, which collapses the sidebar and can
    // unmount the share panel - only close it if it's still on screen
    const closeBtn = pageB.getByTestId("btn-close-panel");
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 5_000 }).catch(() => {});
    }

    // peer b: the shared playlist shows up in the sidebar
    await expect(pageB.getByText("shared doom").first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
