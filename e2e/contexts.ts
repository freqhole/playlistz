// e2e test matrix infrastructure.
//
// exports SERVE_CONTEXTS, VIEWPORTS, withContext, and describeMatrix so
// spec files can run the same scenarios across multiple serving modes and
// viewport sizes without duplicating setup code.
//
// note: resetAppState() relies on navigating to "/" and clearing indexeddb
// on the vite dev server origin. it does NOT work in zip-http context because
// that browser context has a different origin and no dev-server idb to clear.

import { test, type Page, type BrowserContext } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import { execSync } from "node:child_process";
import JSZip from "jszip";

// --- serve context descriptors ---

export type ServeContextName = "vite" | "zip-http";

export interface ServeContext {
  name: ServeContextName;
  /** base url used to navigate the page, set during withContext setup */
  baseURL: string;
}

export const SERVE_CONTEXTS: ServeContext[] = [
  { name: "vite", baseURL: "http://localhost:5917" },
  { name: "zip-http", baseURL: "" }, // baseURL filled in dynamically during setup
];

// --- viewport configs ---

export interface ViewportConfig {
  name: string;
  width: number;
  height: number;
}

export const VIEWPORTS: ViewportConfig[] = [
  { name: "desktop", width: 1400, height: 900 },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "mobile",  width: 390,  height: 844 },
];

// --- static server (for zip-http context) ---

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".flac": "audio/flac",
  ".ogg":  "audio/ogg",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".map":  "application/json",
};

export function startStaticServer(dir: string, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const rawPath = req.url?.split("?")[0] ?? "/";
    const urlPath = decodeURIComponent(rawPath);
    const filePath = path.join(dir, urlPath === "/" ? "index.html" : urlPath);

    const absDir = path.resolve(dir);
    const absFile = path.resolve(filePath);
    if (!absFile.startsWith(absDir + path.sep) && absFile !== absDir) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    if (!fs.existsSync(absFile) || fs.statSync(absFile).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
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

// extract a jszip buffer to a directory. returns the output dir.
export async function extractZip(zipBuffer: Buffer, outDir: string): Promise<string> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const writes: Promise<void>[] = [];
  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    const dest = path.join(outDir, relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writes.push(file.async("nodebuffer").then((buf) => fs.writeFileSync(dest, buf)));
  });
  await Promise.all(writes);
  return outDir;
}

// find the first subdirectory containing index.html, or fall back to outDir.
export function findRootDir(outDir: string): string {
  for (const entry of fs.readdirSync(outDir)) {
    const sub = path.join(outDir, entry);
    if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, "index.html"))) {
      return sub;
    }
  }
  return outDir;
}

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const BUNDLE_PATH = path.join(REPO_ROOT, "dist", "freqhole-playlistz.js");

export function ensureBundleBuilt(): void {
  if (fs.existsSync(BUNDLE_PATH)) return;
  console.log("[contexts] dist/freqhole-playlistz.js not found - running build:standalone...");
  execSync("npm run build:standalone", { cwd: REPO_ROOT, stdio: "inherit" });
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error("build:standalone did not produce dist/freqhole-playlistz.js");
  }
}

// port range 5930-5939 (avoids collision with vite 5917, standalone 5920/5921)
const ZIP_HTTP_BASE_PORT = 5930;

// --- withContext helper ---

// callback signature used inside withContext
export type ContextTestFn = (page: Page, ctx: ServeContext) => Promise<void>;

// wraps a test body with the appropriate setup for the given serve context.
//
// vite: calls fn(page, ctx) directly - the page is already on the vite origin.
// zip-http: downloads a zip from the vite dev server (requires a playlist with
//   songs to already exist on the page), extracts it, starts a static server,
//   opens a fresh browser context at that origin, calls fn(standalonePage, ctx),
//   then tears down. the port offset is used to avoid collisions when multiple
//   zip-http contexts run in the same process.
export async function withContext(
  ctx: ServeContext,
  page: Page,
  fn: ContextTestFn,
  portOffset = 0
): Promise<void> {
  if (ctx.name === "vite") {
    await fn(page, ctx);
    return;
  }

  if (ctx.name === "zip-http") {
    const port = ZIP_HTTP_BASE_PORT + portOffset;

    // download zip from the current vite dev page (caller must have a playlist ready)
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.getByTestId("btn-download-zip").click();
    const download = await downloadPromise;
    const zipPath = await download.path();
    if (!zipPath) throw new Error("zip download path is null");

    const zipBuf = fs.readFileSync(zipPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "playlistz-ctx-"));
    await extractZip(zipBuf, tmpDir);
    const serveDir = findRootDir(tmpDir);

    const server = await startStaticServer(serveDir, port);
    const origin = `http://localhost:${port}`;
    const resolvedCtx: ServeContext = { name: "zip-http", baseURL: origin };

    let browserCtx: BrowserContext | undefined;
    try {
      browserCtx = await page.context().browser()!.newContext();
      const standalonePage = await browserCtx.newPage();
      await standalonePage.goto(`${origin}/`);
      await standalonePage.waitForSelector('[data-testid="app-ready"]', { timeout: 15000 });
      await fn(standalonePage, resolvedCtx);
    } finally {
      await browserCtx?.close();
      await new Promise<void>((res) => server.close(() => res()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// --- describeMatrix ---

// suite body callback receives the serve context (available at describe-definition
// time) and the viewport config. page is accessed via the normal playwright
// { page } fixture inside each test() block, then passed to withContext().
//
// usage:
//   describeMatrix("my feature", (ctx, vp) => {
//     test("does something", async ({ page }) => {
//       await withContext(ctx, page, async (ctxPage) => {
//         await expect(ctxPage.getByTestId("app-ready")).toBeVisible();
//       });
//     });
//   });
export type MatrixSuiteFn = (ctx: ServeContext, vp: ViewportConfig) => void;

// generates a test.describe block for each SERVE_CONTEXT x VIEWPORT combination,
// applying the viewport via test.use() before the suite body runs.
export function describeMatrix(label: string, suiteBody: MatrixSuiteFn): void {
  for (const ctx of SERVE_CONTEXTS) {
    for (const vp of VIEWPORTS) {
      test.describe(`${label} [${ctx.name} / ${vp.name}]`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });
        suiteBody({ ...ctx }, vp);
      });
    }
  }
}
