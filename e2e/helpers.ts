// shared e2e helpers: synthetic media fixtures + app interaction utilities.
//
// audio fixtures are real PCM WAV files (valid RIFF headers) so the browser
// can decode duration and actually play them. images are real PNGs generated
// via canvas in the page. if you want to test with real music, drop files
// into e2e/fixtures/ (gitignored) - loadRealFixtures() picks them up.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// --- synthetic audio ---

// build a valid mono 16-bit PCM WAV file with a sine tone.
// durationSec controls both file size and the decoded duration shown in the UI.
export function makeWav(durationSec = 1, freqHz = 440): Uint8Array {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    view.setInt16(44 + i * 2, Math.floor(sample * 0x4fff), true);
  }
  return new Uint8Array(buf);
}

// --- synthetic images ---

// generate a real PNG in the page via canvas (solid color + label text).
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

// --- real fixtures (optional, gitignored) ---

export interface FixtureFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

const AUDIO_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

// load real audio files from e2e/fixtures/ if any exist.
// returns [] when the dir is missing or empty.
export function loadRealAudioFixtures(): FixtureFile[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => Object.keys(AUDIO_EXT).some((ext) => f.toLowerCase().endsWith(ext)))
    .map((f) => {
      const ext = Object.keys(AUDIO_EXT).find((e) => f.toLowerCase().endsWith(e))!;
      return {
        name: f,
        mimeType: AUDIO_EXT[ext]!,
        bytes: new Uint8Array(readFileSync(join(FIXTURES_DIR, f))),
      };
    });
}

// --- app interaction helpers ---

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
    const target = document.querySelector("[class*='bg-black']") ?? document.body;
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
  await page.getByRole("heading", { name: "playlistz" }).waitFor({ timeout: 10000 });
}

// create a playlist via the sidebar button and wait for it to appear
export async function createPlaylistViaUI(page: Page): Promise<void> {
  await page.getByRole("button", { name: "new playlist" }).first().click();
  await page.getByTitle("edit playlist").waitFor({ timeout: 5000 });
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
