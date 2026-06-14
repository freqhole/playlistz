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
  const shareBtn = page.getByTestId("btn-share-playlist");
  if (!(await shareBtn.isVisible({ timeout: 1000 }).catch(() => false))) {
    await createPlaylistViaUI(page);
  }
  await shareBtn.click();
  // share panel becomes visible
  await expect(page.getByTestId("share-panel")).toBeVisible();
}

test("share panel opens and closes from the playlist header", async ({
  page,
}) => {
  await waitForApp(page);
  await openSharePanel(page);

  await expect(page.getByTestId("btn-enable-sharing")).toBeVisible();
  await expect(page.getByText("no pending knockz")).toBeVisible();

  await page.getByTestId("btn-share-playlist").click();
  await expect(page.getByTestId("share-panel")).not.toBeVisible();
});

test("share settings persist across panel reopen and reload", async ({
  page,
}) => {
  await waitForApp(page);
  await openSharePanel(page);

  await page.getByTestId("input-node-name").fill("doomlord");
  await page.getByTestId("input-node-name").blur();
  await page.getByText("anyone (public)").click();
  await page.waitForTimeout(300);

  // reopen
  await page.getByTestId("btn-share-playlist").click();
  await openSharePanel(page);
  await expect(page.getByTestId("input-node-name")).toHaveValue(
    "doomlord"
  );

  // reload
  await page.reload();
  await waitForApp(page);
  await openSharePanel(page);
  await expect(page.getByTestId("input-node-name")).toHaveValue(
    "doomlord",
    { timeout: 10000 }
  );
});

test("pasting an invalid share link shows an error", async ({ page }) => {
  await waitForApp(page);
  await openSharePanel(page);

  await page
    .getByTestId("input-paste-share-link")
    .fill("definitely not a share link");
  await page.getByTestId("btn-open-share-link").click();

  await expect(page.getByTestId("share-link-error")).toBeVisible({
    timeout: 10000,
  });
});

test("playlist header has a share button that opens the share panel", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await expect(
    page.getByTestId("input-playlist-title")
  ).toBeVisible();
  // share button is in the playlist header action row
  await expect(page.getByTestId("btn-share-playlist")).toBeVisible();
  await page.getByTestId("btn-share-playlist").click();
  await expect(page.getByTestId("btn-enable-sharing")).toBeVisible();
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
      const title = pageA.getByTestId("input-playlist-title");
      await title.fill("shared doom");
      await title.blur();
      await pageA.waitForTimeout(500);

      // peer a: open the share panel and enable p2p
      logTs("[e2e] peer a: enabling p2p from the share panel...");
      await pageA.getByTestId("btn-share-playlist").click();
      await pageA.getByTestId("btn-enable-sharing").click();

      // once the node is up the share column shows the link + copy button
      const copyBtn = pageA.getByTestId("btn-copy-share-link");
      await expect(copyBtn).toBeEnabled({ timeout: 180_000 });
      logTs("[e2e] peer a: p2p node online");
    };

    const setupB = async () => {
      // peer b: pre-boot the p2p node. the share panel lives in the playlist
      // header, so we need a playlist selected first.
      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await pageB.getByTestId("btn-share-playlist").click();
      logTs("[e2e] peer b: enabling p2p from the share panel...");
      await pageB.getByTestId("btn-enable-sharing").click();
      await expect(pageB.getByTestId("sharing-status")).toBeVisible({
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

    // peer b: paste the link into the share panel and open it
    await pageB
      .getByTestId("input-paste-share-link")
      .fill(shareUrl);
    await pageB.getByTestId("btn-open-share-link").click();
    logTs("[e2e] peer b: opening share link...");
    await expect(pageB.getByTestId("share-success")).toBeVisible({
      timeout: 120_000,
    });
    logTs("[e2e] peer b: playlist added");

    // opening a share link auto-selects the new playlist and closes the share
    // panel. wait for the share panel to dismiss then verify the playlist title
    await expect(pageB.getByTestId("share-panel")).not.toBeVisible({
      timeout: 10_000,
    });

    // peer b: the shared playlist is now selected and its title is visible
    await expect(
      pageB.getByTestId("input-playlist-title")
    ).toHaveValue("shared doom", { timeout: 30_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
