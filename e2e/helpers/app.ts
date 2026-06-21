// app interaction helpers: navigate, reset state, create playlists, add songs.
//
// these helpers drive the real app UI through Playwright. no mock transport
// hooks here - see hooks.ts for window.__* wrappers.

import { expect, type Page } from "@playwright/test";
import { makeWav, type FixtureFile } from "./media.js";

// log with a wall-clock timestamp so slow steps and stalls are visible
// in test output (e.g. "[12:34:56] peer a: p2p node online")
export function logTs(message: string): void {
  const now = new Date().toTimeString().slice(0, 8);
  console.log(`[${now}] ${message}`);
}

// generate a real PNG in the page via canvas (solid color + optional label text).
// returns the bytes so they can be dropped or set on file inputs.
export async function makePng(
  page: Page,
  opts: { width?: number; height?: number; color?: string; label?: string } = {}
): Promise<Uint8Array> {
  const { width = 64, height = 64, color = "#ff00ff", label = "" } = opts;
  const base64 = await page.evaluate(
    async ({ width, height, color, label }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      if (label) {
        ctx.fillStyle = "#000";
        ctx.font = "12px monospace";
        ctx.fillText(label, 4, height / 2);
      }
      const blob: Blob = await new Promise((res) =>
        canvas.toBlob((b) => res(b!), "image/png")
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    },
    { width, height, color, label }
  );
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

// drop files onto the app (simulates drag and drop of audio files / zips).
export async function dropFiles(page: Page, files: FixtureFile[]): Promise<void> {
  const payload = files.map((f) => ({
    name: f.name,
    mimeType: f.mimeType,
    base64: Buffer.from(f.bytes).toString("base64"),
  }));
  await page.evaluate(async (payload) => {
    const dt = new DataTransfer();
    for (const f of payload) {
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
    }
    const target = document.querySelector('[data-testid="app-root"]') ?? document.body;
    target.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })
    );
  }, payload);
}

// wipe all app storage (indexeddb + localstorage) and reload for a clean slate.
export async function resetAppState(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (db) =>
          new Promise<void>((res) => {
            if (!db.name) return res();
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = req.onerror = req.onblocked = () => res();
          })
      )
    );
  });
  await page.reload();
  await waitForApp(page);
}

// wait for the app shell to finish booting
export async function waitForApp(page: Page): Promise<void> {
  await page.getByTestId("app-ready").waitFor({ timeout: 10000 });
}

// create a playlist via the UI and wait for the playlist header to appear.
// on a fresh app (no playlists): clicks the "new playlist" button in the empty state.
// if a playlist is already selected: opens the all-playlists panel via the
// hamburger and clicks "new playlist" there.
export async function createPlaylistViaUI(page: Page): Promise<void> {
  // try the always-visible empty-state button first, fall back to hamburger flow
  const newBtn = page.getByTestId("btn-new-playlist");
  const isVisible = await newBtn.isVisible().catch(() => false);
  if (isVisible) {
    await newBtn.click();
  } else {
    // open all-playlists panel via hamburger
    await page.getByTestId("btn-all-playlists").click();
    await page.getByTestId("btn-new-playlist").click();
  }
  await page.getByTestId("btn-edit-playlist").waitFor({ timeout: 5000 });
  // wait for the title input to reflect the new playlist's default title,
  // confirming the reactive binding is live before callers try to fill it
  await expect(page.getByTestId("input-playlist-title")).toHaveValue(
    "new playlist"
  );
}

// add n synthetic songs to the selected playlist via drag and drop
export async function addSongs(page: Page, count: number, durationSec = 1): Promise<void> {
  const files: FixtureFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      name: `song-${String(i).padStart(2, "0")}.wav`,
      mimeType: "audio/wav",
      bytes: makeWav(durationSec, 220 + i * 110),
    });
  }
  await dropFiles(page, files);
  // wait for the last row to show up
  await page
    .getByText(`song-${String(count - 1).padStart(2, "0")}`)
    .waitFor({ timeout: 15000 });
}

// set a cover image on the playlist edit panel via the file input
export async function setPlaylistCover(page: Page, f: FixtureFile): Promise<void> {
  // use accept="image/*" to distinguish from the + add-songs audio input
  const input = page.locator("input[type='file'][accept='image/*']").first();
  await input.waitFor({ state: "attached", timeout: 5000 });
  await input.setInputFiles({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) });
}
