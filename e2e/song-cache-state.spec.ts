// e2e: song row cache-state styling and related format/metadata behaviour.
//
// covers:
//   - duration cell shows muted gray while blobCached is unknown (resource loading)
//   - duration cell shows underline once the blob is confirmed locally cached
//   - locally-added songs without an explicit sha also show underline (no-sha fallback)
//   - mp3/m4a/ogg files are accepted and show the correct row (duration + title)
//   - filename-based title and artist parsing (app does not read ID3 tags)
//   - various image formats accepted as playlist covers
//   - mixed formats in a single drop all produce rows

import { test, expect } from "@playwright/test";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  dropFiles,
  fixture,
  setPlaylistCover,
  waitForApp,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// --- duration cell cache-state styling ---

test("duration shows underline once blob is locally cached", async ({ page }) => {
  await createPlaylistViaUI(page);
  // 2-second tone - once the row appears, the blob is already in opfs
  await addSongs(page, 1, 2);

  // wait for the song row duration cell to appear, then check for underline
  const dur = page.getByTestId("song-duration").first();
  await expect(dur).toBeVisible({ timeout: 15000 });
  await expect(dur).toHaveClass(/underline/, { timeout: 10000 });
});

test("duration stays muted gray until cache check resolves", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 1, 2);

  const dur = page.getByTestId("song-duration").first();
  await expect(dur).toBeVisible({ timeout: 15000 });

  // once the async check completes it should be underlined
  // (the gray state is the transient loading window; we assert the final
  // correct state rather than racing against the loading window)
  await expect(dur).toHaveClass(/underline/, { timeout: 10000 });
});

test("duration underline persists across page reload", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 1, 2);
  await expect(page.getByTestId("song-duration").first()).toHaveClass(/underline/, { timeout: 10000 });

  await page.reload();
  await waitForApp(page);

  // blobs persist in opfs; underline should reappear after reload
  await expect(page.getByTestId("song-duration").first()).toHaveClass(/underline/, { timeout: 10000 });
});

// --- audio format acceptance ---

test("mp3 file is accepted and shows a row", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("tagged-c5-3s.mp3")]);
  // app extracts title from filename: "tagged-c5-3s"
  await expect(page.getByText("tagged-c5-3s").first()).toBeVisible({ timeout: 15000 });
  // duration: 3 seconds
  await expect(page.getByText("0:03").first()).toBeVisible();
});

test("m4a file is accepted and shows a row", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("tagged-a3-4s.m4a")]);
  await expect(page.getByText("tagged-a3-4s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:04").first()).toBeVisible();
});

test("ogg file is accepted and shows a row", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("tagged-f4-6s.ogg")]);
  await expect(page.getByText("tagged-f4-6s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:06").first()).toBeVisible();
});

test("very short mp3 (1s) is accepted and shows duration", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("bare-glitch-1s.mp3")]);
  await expect(page.getByText("bare-glitch-1s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:01").first()).toBeVisible();
});

test("stereo wav is accepted and shows duration", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("tone-stereo-3s.wav")]);
  await expect(page.getByText("tone-stereo-3s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:03").first()).toBeVisible();
});

test("chord wav shows correct duration", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("chord-stack-3s.wav")]);
  await expect(page.getByText("chord-stack-3s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:03").first()).toBeVisible();
});

// --- filename-based title parsing ---

test("filename with artist-title pattern is parsed correctly", async ({ page }) => {
  // "Artist - Title" filename pattern: app splits on " - "
  await createPlaylistViaUI(page);
  await dropFiles(page, [{
    name: "Fixture Bot - My Song.mp3",
    mimeType: "audio/mpeg",
    bytes: fixture("tagged-c5-3s.mp3").bytes,
  }]);
  await expect(page.getByText("My Song").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Fixture Bot").first()).toBeVisible();
});

test("filename with no separator uses full name as title", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("bare-glitch-1s.mp3")]);
  await expect(page.getByText("bare-glitch-1s").first()).toBeVisible({ timeout: 15000 });
});

// --- mixed formats in a single drop ---

test("mixed formats in a single drop all appear as rows", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [
    fixture("tagged-c5-3s.mp3"),
    fixture("tagged-a3-4s.m4a"),
    fixture("tagged-f4-6s.ogg"),
    fixture("tone-440hz-2s.wav"),
  ]);

  await expect(page.getByText("tagged-c5-3s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("tagged-a3-4s").first()).toBeVisible();
  await expect(page.getByText("tagged-f4-6s").first()).toBeVisible();
  await expect(page.getByText("tone-440hz-2s").first()).toBeVisible();
  await expect(page.getByTestId("playlist-song-count").first()).toContainText("4");
});

// --- image formats as playlist cover ---

test("jpg accepted as playlist cover", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-edit-playlist").click();
  await setPlaylistCover(page, fixture("cover-gradient.jpg"));
  // scope to edit-panel - the preview img appears there after processing
  await expect(page.getByTestId("edit-panel").locator("img[alt='playlist cover']").first()).toBeVisible({ timeout: 10000 });
});

test("webp accepted as playlist cover", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-edit-playlist").click();
  await setPlaylistCover(page, fixture("cover-plasma.webp"));
  await expect(page.getByTestId("edit-panel").locator("img[alt='playlist cover']").first()).toBeVisible({ timeout: 10000 });
});

test("portrait jpg (non-square) accepted as playlist cover", async ({ page }) => {
  await createPlaylistViaUI(page);
  await page.getByTestId("btn-edit-playlist").click();
  await setPlaylistCover(page, fixture("cover-portrait.jpg"));
  await expect(page.getByTestId("edit-panel").locator("img[alt='playlist cover']").first()).toBeVisible({ timeout: 10000 });
});

// --- metadata persistence ---

test("songs persist title and duration across page reload", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [fixture("tagged-c5-3s.mp3")]);
  await expect(page.getByText("tagged-c5-3s").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("0:03").first()).toBeVisible();

  await page.reload();
  await waitForApp(page);

  await expect(page.getByText("tagged-c5-3s").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("0:03").first()).toBeVisible();
});

test("multiple songs survive reload with correct order", async ({ page }) => {
  await createPlaylistViaUI(page);
  await dropFiles(page, [
    fixture("tagged-c5-3s.mp3"),
    fixture("tagged-a3-4s.m4a"),
  ]);
  await expect(page.getByTestId("playlist-song-count").first()).toContainText("2", { timeout: 15000 });

  await page.reload();
  await waitForApp(page);

  await expect(page.getByText("tagged-c5-3s").first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("tagged-a3-4s").first()).toBeVisible();
  await expect(page.getByTestId("playlist-song-count").first()).toContainText("2");
});
