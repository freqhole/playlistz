// e2e: audio player behaviour - autoplay next, errors, blob fetch states.
//
// most tests use the dev hook helpers (seekTo, triggerTrackEnd, etc.) from
// e2e/helpers.ts to drive playback events without waiting for real audio.
//
// one "real playthrough" test lets a 2s fixture actually finish to prove
// autoplay-next works end-to-end.
//
// blob-fetch state tests use mockBlobFetch + evictBlob to simulate p2p
// transfers without a real peer connection.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
  seekTo,
  triggerTrackEnd,
  triggerAudioError,
  mockBlobFetch,
  clearMockBlobFetch,
  evictBlob,
  currentSong,
} from "./helpers.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test.beforeEach(async ({ page }) => {
  await resetAppState(page);
});

// --- autoplay / queue advance ---

test("autoplay next: seekTo near end advances to next song", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3, 2);

  await page.getByText("song-00").dblclick();
  await expect(page.getByTestId("btn-play-playlist")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 10000 }
  );
  await expect
    .poll(() => currentSong(page), { timeout: 8000 })
    .toBe("song-00");

  await seekTo(page, 1.9); // 2s song, seek to 0.1s before end

  await expect
    .poll(() => currentSong(page), { timeout: 8000 })
    .toBe("song-01");
});

test("autoplay next: triggerTrackEnd advances queue", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 3, 2);

  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  await triggerTrackEnd(page);

  await expect
    .poll(() => currentSong(page), { timeout: 8000 })
    .toBe("song-01");
});

test("end of playlist: last song ends, player stops", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 2, 2);

  await page.getByText("song-01").dblclick();
  await expect(page.getByTestId("btn-play-playlist")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 10000 }
  );

  await triggerTrackEnd(page);

  // playback stops - button aria-pressed returns to "false"
  await expect(page.getByTestId("btn-play-playlist")).toHaveAttribute(
    "aria-pressed",
    "false",
    { timeout: 8000 }
  );
});

// --- audio player error states ---

test("real playthrough: 2s fixture autoadvances without hooks", async ({
  page,
}) => {
  test.slow();
  await createPlaylistViaUI(page);
  await addSongs(page, 2, 2);

  await page.getByText("song-00").dblclick();
  await expect
    .poll(() => currentSong(page), { timeout: 10000 })
    .toBe("song-00");

  // let it play through naturally
  await expect
    .poll(() => currentSong(page), { timeout: 12000 })
    .toBe("song-01");
});

// --- audio player error states ---

test("triggerAudioError: player recovers without crash", async ({ page }) => {
  await createPlaylistViaUI(page);
  await addSongs(page, 2, 2);

  await page.getByText("song-00").dblclick();
  await expect(page.getByTestId("btn-play-playlist")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 10000 }
  );

  await triggerAudioError(page, 4);

  // app must stay responsive
  await expect(page.getByTestId("btn-play-playlist")).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByTestId("song-duration").first()).toBeVisible();
});

// --- blob fetch states (mocked p2p transport) ---

// import a committed fixture file via the __processFiles dev hook
async function importFixture(
  page: Parameters<typeof evictBlob>[0],
  filename: string
): Promise<void> {
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const result = await page.evaluate(
    async ({ b64, name }: { b64: string; name: string }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], name, { type: "audio/wav" });
      const hook = (
        window as Window & { __processFiles?: (files: File[]) => Promise<void> }
      ).__processFiles;
      if (!hook) return "hook-missing";
      await hook([file]);
      return "ok";
    },
    { b64: Buffer.from(bytes).toString("base64"), name: filename }
  );
  if (result !== "ok") throw new Error(`importFixture failed: ${result}`);
}

test("mockBlobFetch delayed: song row shows downloading state @mock", async ({
  page,
}) => {
  await createPlaylistViaUI(page);
  await importFixture(page, "tone-440hz-2s.wav");
  await expect(page.getByText("tone-440hz-2s")).toBeVisible({ timeout: 10000 });

  const durationCell = page.getByTestId("song-duration").first();
  await durationCell.waitFor({ timeout: 8000 });
  const sha256 = await durationCell.getAttribute("data-sha256");

  if (sha256) {
    await evictBlob(page, sha256);
    await mockBlobFetch(page, { type: "delayed", ms: 2000 });
  }

  await page.getByText("tone-440hz-2s").dblclick();

  if (sha256) {
    await expect(durationCell).toHaveAttribute(
      "data-download-state",
      "downloading",
      { timeout: 5000 }
    );
    await expect(page.getByTestId("btn-play-playlist")).toHaveAttribute(
      "aria-busy",
      "true",
      { timeout: 5000 }
    );
    // after 2s delay resolves, downloading state clears
    await expect(durationCell).not.toHaveAttribute(
      "data-download-state",
      "downloading",
      { timeout: 8000 }
    );
    await clearMockBlobFetch(page);
  }
});

test("mockBlobFetch error: song row shows error state @mock", async ({ page }) => {
  await createPlaylistViaUI(page);
  await importFixture(page, "tone-440hz-2s.wav");
  await expect(page.getByText("tone-440hz-2s")).toBeVisible({ timeout: 10000 });

  const durationCell = page.getByTestId("song-duration").first();
  await durationCell.waitFor();
  const sha256 = await durationCell.getAttribute("data-sha256");

  if (sha256) {
    await evictBlob(page, sha256);
    await mockBlobFetch(page, { type: "error", code: "not_found" });
  }

  await page.getByText("tone-440hz-2s").dblclick();

  if (sha256) {
    await expect(durationCell).toHaveAttribute("data-download-state", "error", {
      timeout: 8000,
    });
    await clearMockBlobFetch(page);
  }
});
