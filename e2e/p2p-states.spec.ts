// e2e: p2p blob transfer state machine - mocked transport scenarios.
//
// all tests use __mockBlobFetch + __evictBlob to simulate p2p behaviour
// deterministically in a single browser without a real peer connection.
//
// companion to audio-player.spec.ts which covers the basic happy path.
// this file focuses on: pending state, timeout, retry, prefetch triggering,
// and prefetch cancellation on playlist switch.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  seekTo,
  mockBlobFetch,
  clearMockBlobFetch,
  evictBlob,
  setBlobFetchTimeout,
  fetchBlobBySha,
  currentSong,
} from "./helpers.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// import a committed fixture via the __processFiles dev hook
async function importFixture(
  page: Parameters<typeof evictBlob>[0],
  filename: string,
  mimeType = "audio/wav"
): Promise<void> {
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const result = await page.evaluate(
    async ({ b64, name, mime }: { b64: string; name: string; mime: string }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], name, { type: mime });
      const hook = (
        window as Window & { __processFiles?: (files: File[]) => Promise<void> }
      ).__processFiles;
      if (!hook) return "hook-missing";
      await hook([file]);
      return "ok";
    },
    { b64: Buffer.from(bytes).toString("base64"), name: filename, mime: mimeType }
  );
  if (result !== "ok") throw new Error(`importFixture failed: ${result}`);
}

// get the sha256 of the first song row's blob
async function firstSongSha(
  page: Parameters<typeof evictBlob>[0]
): Promise<string | null> {
  const cell = page.getByTestId("song-duration").first();
  await cell.waitFor({ timeout: 8000 });
  return cell.getAttribute("data-sha256");
}

// --- pending state ---

test("prefetch marks songs pending before fetch starts @mock", async ({ page }) => {
  test.setTimeout(30_000);
  await createPlaylistViaUI(page);
  // 3 songs: song-00 plays, song-01 and song-02 should enter pending state
  await addSongs(page, 3, 2);

  // stall fetches so we can observe pending state before resolve
  await mockBlobFetch(page, { type: "stall" });

  // evict all blobs so prefetch has something to fetch
  const cells = page.getByTestId("song-duration");
  const count = await cells.count();
  for (let i = 0; i < count; i++) {
    const sha = await cells.nth(i).getAttribute("data-sha256");
    if (sha) await evictBlob(page, sha);
  }

  // start playback on song-00 - this triggers prefetchUpcoming for songs 1+2
  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  // at least one upcoming song should show pending or downloading state while fetches are stalled
  await expect(
    page.locator("[data-testid='song-duration'][data-download-state]").first()
  ).toBeVisible({ timeout: 5000 });

  // clean up
  await clearMockBlobFetch(page);
});

// --- fetch timeout ---

test("blob fetch timeout: song shows error state after timeout @mock", async ({
  page,
}) => {
  test.setTimeout(20_000);
  await createPlaylistViaUI(page);
  await importFixture(page, "tone-440hz-2s.wav");
  await expect(page.getByText("tone-440hz-2s")).toBeVisible({ timeout: 10000 });

  const durationCell = page.getByTestId("song-duration").first();
  const sha256 = await firstSongSha(page);

  if (sha256) {
    await evictBlob(page, sha256);
    // set a very short timeout so the test doesn't wait 30s
    await setBlobFetchTimeout(page, 500);
    await mockBlobFetch(page, { type: "stall" });
  }

  await page.getByText("tone-440hz-2s").dblclick();

  if (sha256) {
    // after ~500ms timeout, state should flip to error
    await expect(durationCell).toHaveAttribute("data-download-state", "error", {
      timeout: 5000,
    });
    await clearMockBlobFetch(page);
    // reset timeout to default
    await setBlobFetchTimeout(page, 30_000);
  }
});

// --- retry on error ---

test("error duration cell has retry affordance and retry clears error state @mock", async ({ page }) => {
  test.setTimeout(20_000);
  await createPlaylistViaUI(page);
  await importFixture(page, "tone-440hz-2s.wav");
  await expect(page.getByText("tone-440hz-2s")).toBeVisible({ timeout: 10000 });

  const durationCell = page.getByTestId("song-duration").first();
  const sha256 = await firstSongSha(page);

  if (sha256) {
    await evictBlob(page, sha256);
    // make the fetch error immediately
    await mockBlobFetch(page, { type: "error", code: "not_found" });
  }

  await page.getByText("tone-440hz-2s").dblclick();

  if (sha256) {
    await expect(durationCell).toHaveAttribute("data-download-state", "error", {
      timeout: 8000,
    });

    // error state should expose a retry affordance (cursor-pointer class)
    await expect(durationCell).toHaveClass(/cursor-pointer/);

    // switch mock to instant and trigger retry programmatically.
    // clicking the cell via Playwright is unreliable here because the
    // song-row action-buttons overlay sits on top of the duration cell.
    await mockBlobFetch(page, { type: "instant" });
    await fetchBlobBySha(page, sha256);

    // error state should clear after successful retry
    await expect(durationCell).not.toHaveAttribute(
      "data-download-state",
      "error",
      { timeout: 5000 }
    );
    await clearMockBlobFetch(page);
  }
});

// --- prefetch triggered on play ---

test("prefetch activates for upcoming songs when playback starts @mock", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await createPlaylistViaUI(page);
  await addSongs(page, 3, 2);

  // evict all blobs so there's something to prefetch
  const cells = page.getByTestId("song-duration");
  const count = await cells.count();
  for (let i = 0; i < count; i++) {
    const sha = await cells.nth(i).getAttribute("data-sha256");
    if (sha) await evictBlob(page, sha);
  }

  // instant mock - prefetch should complete quickly
  await mockBlobFetch(page, { type: "instant" });

  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  // after a short wait, the upcoming songs' download states should clear
  // (instant mock means they resolve immediately - no "downloading" lingers)
  await page.waitForTimeout(1000);
  const anyDownloading = await page.evaluate(() => {
    const cells = document.querySelectorAll("[data-download-state]");
    return Array.from(cells).some(
      (el) => el.getAttribute("data-download-state") === "downloading"
    );
  });
  expect(anyDownloading).toBe(false);

  await clearMockBlobFetch(page);
});

// --- prefetch cancels on playlist switch ---

test("prefetch for old playlist cancels when switching to new playlist @mock", async ({
  page,
}) => {
  test.setTimeout(40_000);

  // create playlist A with 3 songs
  await createPlaylistViaUI(page);
  await addSongs(page, 3, 2);

  // evict all blobs from playlist A
  const cells = page.getByTestId("song-duration");
  const count = await cells.count();
  for (let i = 0; i < count; i++) {
    const sha = await cells.nth(i).getAttribute("data-sha256");
    if (sha) await evictBlob(page, sha);
  }

  // stall fetches - playlist A prefetch will hang
  await mockBlobFetch(page, { type: "stall" });

  // start playback on playlist A song-00 (triggers prefetch for song-01, song-02)
  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  // create playlist B and switch to it - this should cancel playlist A's prefetch
  await createPlaylistViaUI(page);
  await addSongs(page, 1, 2);

  // switch mock to instant so playlist B can prefetch cleanly
  await mockBlobFetch(page, { type: "instant" });

  // after switching, playlist A's stalled prefetches should be abandoned.
  // the pending/downloading states on those shas should not appear on playlist B's songs.
  await page.waitForTimeout(800);

  // playlist B's song row should be visible (strict-safe: use testid, not song name text)
  await expect(page.getByTestId("song-duration").first()).toBeVisible();
  // pending states should be cleared after switching playlists.
  // (in-flight "downloading" states may persist until the stall mock times out -
  // that is expected. what matters is queued-but-not-started "pending" states are gone.)
  const pendingCount = await page.evaluate(() =>
    document.querySelectorAll("[data-download-state='pending']").length
  );
  expect(pendingCount).toBe(0);

  await clearMockBlobFetch(page);
});

// --- seek recalculates prefetch window ---

test("seeking forward recalculates the prefetch window @mock", async ({ page }) => {
  test.setTimeout(30_000);
  await createPlaylistViaUI(page);
  await addSongs(page, 4, 2); // 4x 2s songs

  // evict songs 2-4 blobs so there's something to prefetch
  const cells = page.getByTestId("song-duration");
  const count = await cells.count();
  for (let i = 1; i < count; i++) {
    const sha = await cells.nth(i).getAttribute("data-sha256");
    if (sha) await evictBlob(page, sha);
  }

  // use instant mock so prefetch resolves immediately
  await mockBlobFetch(page, { type: "instant" });

  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  // seek near the end of song-00 - should re-trigger prefetchUpcoming
  await seekTo(page, 1.8);

  // brief wait then assert no downloading states are stuck
  await page.waitForTimeout(800);
  const downloading = await page.evaluate(() =>
    document.querySelectorAll("[data-download-state='downloading']").length
  );
  expect(downloading).toBe(0);

  await clearMockBlobFetch(page);
});
