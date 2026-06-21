// e2e: multi-peer p2p sync tests.
//
// tests here require real iroh relay connections and are tagged @p2p.
// run with: npm run test:e2e:p2p
//
// - 3-browser triangular sync: verifies automerge changes propagate to a peer
//   that was not the direct source (A→B and A→C, then B sees C's additions)
// - cli zip peer: downloads a zip from peer A, serves it via the
//   freqhole-playlistz-cli.mjs --http subprocess, confirms the cli-served app
//   joins the relay and receives automerge updates

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import JSZip from "jszip";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  makePng,
  logTs,
  getDocIndexEntries,
  patchDocIndexEntry,
} from "./helpers.js";

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "freqhole-playlistz-cli.mjs");

// extract a JSZip instance to a temp directory, return the serve root
async function extractZipToTmp(zipBuf: Buffer, prefix: string): Promise<string> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const zip = await JSZip.loadAsync(zipBuf);
  const writes: Promise<void>[] = [];
  zip.forEach((rel, file) => {
    if (file.dir) return;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writes.push(file.async("nodebuffer").then((buf) => fs.writeFileSync(dest, buf)));
  });
  await Promise.all(writes);
  // find the subdirectory that contains index.html
  for (const entry of fs.readdirSync(outDir)) {
    const sub = path.join(outDir, entry);
    if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, "index.html"))) {
      return sub;
    }
  }
  return outDir;
}

// ensure the standalone bundle exists (required for cli zip peer test)
function ensureBundleBuilt(): void {
  if (fs.existsSync(CLI_PATH)) return;
  console.log("[p2p-multi] cli bundle missing - running build:standalone...");
  child_process.execSync("npm run build:standalone", { cwd: REPO_ROOT, stdio: "inherit" });
}

// start the cli http subprocess. returns { url, proc, port, cleanup }.
// the cli prints "http://localhost:PORT" to stdout once the server is ready.
async function startCliServer(
  serveDir: string,
  port: number
): Promise<{ url: string; cleanup: () => void }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port) };
    const proc = child_process.spawn(
      process.execPath, // node
      [CLI_PATH, "--http", serveDir],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );

    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error(`cli server did not start on port ${port} within 10s`));
      }
    }, 10_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logTs(`[cli-server] ${text.trim()}`);
      if (!ready && text.includes(`http://localhost:${port}`)) {
        ready = true;
        clearTimeout(timeout);
        resolve({
          url: `http://localhost:${port}`,
          cleanup: () => {
            try { proc.kill(); } catch { /* ignore */ }
          },
        });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      logTs(`[cli-server stderr] ${chunk.toString().trim()}`);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`cli server exited with code ${code} before becoming ready`));
      }
    });
  });
}

// port range: avoid collisions with vite (5917) and zip-bundle tests (5920-5922)
const P2P_MULTI_PORT_BASE = 5930;

// -----------------------------------------------------------------------
// 3-browser triangular sync
// -----------------------------------------------------------------------
// topology:
//   peer A  creates "triangular-doom", adds song, shares with B and C
//   peer B  opens A's share link, syncs
//   peer C  opens A's share link, syncs
//   then:   peer B renames the playlist -> peer C should see the rename
//
// this verifies that the automerge relay properly triangulates changes
// (C does not need a direct stream from B to receive B's edits)

test("three peers triangulate automerge changes @p2p", async ({ browser }) => {
  test.setTimeout(600_000); // 10 min - 3 nodes bootstrapping takes ~3 min combined

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();

  const fwd = (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
    logTs(`[${tag}] ${msg.text()}`);
  };
  pageA.on("console", fwd("peerA"));
  pageB.on("console", fwd("peerB"));
  pageC.on("console", fwd("peerC"));

  try {
    // --- boot all three peers in parallel ---
    const bootPeer = async (
      page: import("@playwright/test").Page,
      tag: string
    ) => {
      await resetAppState(page);
      await createPlaylistViaUI(page);
      await page.getByTestId("btn-share-playlist").click();
      logTs(`[e2e] ${tag}: enabling p2p...`);
      await page.getByTestId("btn-enable-sharing").click();
      await expect(page.getByTestId("sharing-status")).toBeVisible({
        timeout: 180_000,
      });
      logTs(`[e2e] ${tag}: p2p node online`);
    };

    await Promise.all([
      bootPeer(pageA, "peerA"),
      bootPeer(pageB, "peerB"),
      bootPeer(pageC, "peerC"),
    ]);

    // --- peer A: name the playlist and build a share link ---
    await pageA.getByTestId("input-playlist-title").fill("triangular-doom");
    await pageA.getByTestId("input-playlist-title").blur();
    await pageA.waitForTimeout(500);

    const shareUrl = await pageA.locator("input[readonly]").first().inputValue();
    expect(shareUrl).toContain("#share/");
    logTs(`[e2e] peerA: share url: ${shareUrl.slice(0, 60)}...`);

    // --- close share panel on A so it is out of the way ---
    await pageA.getByTestId("btn-share-playlist").click();

    // --- peers B and C open the share link via the all-playlists search bar ---
    const openShareOnPeer = async (
      page: import("@playwright/test").Page,
      tag: string
    ) => {
      // close the share panel first (it opened during boot)
      if (await page.getByTestId("share-panel").isVisible({ timeout: 500 }).catch(() => false)) {
        await page.getByTestId("btn-share-playlist").click();
      }
      await page.getByTestId("btn-all-playlists").click();
      await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
      // give the iroh relay time to propagate this node's addresses before connecting;
      // open_bi has a ~2-minute internal timeout when the peer is not yet discoverable
      await page.waitForTimeout(20_000);
      await page.getByTestId("input-search-playlists").fill(shareUrl);
      logTs(`[e2e] ${tag}: opening share link...`);
      await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible({
        timeout: 120_000,
      });
      logTs(`[e2e] ${tag}: share link opened`);
    };

    await Promise.all([
      openShareOnPeer(pageB, "peerB"),
      openShareOnPeer(pageC, "peerC"),
    ]);

    // confirm B and C both received the initial title from A
    await expect(pageB.getByTestId("input-playlist-title")).toHaveValue(
      "triangular-doom",
      { timeout: 30_000 }
    );
    await expect(pageC.getByTestId("input-playlist-title")).toHaveValue(
      "triangular-doom",
      { timeout: 30_000 }
    );
    logTs("[e2e] B and C confirmed initial sync from A");

    // --- peer B renames the playlist ---
    // click three times to select all, then type to replace
    await pageB.getByTestId("input-playlist-title").click({ clickCount: 3 });
    await pageB.getByTestId("input-playlist-title").fill("doom-renamed-by-b");
    await pageB.getByTestId("input-playlist-title").blur();
    await pageB.waitForTimeout(500);
    logTs("[e2e] peerB: renamed playlist to doom-renamed-by-b");

    // --- peer C should see B's rename (triangulated via relay, not direct B→C stream) ---
    await expect(pageC.getByTestId("input-playlist-title")).toHaveValue(
      "doom-renamed-by-b",
      { timeout: 60_000 }
    );
    logTs("[e2e] peerC: confirmed rename from B propagated");

    // --- peer A should also see B's rename ---
    await expect(pageA.getByTestId("input-playlist-title")).toHaveValue(
      "doom-renamed-by-b",
      { timeout: 30_000 }
    );
    logTs("[e2e] peerA: confirmed rename from B propagated");
  } finally {
    await Promise.allSettled([ctxA.close(), ctxB.close(), ctxC.close()]);
  }
});

// -----------------------------------------------------------------------
// cli zip peer
// -----------------------------------------------------------------------
// peer A creates a playlist with songs, shares it, downloads a zip.
// the zip is extracted and served by the freqhole-playlistz-cli.mjs --http
// subprocess (port P2P_MULTI_PORT_BASE). a third browser context opens the
// cli-served app, enables p2p, opens A's share link, and verifies sync.
// then A renames the playlist and the cli-served peer sees the change.

test("cli-served zip app joins relay and syncs with peers @p2p", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  ensureBundleBuilt();

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const fwd = (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
    logTs(`[${tag}] ${msg.text()}`);
  };
  pageA.on("console", fwd("peerA"));
  pageB.on("console", fwd("cliPeer"));

  let tmpDir: string | null = null;
  let cliCleanup: (() => void) | null = null;

  try {
    // --- peer A: create playlist, enable p2p, add a song ---
    await resetAppState(pageA);
    await createPlaylistViaUI(pageA);
    const title = pageA.getByTestId("input-playlist-title");
    await title.fill("cli-peer-test");
    await title.blur();
    await pageA.waitForTimeout(300);

    await addSongs(pageA, 2);

    logTs("[e2e] peerA: enabling p2p...");
    await pageA.getByTestId("btn-share-playlist").click();
    await pageA.getByTestId("btn-enable-sharing").click();
    const copyBtn = pageA.getByTestId("btn-copy-share-link");
    await expect(copyBtn).toBeEnabled({ timeout: 180_000 });
    logTs("[e2e] peerA: p2p node online");

    const shareUrl = await pageA.locator("input[readonly]").first().inputValue();
    expect(shareUrl).toContain("#share/");
    logTs(`[e2e] peerA: share url: ${shareUrl.slice(0, 60)}...`);

    // close the share panel so the download button is accessible
    await pageA.getByTestId("btn-share-playlist").click();

    // --- peer A: download the zip ---
    const downloadPromise = pageA.waitForEvent("download", { timeout: 30_000 });
    await pageA.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipBuf = fs.readFileSync((await download.path())!);
    logTs("[e2e] peerA: zip downloaded");

    // --- extract zip and start cli http server ---
    tmpDir = await extractZipToTmp(zipBuf, "playlistz-e2e-clipeer-");
    logTs(`[e2e] zip extracted to: ${tmpDir}`);

    const cli = await startCliServer(tmpDir, P2P_MULTI_PORT_BASE);
    cliCleanup = cli.cleanup;
    logTs(`[e2e] cli server started at ${cli.url}`);

    // --- cli peer: navigate to the cli-served app ---
    await pageB.goto(cli.url);
    // the standalone app uses the <freqhole-playlistz> web component; wait for
    // it to finish booting (same heading sentinel as zip-bundle tests)
    await pageB.getByRole("heading", { name: "playlistz" }).waitFor({
      timeout: 15_000,
    });
    logTs("[e2e] cli peer: app loaded");

    // the zip contains A's songs from the exported playlist data
    await expect(pageB.getByText("song-00")).toBeVisible({ timeout: 10_000 });

    // --- cli peer: enable p2p and open A's share link ---
    // the standalone web component renders the share button in its own header
    await pageB.getByTestId("btn-share-playlist").click();
    logTs("[e2e] cli peer: enabling p2p...");
    await pageB.getByTestId("btn-enable-sharing").click();
    await expect(pageB.getByTestId("sharing-status")).toBeVisible({
      timeout: 180_000,
    });
    logTs("[e2e] cli peer: p2p node online");

    // open A's share link via the search bar
    if (await pageB.getByTestId("share-panel").isVisible({ timeout: 500 }).catch(() => false)) {
      await pageB.getByTestId("btn-share-playlist").click();
    }
    await pageB.getByTestId("btn-all-playlists").click();
    await pageB.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
    // give the iroh relay time to propagate this node's addresses before connecting;
    // open_bi has a ~2-minute internal timeout when the peer is not yet discoverable
    await pageB.waitForTimeout(20_000);
    await pageB.getByTestId("input-search-playlists").fill(shareUrl);
    logTs("[e2e] cli peer: opening share link...");
    await expect(pageB.getByTestId("all-playlists-panel")).not.toBeVisible({
      timeout: 120_000,
    });
    logTs("[e2e] cli peer: share link opened");

    // confirm initial sync
    await expect(pageB.getByTestId("input-playlist-title")).toHaveValue(
      "cli-peer-test",
      { timeout: 30_000 }
    );
    logTs("[e2e] cli peer: confirmed initial sync from peerA");

    // --- peer A renames the playlist - cli peer should receive the update ---
    await pageA.getByTestId("input-playlist-title").click({ clickCount: 3 });
    await pageA.getByTestId("input-playlist-title").fill("cli-peer-updated");
    await pageA.getByTestId("input-playlist-title").blur();
    await pageA.waitForTimeout(500);
    logTs("[e2e] peerA: renamed playlist to cli-peer-updated");

    await expect(pageB.getByTestId("input-playlist-title")).toHaveValue(
      "cli-peer-updated",
      { timeout: 60_000 }
    );
    logTs("[e2e] cli peer: confirmed rename from peerA propagated");
  } finally {
    cliCleanup?.();
    await Promise.allSettled([ctxA.close(), ctxB.close()]);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// collaborative editing sync
// -----------------------------------------------------------------------
// topology:
//   peer A  creates a playlist with 3 songs, sets mode to "public", shares
//   peer B  opens A's share link, then gets promoted to editor (docIndex patch)
//   peer C  opens A's share link (stays subscribed / read-only)
//
// collaboration round 1 - peer B edits:
//   B  changes the description
//   B  removes song-00
//   B  adds a new song
//   A  and C see the updated description and updated song count (3 total)
//
// collaboration round 2 - peer A adds songs:
//   A  adds 2 more songs (5 total)
//   B  and C see 5 songs
//
// this verifies the full bidirectional automerge sync loop and that all
// document mutations (description, song add, song remove) propagate to every peer.

test(
  "collaborative playlist editing syncs across three peers @p2p",
  async ({ browser }) => {
    test.setTimeout(600_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();

    const fwd = (tag: string) => (msg: import("@playwright/test").ConsoleMessage) =>
      logTs(`[${tag}] ${msg.text()}`);
    pageA.on("console", fwd("peerA"));
    pageB.on("console", fwd("peerB"));
    pageC.on("console", fwd("peerC"));

    try {
      // --- peer A: create playlist with 3 songs and enable p2p ---
      await resetAppState(pageA);
      await createPlaylistViaUI(pageA);
      await pageA.getByTestId("input-playlist-title").fill("collab-test-playlist");
      await pageA.getByTestId("input-playlist-title").blur();
      await pageA.waitForTimeout(300);

      // add 3 songs so we can remove one and still have a healthy count to check
      await addSongs(pageA, 3);
      logTs("[e2e] peerA: 3 songs added");

      // open share panel, enable p2p, then set mode to "public" so B's edits are accepted
      await pageA.getByTestId("btn-share-playlist").click();
      await pageA.getByTestId("btn-enable-sharing").click();
      const copyBtn = pageA.getByTestId("btn-copy-share-link");
      await expect(copyBtn).toBeEnabled({ timeout: 180_000 });
      logTs("[e2e] peerA: p2p node online");
      await pageA.getByTestId("btn-mode-public").click();
      await expect(pageA.getByTestId("btn-mode-public")).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 5000 }
      );
      logTs("[e2e] peerA: mode set to public");

      const shareUrl = await pageA.locator("input[readonly]").first().inputValue();
      expect(shareUrl).toContain("#share/");
      logTs(`[e2e] peerA: share url: ${shareUrl.slice(0, 60)}...`);

      // close share panel
      await pageA.getByTestId("btn-share-playlist").click();

      // --- pre-boot B and C p2p nodes in parallel (each takes ~1-2 min) ---
      const bootPeer = async (
        page: import("@playwright/test").Page,
        tag: string
      ) => {
        await resetAppState(page);
        await createPlaylistViaUI(page);
        await page.getByTestId("btn-share-playlist").click();
        logTs(`[e2e] ${tag}: enabling p2p...`);
        await page.getByTestId("btn-enable-sharing").click();
        await expect(page.getByTestId("sharing-status")).toBeVisible({
          timeout: 180_000,
        });
        logTs(`[e2e] ${tag}: p2p node online`);
        // close share panel
        await page.getByTestId("btn-share-playlist").click();
      };

      await Promise.all([bootPeer(pageB, "peerB"), bootPeer(pageC, "peerC")]);

      // --- both B and C open A's share link via the all-playlists search bar ---
      const openShareLink = async (
        page: import("@playwright/test").Page,
        tag: string
      ) => {
        await page.getByTestId("btn-all-playlists").click();
        await page.getByTestId("all-playlists-panel").waitFor({ timeout: 5000 });
        // give the iroh relay time to propagate this node's addresses before connecting;
        // open_bi has a ~2-minute internal timeout when the peer is not yet discoverable
        await page.waitForTimeout(20_000);
        await page.getByTestId("input-search-playlists").fill(shareUrl);
        logTs(`[e2e] ${tag}: opening share link...`);
        await expect(page.getByTestId("all-playlists-panel")).not.toBeVisible({
          timeout: 120_000,
        });
        logTs(`[e2e] ${tag}: share link opened`);
      };

      await Promise.all([
        openShareLink(pageB, "peerB"),
        openShareLink(pageC, "peerC"),
      ]);

      // confirm B and C received A's initial content
      await expect(pageB.getByTestId("input-playlist-title")).toHaveValue(
        "collab-test-playlist",
        { timeout: 30_000 }
      );
      await expect(pageC.getByTestId("input-playlist-title")).toHaveValue(
        "collab-test-playlist",
        { timeout: 30_000 }
      );
      // 3 songs visible on both
      await expect(pageB.getByTestId("song-row")).toHaveCount(3, { timeout: 30_000 });
      await expect(pageC.getByTestId("song-row")).toHaveCount(3, { timeout: 30_000 });
      logTs("[e2e] B and C confirmed initial sync: 3 songs");

      // ---------------------------------------------------------------
      // round 1: peer B makes edits
      // promote B to editor by clearing remoteNodeId so the UI unlocks
      // ---------------------------------------------------------------
      const bEntries = await getDocIndexEntries(pageB);
      const sharedEntry = bEntries.find((e) => e.source === "shared");
      if (!sharedEntry) throw new Error("peerB: no shared docIndex entry found");
      await patchDocIndexEntry(pageB, sharedEntry.docId, { remoteNodeId: null as unknown as undefined });
      await pageB.waitForTimeout(500); // let reactive effects settle
      logTs("[e2e] peerB: promoted to editor (remoteNodeId cleared)");

      // B changes the description
      const descInput = pageB.getByTestId("input-playlist-description");
      await expect(descInput).toBeEnabled({ timeout: 5000 });
      await descInput.fill("collab-edited-by-b");
      await descInput.blur();
      await pageB.waitForTimeout(300);
      logTs("[e2e] peerB: description updated");

      // B removes song-00 (hover the first row, click remove)
      await pageB.getByTestId("song-row").first().hover();
      await pageB.getByTestId("btn-remove-song").first().click();
      logTs("[e2e] peerB: song-00 removed (2 songs remain)");

      // B adds a new song (file drop, same helper as addSongs)
      await addSongs(pageB, 1, 1);
      logTs("[e2e] peerB: new song added (3 songs total on B)");

      // --- A and C should converge to B's state ---
      // description change visible on A
      await expect(pageA.getByTestId("input-playlist-description")).toHaveValue(
        "collab-edited-by-b",
        { timeout: 60_000 }
      );
      logTs("[e2e] peerA: confirmed description update from B");

      // description change visible on C (disabled but still has the value)
      await expect(pageC.getByTestId("input-playlist-description")).toHaveValue(
        "collab-edited-by-b",
        { timeout: 60_000 }
      );
      logTs("[e2e] peerC: confirmed description update from B");

      // song count: A started with 3, B removed 1 and added 1 → still 3
      await expect(pageA.getByTestId("song-row")).toHaveCount(3, { timeout: 60_000 });
      await expect(pageC.getByTestId("song-row")).toHaveCount(3, { timeout: 60_000 });
      logTs("[e2e] A and C confirmed song count = 3 after B's edits");

      // ---------------------------------------------------------------
      // round 2: peer A adds 2 more songs → all peers see 5
      // ---------------------------------------------------------------
      await addSongs(pageA, 2, 1);
      logTs("[e2e] peerA: 2 more songs added (5 total)");

      await expect(pageA.getByTestId("song-row")).toHaveCount(5, { timeout: 30_000 });

      await expect(pageB.getByTestId("song-row")).toHaveCount(5, { timeout: 60_000 });
      logTs("[e2e] peerB: confirmed 5 songs from peerA");

      await expect(pageC.getByTestId("song-row")).toHaveCount(5, { timeout: 60_000 });
      logTs("[e2e] peerC: confirmed 5 songs from peerA");

      // A's two new songs will be in "pending" blob state on B and C since the
      // audio data travels via p2p blob transfer, not the doc itself.
      // verify the song rows are present (entries synced) even if blobs aren't cached yet.
      // songs with a non-empty data-download-state have arrived in the doc and are queued for fetch.
      const bNewSongCount = await pageB.evaluate(() =>
        document.querySelectorAll('[data-testid="song-duration"][data-download-state]').length
      );
      expect(bNewSongCount).toBe(2);
      logTs("[e2e] peerB: A's 2 new songs have download state (blob transfer queued)");
    } finally {
      await Promise.allSettled([ctxA.close(), ctxB.close(), ctxC.close()]);
    }
  }
);

// -----------------------------------------------------------------------
// blob transfer: audio + image
// -----------------------------------------------------------------------
// peer A creates a playlist with songs (each has an embedded image), shares it.
// peer B opens the share link, syncs the doc, then uses "save offline" to pull
// all blobs via the freqhole-playlistz/1 blob_request / blob_ready exchange.
// verifies that:
//   - song audio blobs arrive (song rows exit pending/downloading state)
//   - image blobs arrive (cover image becomes visible on B)
//   - all transfers complete without errors (no "error" download state on any row)
//   - playing a song on B works after blobs are local (no second-attempt needed)

test("peer B fetches audio and image blobs from peer A @p2p", async ({ browser }) => {
  test.setTimeout(600_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const fwd = (tag: string) => (msg: import("@playwright/test").ConsoleMessage) => {
    logTs(`[${tag}] ${msg.text()}`);
  };
  pageA.on("console", fwd("peerA"));
  pageB.on("console", fwd("peerB"));
  pageA.on("pageerror", (e) => logTs(`[peerA error] ${e}`));
  pageB.on("pageerror", (e) => logTs(`[peerB error] ${e}`));

  try {
    // --- peer A: create playlist with songs + cover images ---
    await resetAppState(pageA);
    await createPlaylistViaUI(pageA);
    await pageA.getByTestId("input-playlist-title").fill("blob-transfer-test");
    await pageA.getByTestId("input-playlist-title").blur();
    await pageA.waitForTimeout(300);

    // 3 songs so we exercise parallel prefetch
    await addSongs(pageA, 3);
    await expect(pageA.getByTestId("song-row")).toHaveCount(3, { timeout: 10_000 });

    // add a cover image to the first song via the song edit panel
    const pngBytes = await makePng(pageA, { color: "#ff00ff", label: "cover" });
    const firstRow = pageA.getByTestId("song-row").first();
    await firstRow.hover();
    await pageA.getByTestId("btn-edit-song").first().click();
    await pageA.getByTestId("song-edit-panel").waitFor({ timeout: 5000 });
    // drop the image onto the song edit panel drop zone
    await pageA.evaluate(
      async ({ b64 }: { b64: string }) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], "cover.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const panel = document.querySelector('[data-testid="song-edit-panel"]') ?? document.body;
        panel.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      },
      { b64: Buffer.from(pngBytes).toString("base64") }
    );
    await pageA.waitForTimeout(500);
    await pageA.keyboard.press("Escape");

    // --- peer A: enable p2p and set public mode ---
    logTs("[e2e] peerA: enabling p2p...");
    await pageA.getByTestId("btn-share-playlist").click();
    await pageA.getByTestId("btn-enable-sharing").click();
    await expect(pageA.getByTestId("btn-copy-share-link")).toBeEnabled({ timeout: 180_000 });

    await pageA.getByText("anyone (public)").click();
    await pageA.waitForTimeout(300);

    const shareUrl = await pageA.locator("input[readonly]").first().inputValue();
    expect(shareUrl).toContain("#share/");
    logTs(`[e2e] peerA: share url built: ${shareUrl.slice(0, 60)}...`);
    await pageA.getByTestId("btn-share-playlist").click();

    // --- peer B: boot p2p and open share link ---
    await resetAppState(pageB);
    await createPlaylistViaUI(pageB);
    await pageB.getByTestId("btn-share-playlist").click();
    logTs("[e2e] peerB: enabling p2p...");
    await pageB.getByTestId("btn-enable-sharing").click();
    await expect(pageB.getByTestId("sharing-status")).toBeVisible({ timeout: 180_000 });
    await pageB.getByTestId("btn-share-playlist").click();
    logTs("[e2e] peerB: p2p online");

    await pageB.getByTestId("btn-all-playlists").click();
    // give the iroh relay time to propagate this node's addresses before connecting;
    // open_bi has a ~2-minute internal timeout when the peer is not yet discoverable
    await pageB.waitForTimeout(20_000);
    await pageB.getByTestId("input-search-playlists").fill(shareUrl);
    logTs("[e2e] peerB: opening share link...");
    await expect(pageB.getByTestId("all-playlists-panel")).not.toBeVisible({ timeout: 120_000 });

    // confirm doc metadata arrived
    await expect(pageB.getByTestId("input-playlist-title")).toHaveValue(
      "blob-transfer-test",
      { timeout: 30_000 }
    );
    await expect(pageB.getByTestId("song-row")).toHaveCount(3, { timeout: 30_000 });
    logTs("[e2e] peerB: doc synced - 3 song rows visible");

    // --- peer B: trigger "save offline" to pull all blobs ---
    // open share panel to reach the p2p save button
    await pageB.getByTestId("btn-share-playlist").click();
    await pageB.getByTestId("share-panel").waitFor({ timeout: 5000 });
    await pageB.getByTestId("btn-share-playlist").click();

    // the p2p save button is visible only if blobs are missing
    const saveBtn = pageB.getByTestId("btn-p2p-save-offline");
    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      logTs("[e2e] peerB: triggering save offline...");
      await saveBtn.click();
      // wait for the button to disappear (all blobs cached = button hidden)
      await expect(saveBtn).not.toBeVisible({ timeout: 180_000 });
      logTs("[e2e] peerB: save offline complete");
    } else {
      logTs("[e2e] peerB: blobs already local (skip save offline)");
    }

    // no song rows should be in error state
    const errorRows = pageB.locator("[data-testid='song-duration'][data-download-state='error']");
    await expect(errorRows).toHaveCount(0, { timeout: 5000 });
    logTs("[e2e] peerB: no song rows in error state");

    // all 3 songs should have no pending/downloading state (blobs cached)
    await expect(
      pageB.locator("[data-testid='song-duration'][data-download-state]")
    ).toHaveCount(0, { timeout: 10_000 });
    logTs("[e2e] peerB: all song blobs cached locally");

    // --- play first song on B - should work on first attempt ---
    await pageB.getByText("song-00").dblclick();
    // audio player should show the song title within a few seconds
    // (if the blob fetch needed a second attempt the title flickers, which
    // is what we're guarding against)
    await expect(pageB.getByTestId("audio-player")).toBeVisible({ timeout: 5000 });
    logTs("[e2e] peerB: first song playing");

    // --- cover image on B ---
    // the first song row should have an image thumbnail visible
    const firstSongRow = pageB.getByTestId("song-row").first();
    const thumb = firstSongRow.locator("img");
    await expect(thumb).toBeVisible({ timeout: 10_000 });
    logTs("[e2e] peerB: song cover image visible");
  } finally {
    await Promise.allSettled([ctxA.close(), ctxB.close()]);
  }
});

