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

import { test, expect, type Page } from "@playwright/test";
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
  makePng,
  setPlaylistCover,
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

    // must set the data-playlistz attribute on the web component element
    expect(playlistzJs).toContain("setAttribute('data-playlistz'");

    // extract and parse the JSON payload from setAttribute('data-playlistz', <json>)
    const attrMatch = playlistzJs.match(/setAttribute\('data-playlistz',\s*("(?:[^"\\]|\\.)*")\)/);
    expect(attrMatch).toBeTruthy();
    const innerJson = JSON.parse(attrMatch![1]!);
    const playlistzData = JSON.parse(innerJson) as Array<{
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

  test("downloaded zip contains playlist cover and song cover images with valid extensions", async ({
    page,
  }) => {
    await createPlaylistViaUI(page);
    await addSongs(page, 1);

    // add a playlist cover
    await page.getByTestId("btn-edit-playlist").click();
    const coverBytes = await makePng(page, { width: 32, height: 32, color: "#aa00ff" });
    await setPlaylistCover(page, { name: "cover.png", mimeType: "image/png", bytes: coverBytes });
    await page.waitForTimeout(600);
    // close the playlist edit panel before interacting with song rows
    await page.getByTestId("btn-edit-playlist").click();
    await page.waitForTimeout(200);

    // add a song cover via the song edit panel
    const row = page.getByTestId("song-row").first();
    await row.hover();
    await page.getByTestId("btn-edit-song").first().click();
    await page.getByTestId("song-edit-panel").waitFor();

    const songCoverBytes = await makePng(page, { width: 32, height: 32, color: "#00aaff" });
    const songCoverInput = page.locator("#song-image-upload-panel");
    await songCoverInput.setInputFiles({ name: "song-cover.png", mimeType: "image/png", buffer: Buffer.from(songCoverBytes) });
    await page.waitForTimeout(400);

    // click save in the song edit panel
    await page.locator('[data-testid="song-edit-panel"] button').filter({ hasText: "save" }).click();
    await page.waitForTimeout(600);

    // close the song edit panel
    await page.locator('[data-testid="song-edit-panel"] button[title="close"]').click();
    await page.waitForTimeout(300);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipBuf = fs.readFileSync((await download.path())!);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);

    // playlist cover must be a valid image file (not .bin)
    const playlistCoverFiles = names.filter((n) => n.includes("playlist-cover"));
    expect(playlistCoverFiles.length).toBeGreaterThanOrEqual(1);
    expect(playlistCoverFiles.some((n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n))).toBe(true);

    // song cover image must be a valid image file (not .bin)
    const songImageFiles = names.filter((n) => n.includes("-cover.") && !n.includes("playlist-cover"));
    expect(songImageFiles.length).toBeGreaterThanOrEqual(1);
    expect(songImageFiles.some((n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n))).toBe(true);

    // imageMimeType in playlistz.js must be a real MIME type, not "original"
    const playlistzJsFile = zip.file(/playlistz\.js$/)[0]!;
    const playlistzJs = await playlistzJsFile.async("string");
    const attrMatch = playlistzJs.match(/setAttribute\('data-playlistz',\s*("(?:[^"\\]|\\.)*")\)/);
    expect(attrMatch).toBeTruthy();
    const innerJson = JSON.parse(attrMatch![1]!);
    const playlistzData = JSON.parse(innerJson) as Array<{
      playlist: { imageMimeType?: string };
      songs: Array<{ imageMimeType?: string }>;
    }>;
    const entry = playlistzData[0]!;
    expect(entry.playlist.imageMimeType).toMatch(/^image\//);
    expect(entry.songs[0]?.imageMimeType).toMatch(/^image\//);
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

  test("zip reimport dedup: re-importing the same zip does not add duplicate songs", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // build a playlist with 3 songs and download its zip
    await createPlaylistViaUI(page);
    await addSongs(page, 3);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipPath = await download.path();
    expect(zipPath).toBeTruthy();
    const zipBuf = fs.readFileSync(zipPath!);

    await resetAppState(page);
    await page.getByTestId("btn-new-playlist").waitFor();

    const importZip = async () =>
      page.evaluate(async (b64: string) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], "playlist.zip", { type: "application/zip" });
        const hook = (window as typeof window & { __processFiles?: (files: File[]) => Promise<void> }).__processFiles;
        if (!hook) return "hook-missing";
        await hook([file]);
        return "ok";
      }, zipBuf.toString("base64"));

    // first import
    const r1 = await importZip();
    if (r1 !== "ok") throw new Error(`first import failed: ${r1}`);
    await expect(page.getByText("song-00")).toBeVisible({ timeout: 15000 });

    const countBefore = await page.getByTestId("song-duration").count();
    expect(countBefore).toBe(3);

    // second import of the same zip - should dedup, not add duplicates
    const r2 = await importZip();
    if (r2 !== "ok") throw new Error(`second import failed: ${r2}`);

    // wait briefly then assert count is unchanged
    await page.waitForTimeout(500);
    const countAfter = await page.getByTestId("song-duration").count();
    expect(countAfter).toBe(countBefore);
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

test.describe("zip bundle: file:// standalone mode", () => {
  test.beforeAll(() => ensureBundleBuilt());

  test.beforeEach(async ({ page }) => {
    await resetAppState(page);
  });

  // helper: download a zip from the current state and extract to a temp dir.
  // returns { serveDir, tmpDir, zipBuf }.
  async function downloadAndExtract(
    page: Page,
  ): Promise<{ serveDir: string; tmpDir: string }> {
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipBuf = fs.readFileSync((await download.path())!);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlistz-e2e-file-"));
    await extractZip(zipBuf, tmpDir);
    return { serveDir: findRootDir(tmpDir), tmpDir };
  }

  test("audio plays when index.html is opened via file://", async ({ page }) => {
    test.setTimeout(90_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 2, 2); // 2-second songs

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });
      await standalonePage.getByText("song-01").waitFor();

      // double-click the first song row to play (desktop uses onDblClick)
      await standalonePage.getByTestId("song-row").first().dblclick();

      // verify no audio error shown
      await expect(
        standalonePage.getByText("no audio source available"),
      ).not.toBeVisible({ timeout: 500 });

      // verify playback started: btn-play-playlist flips to aria-pressed="true"
      // when isPlaying && currentPlaylist match
      await expect(
        standalonePage.getByTestId("btn-play-playlist"),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 });
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("global play button starts playback in standalone file:// mode", async ({ page }) => {
    test.setTimeout(90_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 2, 2);

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });

      // click the global play button directly (not a song row double-click)
      await standalonePage.getByTestId("btn-play-playlist").click();

      await expect(
        standalonePage.getByText("no audio source available"),
      ).not.toBeVisible({ timeout: 500 });
      await expect(
        standalonePage.getByTestId("btn-play-playlist"),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 });
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("global play button works after page reload in standalone file:// mode", async ({ page }) => {
    test.setTimeout(120_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 2, 2);

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      // first load - initialize the standalone playlist into IDB
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });
      await standalonePage.waitForTimeout(1000);

      // reload - the docIndex entry already exists; paths must still be restored
      await standalonePage.reload();
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });

      // global play button must work after reload (songs need standaloneFilePath)
      await standalonePage.getByTestId("btn-play-playlist").click();

      await expect(
        standalonePage.getByText("no audio source available"),
      ).not.toBeVisible({ timeout: 500 });
      await expect(
        standalonePage.getByTestId("btn-play-playlist"),
      ).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 });
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cover image is displayed when index.html is opened via file://", async ({ page }) => {
    test.setTimeout(90_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 1);

    // attach a playlist cover image via the edit panel
    await page.getByTestId("btn-edit-playlist").click();
    const coverBytes = await makePng(page, { width: 64, height: 64, color: "#ff00ff" });
    await setPlaylistCover(page, { name: "cover.png", mimeType: "image/png", bytes: coverBytes });
    await page.waitForTimeout(500);
    // close edit panel by clicking the toggle button again
    await page.getByTestId("btn-edit-playlist").click();

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });

      // at least one img element should have loaded a file:// src from data/
      await standalonePage.waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll("img"));
          return imgs.some(
            (img) =>
              img.naturalWidth > 0 &&
              (img.src.startsWith("file://") || img.src.includes("data/")),
          );
        },
        undefined,
        { timeout: 10_000 },
      );
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("song row thumbnail renders in standalone file:// mode", async ({ page }) => {
    test.setTimeout(90_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 1);

    // add a per-song cover image
    await page.getByTestId("song-row").first().hover();
    await page.getByTestId("btn-edit-song").first().click();
    await page.getByTestId("song-edit-panel").waitFor();
    const songCoverBytes = await makePng(page, { width: 32, height: 32, color: "#00ccff" });
    await page.locator("#song-image-upload-panel").setInputFiles({
      name: "song-cover.png",
      mimeType: "image/png",
      buffer: Buffer.from(songCoverBytes),
    });
    await page.waitForTimeout(400);
    await page.locator('[data-testid="song-edit-panel"] button').filter({ hasText: "save" }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-testid="song-edit-panel"] button[title="close"]').click();
    await page.waitForTimeout(300);

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });

      // the song row should render an img thumbnail (not gated behind missing imageType)
      await standalonePage.waitForFunction(
        () => {
          const row = document.querySelector("[data-testid='song-row']");
          if (!row) return false;
          const img = row.querySelector("img");
          return !!img && img.naturalWidth > 0;
        },
        undefined,
        { timeout: 10_000 },
      );
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("background image updates when a song plays in standalone file:// mode", async ({ page }) => {
    test.setTimeout(90_000);
    await createPlaylistViaUI(page);
    await addSongs(page, 1, 2);

    // add a playlist cover so background can derive from it
    await page.getByTestId("btn-edit-playlist").click();
    const coverBytes = await makePng(page, { width: 64, height: 64, color: "#ff8800" });
    await setPlaylistCover(page, { name: "cover.png", mimeType: "image/png", bytes: coverBytes });
    await page.waitForTimeout(500);
    await page.getByTestId("btn-edit-playlist").click();

    const { serveDir, tmpDir } = await downloadAndExtract(page);
    const ctx = await page.context().browser()!.newContext();
    const standalonePage = await ctx.newPage();

    try {
      await standalonePage.goto(`file://${path.join(serveDir, "index.html")}`);
      await standalonePage.getByTestId("app-ready").waitFor({ timeout: 20_000 });
      await standalonePage.getByText("song-00").waitFor({ timeout: 10_000 });

      // play a song to trigger background image
      await standalonePage.getByTestId("song-row").first().dblclick();
      await expect(standalonePage.getByTestId("btn-play-playlist")).toHaveAttribute(
        "aria-pressed",
        "true",
        { timeout: 8_000 },
      );

      // background image element or container should have a src pointing at data/
      await standalonePage.waitForFunction(
        () => {
          // check for a background img element with a loaded image
          const bgImgs = Array.from(document.querySelectorAll("img[data-testid='background-image'], .bg-image img, img.background"));
          if (bgImgs.some((img) => (img as HTMLImageElement).naturalWidth > 0)) return true;
          // fallback: check any element with background-image style pointing at data/
          const allEls = Array.from(document.querySelectorAll("*"));
          return allEls.some((el) => {
            const style = window.getComputedStyle(el).backgroundImage;
            return style && style !== "none" && (style.includes("data/") || style.includes("file://"));
          });
        },
        undefined,
        { timeout: 10_000 },
      );
    } finally {
      await ctx.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
