// e2e: two-peer collaboration access request and collaborative-mode tests.
//
// tests here require real iroh relay connections and are tagged @p2p.
// run with: npm run test:e2e:p2p
//
// scenarios covered:
//   - peer B requests edit access → knock appears in peer A's inbox → A accepts → B sees granted
//   - peer A enables collaborative mode → peer B's request is auto-accepted
//   - peer A denies a collaboration request → peer B sees denied status

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  logTs,
} from "./helpers.js";
import {
  getP2PNodeId,
  getP2PNodeAddr,
  seedP2PPeerAddr,
} from "./helpers/hooks.js";

// helper: enable p2p for a page, set public share mode, return the share link.
// the default share mode is "knock"; these tests subscribe without knocking,
// so we switch to public and wait for the link to rebuild (the token changes
// when the knock flag is dropped) before reading it.
async function enableP2PAndGetShareLink(
  page: import("@playwright/test").Page,
  tag: string
): Promise<string> {
  await page.getByTestId("btn-share-playlist").click();
  logTs(`[e2e] ${tag}: enabling p2p...`);
  await page.getByTestId("btn-enable-sharing").click();
  // the copy button becomes enabled once the node is online and the link built
  await expect(page.getByTestId("btn-copy-share-link")).toBeEnabled({
    timeout: 180_000,
  });
  logTs(`[e2e] ${tag}: p2p node online`);
  const shareInput = page.getByTestId("input-share-link");
  const knockLink = await shareInput.inputValue();
  await page.getByTestId("btn-mode-public").click();
  await expect(page.getByTestId("btn-mode-public")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(shareInput).not.toHaveValue(knockLink);
  const link = await shareInput.inputValue();
  expect(link).toContain("#share/");
  return link;
}

// helper: peer B subscribes to A's share link (public mode - direct sync)
async function subscribeToPublicPlaylist(
  page: import("@playwright/test").Page,
  shareUrl: string,
  tag: string,
  expectedTitle: string,
  sharerPage: import("@playwright/test").Page
): Promise<void> {
  // close share panel if open
  if (
    await page
      .getByTestId("share-panel")
      .isVisible({ timeout: 500 })
      .catch(() => false)
  ) {
    await page.getByTestId("btn-share-playlist").click();
  }
  await page.getByTestId("btn-all-playlists").click();
  await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
  // hand the sharer's reachable addr to this peer so the dial skips discovery
  // propagation instead of blindly waiting for it. both sides must be online.
  const sharerNodeId = await getP2PNodeId(sharerPage);
  const sharerAddr = await getP2PNodeAddr(sharerPage);
  await seedP2PPeerAddr(page, sharerNodeId, sharerAddr);
  await page.getByTestId("input-search-playlists").fill(shareUrl);
  logTs(`[e2e] ${tag}: opening share link...`);
  await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible({
    timeout: 120_000,
  });
  logTs(`[e2e] ${tag}: subscribed`);
  await expect(page.getByTestId("input-playlist-title")).toHaveValue(
    expectedTitle,
    { timeout: 30_000 }
  );
}

// -----------------------------------------------------------------------
// collaboration request - explicit accept
// -----------------------------------------------------------------------

test(
  "peer B requests collab access, A accepts, B sees access granted @p2p",
  async ({ browser }) => {
    test.setTimeout(600_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const fwd =
      (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
        logTs(`[${tag}] ${msg.text()}`);
      };
    pageA.on("console", fwd("peerA"));
    pageB.on("console", fwd("peerB"));

    try {
      // --- peer A: create playlist in public mode ---
      await resetAppState(pageA);
      await createPlaylistViaUI(pageA);
      await pageA
        .getByTestId("input-playlist-title")
        .fill("collab-test-accept");
      await pageA.getByTestId("input-playlist-title").blur();
      await pageA.waitForTimeout(300);

      const shareUrl = await enableP2PAndGetShareLink(pageA, "peerA");

      // set mode to public so peer B can subscribe without knocking
      await pageA.getByTestId("btn-mode-public").click();
      await expect(pageA.getByTestId("btn-mode-public")).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      logTs("[e2e] peerA: mode set to public");

      // close share panel
      await pageA.getByTestId("btn-share-playlist").click();

      // --- peer B: boot p2p and subscribe to A's playlist ---
      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await enableP2PAndGetShareLink(pageB, "peerB");
      // close B's own share panel before subscribing
      await pageB.getByTestId("btn-share-playlist").click();

      await subscribeToPublicPlaylist(
        pageB,
        shareUrl,
        "peerB",
        "collab-test-accept",
        pageA
      );

      // B should see the subscribed banner (read only)
      await expect(pageB.getByTestId("subscribed-banner")).toBeVisible();
      logTs("[e2e] peerB: subscribed, read-only banner visible");

      // --- peer B: request collaboration access ---
      await pageB.getByTestId("btn-share-playlist").click();
      await pageB.getByTestId("share-panel").waitFor({ timeout: 5000 });
      await expect(
        pageB.getByTestId("btn-request-collab-access")
      ).toBeVisible();

      await pageB
        .getByTestId("input-collab-request-message")
        .fill("hey, can i edit this?");
      await pageB.getByTestId("btn-request-collab-access").click();
      logTs("[e2e] peerB: sent collaboration request");

      // B should see pending status
      await expect(pageB.getByTestId("collab-request-status")).toContainText(
        "waiting for owner approval",
        { timeout: 30_000 }
      );
      logTs("[e2e] peerB: status shows waiting for approval");

      // --- peer A: check knock inbox ---
      await pageA.getByTestId("btn-share-playlist").click();
      await pageA.getByTestId("share-panel").waitFor({ timeout: 5000 });

      // wait for the knock inbox to appear on A's panel
      await expect(pageA.getByTestId("knock-inbox")).toBeVisible({
        timeout: 60_000,
      });
      logTs("[e2e] peerA: knock inbox has pending request");

      // accept the knock (accept all docs)
      const acceptBtn = pageA.getByRole("button", { name: /accept/ }).first();
      await acceptBtn.click();
      logTs("[e2e] peerA: accepted collaboration request");

      // inbox should clear
      await expect(pageA.getByTestId("knock-inbox")).not.toBeVisible({
        timeout: 15_000,
      });

      // --- peer B: check if accepted via "check if accepted" button ---
      // B learns about the grant either via a proactive knock_notify push or by
      // re-checking. the push can be dropped and the first re-check can race the
      // owner persisting the grant, so retry the check until access is granted
      // (this mirrors what a user would do - click "check" again). on success the
      // banner flips to granted and/or the request-edit-access affordance goes
      // away as B transitions from subscriber to collaborator.
      const statusEl = pageB.getByTestId("collab-request-status");
      const requestBtn = pageB.getByTestId("btn-request-collab-access");
      await expect(async () => {
        const checkBtn = pageB.getByRole("button", {
          name: "check if accepted",
        });
        if (await checkBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await checkBtn.click();
          logTs("[e2e] peerB: clicked check if accepted");
        }
        const bannerGranted = (
          (await statusEl.textContent({ timeout: 500 }).catch(() => "")) ?? ""
        ).includes("access granted");
        const requestGone = !(await requestBtn
          .isVisible({ timeout: 500 })
          .catch(() => false));
        expect(bannerGranted || requestGone).toBe(true);
      }).toPass({ timeout: 60_000 });
      logTs("[e2e] peerB: access granted confirmed");
    } finally {
      await Promise.allSettled([ctxA.close(), ctxB.close()]);
    }
  }
);

// -----------------------------------------------------------------------
// collaboration request - denied
// -----------------------------------------------------------------------

test(
  "peer A denies collaboration request, peer B sees denied @p2p",
  async ({ browser }) => {
    test.setTimeout(600_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const fwd =
      (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
        logTs(`[${tag}] ${msg.text()}`);
      };
    pageA.on("console", fwd("peerA"));
    pageB.on("console", fwd("peerB"));

    try {
      await resetAppState(pageA);
      await createPlaylistViaUI(pageA);
      await pageA.getByTestId("input-playlist-title").fill("collab-test-deny");
      await pageA.getByTestId("input-playlist-title").blur();
      await pageA.waitForTimeout(300);

      const shareUrl = await enableP2PAndGetShareLink(pageA, "peerA");
      await pageA.getByTestId("btn-mode-public").click();
      await pageA.getByTestId("btn-share-playlist").click();

      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await enableP2PAndGetShareLink(pageB, "peerB");
      await pageB.getByTestId("btn-share-playlist").click();

      await subscribeToPublicPlaylist(
        pageB,
        shareUrl,
        "peerB",
        "collab-test-deny",
        pageA
      );

      // B requests access
      await pageB.getByTestId("btn-share-playlist").click();
      await pageB.getByTestId("share-panel").waitFor({ timeout: 5000 });
      await pageB.getByTestId("btn-request-collab-access").click();
      logTs("[e2e] peerB: sent collaboration request");

      await expect(pageB.getByTestId("collab-request-status")).toContainText(
        "waiting for owner approval",
        { timeout: 30_000 }
      );

      // A denies
      await pageA.getByTestId("btn-share-playlist").click();
      await pageA.getByTestId("share-panel").waitFor({ timeout: 5000 });
      await expect(pageA.getByTestId("knock-inbox")).toBeVisible({
        timeout: 60_000,
      });

      const denyBtn = pageA.getByRole("button", { name: "deny" }).first();
      await denyBtn.click();
      logTs("[e2e] peerA: denied collaboration request");

      // B retries to get denied status
      const checkBtn = pageB.getByRole("button", { name: "check if accepted" });
      if (await checkBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await checkBtn.click();
        await expect(pageB.getByTestId("collab-request-status")).toContainText(
          "access denied",
          { timeout: 30_000 }
        );
        logTs("[e2e] peerB: denied status confirmed");
      }
    } finally {
      await Promise.allSettled([ctxA.close(), ctxB.close()]);
    }
  }
);

// -----------------------------------------------------------------------
// collaborative mode - auto-accept
// -----------------------------------------------------------------------

test(
  "collaborative mode auto-accepts edit request from subscriber @p2p",
  async ({ browser }) => {
    test.setTimeout(600_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const fwd =
      (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
        logTs(`[${tag}] ${msg.text()}`);
      };
    pageA.on("console", fwd("peerA"));
    pageB.on("console", fwd("peerB"));

    try {
      await resetAppState(pageA);
      await createPlaylistViaUI(pageA);
      await pageA
        .getByTestId("input-playlist-title")
        .fill("collab-test-auto");
      await pageA.getByTestId("input-playlist-title").blur();
      await pageA.waitForTimeout(300);

      const shareUrl = await enableP2PAndGetShareLink(pageA, "peerA");

      // set mode to public + enable collaborative editing
      await pageA.getByTestId("btn-mode-public").click();
      await pageA.getByTestId("btn-toggle-collaborative").click();
      await expect(
        pageA.getByTestId("btn-toggle-collaborative")
      ).toHaveAttribute("aria-pressed", "true");
      logTs("[e2e] peerA: mode=public, collaborative=on");

      await pageA.getByTestId("btn-share-playlist").click();

      // peer B subscribes
      await resetAppState(pageB);
      await createPlaylistViaUI(pageB);
      await enableP2PAndGetShareLink(pageB, "peerB");
      await pageB.getByTestId("btn-share-playlist").click();

      await subscribeToPublicPlaylist(
        pageB,
        shareUrl,
        "peerB",
        "collab-test-auto",
        pageA
      );

      // B requests collaboration access
      await pageB.getByTestId("btn-share-playlist").click();
      await pageB.getByTestId("share-panel").waitFor({ timeout: 5000 });
      await pageB.getByTestId("btn-request-collab-access").click();
      logTs("[e2e] peerB: sent collaboration request (should auto-accept)");

      // should get immediate "access granted" since collaborative is on
      await expect(pageB.getByTestId("collab-request-status")).toContainText(
        "access granted",
        { timeout: 60_000 }
      );
      logTs("[e2e] peerB: access granted automatically");

      // no knock should appear in A's inbox (auto-accepted server-side)
      // wait a moment then confirm knock inbox is absent
      await pageA.getByTestId("btn-share-playlist").click();
      await pageA.getByTestId("share-panel").waitFor({ timeout: 5000 });
      await expect(pageA.getByTestId("knock-inbox")).not.toBeVisible({
        timeout: 5000,
      });
      logTs("[e2e] peerA: knock inbox empty (auto-accepted, no pending knocks)");
    } finally {
      await Promise.allSettled([ctxA.close(), ctxB.close()]);
    }
  }
);
