// dev hook wrappers for e2e tests.
//
// typed wrappers around window.__* hooks registered by src/dev-hooks.ts.
// these are only available in DEV builds (the vite dev server).
//
// convention: tests that use any mockBlobFetch / clearMockBlobFetch call
// should tag their test description with "@mock" so they can be run or
// excluded as a group:
//
//   test("downloads blob from peer @mock", async ({ page }) => { ... })
//
//   # run only transport-mocked tests:
//   npm run test:e2e:mock
//
//   # run everything except mocked transport tests:
//   npm run test:e2e:real
//
// the time-acceleration hooks (seekTo, triggerTrackEnd, triggerAudioError)
// are NOT considered "mock" - they accelerate time on the real audio element
// without substituting any service boundary. use them freely in any test.

import type { Page } from "@playwright/test";

// mock blob behaviour modes - single source of truth is global.d.ts (Window interface).
// this re-derives the type so e2e tests don't need to import from src/.
export type MockBlobBehaviour = NonNullable<Window["__mockBlobFetch"]> extends (
  b: infer B
) => void
  ? B
  : never;

// --- time-acceleration hooks ---
// these drive the real audio element without substituting any service boundary.

// returns the title of the currently playing song, or null if nothing is playing.
// use this instead of looking for a DOM element to assert playback state.
export async function currentSong(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__currentSong?.() ?? null);
}

// seek the audio element to a specific time (seconds)
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => window.__seekTo?.(t), seconds);
}

// fire the "ended" event on the audio element (advance to next track)
export async function triggerTrackEnd(page: Page): Promise<void> {
  await page.evaluate(() => window.__triggerTrackEnd?.());
}

// fire an audio error event (code defaults to MEDIA_ERR_SRC_NOT_SUPPORTED = 4)
export async function triggerAudioError(page: Page, code = 4): Promise<void> {
  await page.evaluate((c) => window.__triggerAudioError?.(c), code);
}

// --- transport mock hooks ---
// tests that call these should be tagged @mock in their description.

// override p2p blob fetching with a deterministic mock behaviour.
// call clearMockBlobFetch in afterEach / at the end of each test.
export async function mockBlobFetch(
  page: Page,
  behaviour: MockBlobBehaviour
): Promise<void> {
  await page.evaluate(
    (b) => window.__mockBlobFetch?.(b),
    behaviour as Parameters<NonNullable<typeof window.__mockBlobFetch>>[0]
  );
}

// restore real p2p blob fetching (always call this after a transport mock test)
export async function clearMockBlobFetch(page: Page): Promise<void> {
  await page.evaluate(() => window.__clearMockBlobFetch?.());
}

// --- blob store control ---
// these manipulate the local blob cache directly; not "mocking" per se,
// but often used alongside transport mocks to create a cache-miss scenario.

// remove a blob from local store (simulates a cache miss before pressing play)
export async function evictBlob(page: Page, sha256: string): Promise<void> {
  await page.evaluate((sha) => window.__evictBlob?.(sha), sha256);
}

// set the blob fetch timeout in ms (default 30000). use a short value in
// tests to avoid waiting for the real 30s when testing timeout behaviour.
// reset to 30000 after the test.
export async function setBlobFetchTimeout(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => window.__setBlobFetchTimeout?.(t), ms);
}

// programmatically trigger a blob fetch by sha256.
// useful when the retry click target is obstructed by an overlay element.
export async function fetchBlobBySha(page: Page, sha256: string): Promise<void> {
  await page.evaluate((sha) => window.__fetchBlobBySha?.(sha), sha256);
}

// --- docIndex dev hooks (registered in src/dev-hooks.ts) ---

export interface DocIndexEntry {
  docId: string;
  title: string;
  addedAt: number;
  source: "local" | "shared" | "freqhole";
  remoteNodeId?: string;
  remoteName?: string;
  isForked?: boolean;
}

// return all docIndex entries from the running app (via service layer, not raw idb)
export async function getDocIndexEntries(page: Page): Promise<DocIndexEntry[]> {
  // the hook is registered after a dynamic import - wait for it to appear
  await page.waitForFunction(() => typeof window.__getDocIndexEntries === "function", {
    timeout: 5000,
  });
  return page.evaluate(() => window.__getDocIndexEntries!()) as Promise<DocIndexEntry[]>;
}

// patch a docIndex entry in-place (merge patch), then wait for the app to
// re-sync its playlist list from the updated docIndex
export async function patchDocIndexEntry(
  page: Page,
  docId: string,
  patch: Partial<DocIndexEntry>
): Promise<void> {
  await page.waitForFunction(() => typeof window.__patchDocIndexEntry === "function", {
    timeout: 5000,
  });
  await page.evaluate(
    ({ docId, patch }) => window.__patchDocIndexEntry!(docId, patch),
    { docId, patch }
  );
}
