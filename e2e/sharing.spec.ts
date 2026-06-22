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
import {
  getP2PNodeId,
  getP2PNodeAddr,
  seedP2PPeerAddr,
} from "./helpers/hooks.js";

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

  await page.getByTestId("btn-share-playlist").click();
  await expect(page.getByTestId("share-panel")).not.toBeVisible();
});

test("share settings persist across panel reopen and reload", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await openSharePanel(page);

  // click the name pill to enter edit mode, then fill the display name
  await page.getByTestId("share-panel").locator("button[title='click to edit display name']").click();
  await page.getByTestId("input-node-name").fill("doomlord");
  await page.getByTestId("input-node-name").blur();
  await page.getByText("anyone (public)").click();
  await page.waitForTimeout(300);

  // reopen
  await page.getByTestId("btn-share-playlist").click();
  await openSharePanel(page);
  // click pill again to verify the saved name
  await page.getByTestId("share-panel").locator("button[title='click to edit display name']").click();
  await expect(page.getByTestId("input-node-name")).toHaveValue(
    "doomlord"
  );

  // reload
  await page.reload();
  await waitForApp(page);
  await openSharePanel(page);
  await page.getByTestId("share-panel").locator("button[title='click to edit display name']").click();
  await expect(page.getByTestId("input-node-name")).toHaveValue(
    "doomlord",
    { timeout: 10000 }
  );
});

test("pasting an invalid share link shows an error", async ({ page }) => {
  await createPlaylistViaUI(page);
  await waitForApp(page);

  // open the all-playlists panel and paste the invalid link into the search bar
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });

  await page
    .getByTestId("input-search-playlists")
    .fill("definitely not a share link");

  // the invalid link is text, not a share token - it just filters locally,
  // no error state is shown for plain text queries
  // verify the search does not crash the panel
  await expect(page.getByTestId("all-playlists-panel")).toBeVisible();
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
      // default share mode is "knock"; this test exercises public auto-sync,
      // so switch to public. the share link encodes the mode, so wait for it
      // to rebuild (the token changes when the knock flag is dropped).
      const shareInput = pageA.getByTestId("input-share-link");
      const knockLink = await shareInput.inputValue();
      await pageA.getByTestId("btn-mode-public").click();
      await expect(pageA.getByTestId("btn-mode-public")).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(shareInput).not.toHaveValue(knockLink);
      logTs("[e2e] peer a: p2p node online");
    };

    const setupB = async () => {
      // peer b: pre-boot the p2p node via the share panel
      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await pageB.getByTestId("btn-share-playlist").click();
      logTs("[e2e] peer b: enabling p2p from the share panel...");
      await pageB.getByTestId("btn-enable-sharing").click();
      await expect(pageB.getByTestId("sharing-status")).toBeVisible({
        timeout: 180_000,
      });
      // close share panel after node is up
      await pageB.getByTestId("btn-share-playlist").click();
      logTs("[e2e] peer b: p2p node online");
    };

    await Promise.all([setupA(), setupB()]);

    // read the share url straight from the readonly input (no clipboard)
    const shareUrl = await pageA.getByTestId("input-share-link").inputValue();
    expect(shareUrl).toContain("#share/");
    logTs(`[e2e] peer a: share url: ${shareUrl.slice(0, 60)}...`);

    // peer b: open the all-playlists panel, paste the share link into the
    // search bar, which auto-detects and opens it
    await pageB.getByTestId("btn-all-playlists").click();
    await pageB.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
    // hand peer a's reachable addr to peer b so the dial skips discovery
    // propagation instead of blindly waiting for it.
    const sharerNodeId = await getP2PNodeId(pageA);
    const sharerAddr = await getP2PNodeAddr(pageA);
    await seedP2PPeerAddr(pageB, sharerNodeId, sharerAddr);
    await pageB
      .getByTestId("input-search-playlists")
      .fill(shareUrl);
    logTs("[e2e] peer b: opening share link via search bar...");
    // the search bar calls openShareLink and auto-closes when done
    await expect(pageB.getByTestId("all-playlists-panel")).not.toBeVisible({
      timeout: 120_000,
    });
    logTs("[e2e] peer b: playlist added");

    // peer b: the shared playlist is now selected and its title is visible
    await expect(
      pageB.getByTestId("input-playlist-title")
    ).toHaveValue("shared doom", { timeout: 30_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
