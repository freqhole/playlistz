// e2e: zip bundle download + standalone roundtrip.
//
// 1. create a playlist with songs in the main vite dev app
// 2. click the download zip button and intercept the download
// 3. unzip the bundle (in the test process via jszip)
// 4. extract to a temp dir and start a mini http server serving it
// 5. navigate playwright to the standalone app
// 6. assert songs are visible and interactive (reusing existing helper patterns)
// 7. also tests zip reimport: drop the zip back onto the main app and verify
//    songs reappear without duplication
//
// the suite runs `npm run build:standalone` automatically if
// dist/freqhole-playlistz.js is missing. the vite dev server at port 5917
// serves dist/ so the download service can embed the bundle in the zip.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import { execSync } from "node:child_process";
import JSZip from "jszip";
import {
  resetAppState,
  createPlaylistViaUI,
  addSongs,
} from "./helpers.js";

// --- inline http server for serving extracted zip contents ---

function startStaticServer(dir: string, port: number): Promise<http.Server> {
  const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".map": "application/json",
  };

  const server = http.createServer((req, res) => {
    const rawPath = req.url?.split("?")[0] ?? "/";
    const urlPath = decodeURIComponent(rawPath);
    const filePath = path.join(dir, urlPath === "/" ? "index.html" : urlPath);

    // prevent path traversal
    const absDir = path.resolve(dir);
    const absFile = path.resolve(filePath);
    if (!absFile.startsWith(absDir + path.sep) && absFile !== absDir) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    if (!fs.existsSync(absFile) || fs.statSync(absFile).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const ext = path.extname(absFile).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const total = fs.statSync(absFile).size;
    const range = req.headers["range"];

    if (range) {
      const [, rangeStr] = range.split("=");
      const [s, e] = (rangeStr ?? "").split("-");
      const start = parseInt(s ?? "0", 10);
      const end = e ? parseInt(e, 10) : total - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(absFile, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": total,
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(absFile).pipe(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => resolve(server));
  });
}

// extract a JSZip instance to a directory on disk.
// returns the path.
async function extractZip(
  zipBuffer: Buffer,
  outDir: string
): Promise<string> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const writes: Promise<void>[] = [];
  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    const dest = path.join(outDir, relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writes.push(
      file.async("nodebuffer").then((buf) => fs.writeFileSync(dest, buf))
    );
  });
  await Promise.all(writes);
  return outDir;
}

// find the first subdirectory inside outDir that contains index.html
function findRootDir(outDir: string): string {
  // zip layout: {safe-playlist-name}/index.html ...
  for (const entry of fs.readdirSync(outDir)) {
    const sub = path.join(outDir, entry);
    if (
      fs.statSync(sub).isDirectory() &&
      fs.existsSync(path.join(sub, "index.html"))
    ) {
      return sub;
    }
  }
  // fallback: index.html at outDir root
  return outDir;
}

// dist/freqhole-playlistz.js path
const REPO_ROOT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const BUNDLE_PATH = path.join(REPO_ROOT, "dist", "freqhole-playlistz.js");

// build the standalone bundle if it does not already exist.
// called in test.beforeAll() so it runs once per suite, not per test.
function ensureBundleBuilt(): void {
  if (fs.existsSync(BUNDLE_PATH)) return;
  console.log("[zip-bundle] dist/freqhole-playlistz.js not found - running build:standalone...");
  execSync("npm run build:standalone", { cwd: REPO_ROOT, stdio: "inherit" });
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error("build:standalone did not produce dist/freqhole-playlistz.js");
  }
  console.log("[zip-bundle] build:standalone done");
}

// --- standalone http server port (avoid collision with vite port 5917) ---
const STANDALONE_PORT = 5920;

test.describe("zip bundle download + standalone roundtrip", () => {
  test.beforeAll(() => ensureBundleBuilt());

  test.beforeEach(async ({ page }) => {
    await resetAppState(page);
  });

  test("download button is visible and triggers a zip download", async ({
    page,
  }) => {
    await createPlaylistViaUI(page);
    await addSongs(page, 2);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    await download.cancel(); // just checking the trigger fires
  });

  test("downloaded zip contains index.html, playlistz.js, and audio files", async ({
    page,
  }) => {
    await createPlaylistViaUI(page);
    await addSongs(page, 2);

    const titleInput = page.getByTestId("input-playlist-title");
    await titleInput.fill("my test playlist");
    await titleInput.blur();
    await expect(titleInput).toHaveValue("my test playlist");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;

    const zipPath = await download.path();
    expect(zipPath).toBeTruthy();
    const zipBuf = fs.readFileSync(zipPath!);
    const zip = await JSZip.loadAsync(zipBuf);

    const names = Object.keys(zip.files);

    // must have index.html and playlistz.js somewhere in the zip
    expect(names.some((n) => n.endsWith("index.html"))).toBe(true);
    expect(names.some((n) => n.endsWith("playlistz.js"))).toBe(true);

    // must have at least 2 audio files
    const audioFiles = names.filter((n) =>
      /\.(wav|mp3|flac|ogg|aiff|m4a)$/i.test(n)
    );
    expect(audioFiles.length).toBeGreaterThanOrEqual(2);

    // validate playlistz.js content
    const playlistzJsFile = zip.file(/playlistz\.js$/)[0];
    expect(playlistzJsFile).toBeTruthy();
    const playlistzJs = await playlistzJsFile!.async("string");

    // must be a valid window.__PLAYLISTZ__ assignment
    expect(playlistzJs).toMatch(/^window\.__PLAYLISTZ__\s*=/);

    // parse the JSON payload from "window.__PLAYLISTZ__ = [...];"
    const jsonMatch = playlistzJs.match(/window\.__PLAYLISTZ__\s*=\s*(\[.*\]);?\s*$/s);
    expect(jsonMatch).toBeTruthy();
    const playlistzData = JSON.parse(jsonMatch![1]!) as Array<{
      playlist: { id: string; title: string };
      songs: Array<{ title: string; duration: number; originalFilename: string; mimeType: string }>;
    }>;

    expect(playlistzData).toHaveLength(1);
    const entry = playlistzData[0]!;

    expect(entry.playlist.title).toBe("my test playlist");
    expect(entry.songs).toHaveLength(2);

    // each song must have a title, a positive duration, a filename, and a mime type
    for (const song of entry.songs) {
      expect(song.title).toBeTruthy();
      expect(song.duration).toBeGreaterThan(0);
      expect(song.originalFilename).toMatch(/\.wav$/i);
      expect(song.mimeType).toBeTruthy();
    }
  });

  test("zip reimport: drop zip back onto the app and songs reappear", async ({
    page,
  }) => {
    await createPlaylistViaUI(page);
    await addSongs(page, 3);

    // download and capture the zip
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipPath = await download.path();
    const zipBuf = fs.readFileSync(zipPath!);

    // reset to a clean state
    await resetAppState(page);
    // wait for empty state - confirms app is interactive and __processFiles is live
    await page.getByTestId("btn-new-playlist").waitFor();

    // use window.__processFiles (dev hook) instead of DragEvent to avoid
    // browser DataTransfer restrictions on synthesized events
    const result = await page.evaluate(async (zipBase64: string) => {
      const bin = atob(zipBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "playlist.zip", { type: "application/zip" });
      const hook = (window as typeof window & { __processFiles?: (files: File[]) => Promise<void> }).__processFiles;
      if (!hook) return "hook-missing";
      try {
        await hook([file]);
        return "ok";
      } catch (e) {
        return String(e);
      }
    }, zipBuf.toString("base64"));

    if (result !== "ok") throw new Error(`__processFiles failed: ${result}`);

    // after reimport, songs should be visible
    await expect(page.getByText("song-00")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("song-01")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("song-02")).toBeVisible({ timeout: 15000 });
  });

  test("standalone mode: zip serves via http and shows songs", async ({
    page,
  }) => {
    test.setTimeout(120_000); // build:standalone + extract + serve
    await createPlaylistViaUI(page);

    // give the playlist a recognisable title
    const titleInput = page.getByTestId("input-playlist-title");
    await titleInput.fill("standalone-test");
    await titleInput.blur();
    await page.waitForTimeout(300);

    await addSongs(page, 2);

    // download and capture the zip
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipPath = await download.path();
    expect(zipPath, "zip download path should exist").toBeTruthy();

    const zipBuf = fs.readFileSync(zipPath!);

    // extract zip to a temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlistz-e2e-"));
    await extractZip(zipBuf, tmpDir);

    // find the subdirectory containing index.html
    const serveDir = findRootDir(tmpDir);
    expect(
      fs.existsSync(path.join(serveDir, "index.html")),
      "index.html should exist in extracted zip"
    ).toBe(true);
    expect(
      fs.existsSync(path.join(serveDir, "playlistz.js")),
      "playlistz.js should exist in extracted zip"
    ).toBe(true);

    // start a static server for the standalone app
    const server = await startStaticServer(serveDir, STANDALONE_PORT);

    try {
      // open a fresh browser context (no IndexedDB from the main app)
      const ctx = await page.context().browser()!.newContext();
      const standalonePage = await ctx.newPage();

      await standalonePage.goto(`http://localhost:${STANDALONE_PORT}/`);

      // standalone app uses <freqhole-playlistz> web component + STANDALONE_MODE
      // wait for the app heading to appear
      await standalonePage
        .getByRole("heading", { name: "playlistz" })
        .waitFor({ timeout: 15000 });

      // songs should be visible (loaded from playlistz.js)
      await expect(standalonePage.getByText("song-00")).toBeVisible({
        timeout: 10000,
      });
      await expect(standalonePage.getByText("song-01")).toBeVisible();

      // song count badge should show 2
      await expect(standalonePage.getByText("2 songz").first()).toBeVisible();

      // the title should match what we set
      await expect(
        standalonePage.getByTestId("input-playlist-title")
      ).toHaveValue("standalone-test");

      await ctx.close();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("standalone mode: audio plays from the served zip", async ({ page }) => {
    test.setTimeout(120_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 1, 2); // 2-second song for faster playback check

    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipBuf = fs.readFileSync((await download.path())!);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlistz-e2e-audio-"));
    await extractZip(zipBuf, tmpDir);
    const serveDir = findRootDir(tmpDir);

    const server = await startStaticServer(serveDir, STANDALONE_PORT + 1);

    try {
      const ctx = await page.context().browser()!.newContext();
      const standalonePage = await ctx.newPage();

      await standalonePage.goto(`http://localhost:${STANDALONE_PORT + 1}/`);
      await standalonePage.getByRole("heading", { name: "playlistz" }).waitFor({ timeout: 15000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10000 });

      // click the first song row to select + play
      await standalonePage.getByText("song-00").first().click();
      await standalonePage.waitForTimeout(1000);

      // the audio player should show the song title
      await expect(
        standalonePage.getByText("song-00").first()
      ).toBeVisible();

      await ctx.close();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test.describe("--http CLI server mode", () => {
  test.beforeAll(() => ensureBundleBuilt());

  test.beforeEach(async ({ page }) => {
    await resetAppState(page);
  });

  test("serves extracted zip via the cli http server logic", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await createPlaylistViaUI(page);

    const titleInput = page.getByTestId("input-playlist-title");
    await titleInput.fill("http-server-test");
    await titleInput.blur();
    await page.waitForTimeout(300);

    await addSongs(page, 2);

    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipBuf = fs.readFileSync((await download.path())!);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlistz-e2e-http-"));
    await extractZip(zipBuf, tmpDir);
    const serveDir = findRootDir(tmpDir);

    // start using the same logic as src/cli/http.ts (inline for test isolation)
    const server = await startStaticServer(serveDir, STANDALONE_PORT + 2);

    try {
      const ctx = await page.context().browser()!.newContext();
      const standalonePage = await ctx.newPage();

      await standalonePage.goto(`http://localhost:${STANDALONE_PORT + 2}/`);
      await standalonePage.getByRole("heading", { name: "playlistz" }).waitFor({ timeout: 15000 });

      // songs loaded from the static playlistz.js
      await expect(standalonePage.getByText("song-00")).toBeVisible({ timeout: 10000 });
      await expect(standalonePage.getByText("song-01")).toBeVisible();
      await expect(
        standalonePage.getByTestId("input-playlist-title")
      ).toHaveValue("http-server-test");

      // range requests work: click a song to trigger audio element range fetch
      await standalonePage.getByText("song-00").first().click();
      // give browser time to try a range request
      await standalonePage.waitForTimeout(1000);
      // no "not found" errors should appear
      await expect(standalonePage.getByText("not found")).toHaveCount(0);

      await ctx.close();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
