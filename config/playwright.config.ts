import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// e2e tests for playlistz. run with `npm run test:e2e`.
// the dev server is started automatically on a dedicated port.
export default defineConfig({
  testDir: "../e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // single worker: tests share the dev server origin's indexeddb state,
  // and each test resets storage in beforeEach
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5917",
    trace: "on-first-retry",
    viewport: { width: 1400, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // allow audio playback without a user gesture in headless runs
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: {
    command: "npx vite --config config/vite.config.ts --port 5917",
    // cwd defaults to the config file's directory; run from the repo root
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    port: 5917,
    reuseExistingServer: !process.env.CI,
  },
});
