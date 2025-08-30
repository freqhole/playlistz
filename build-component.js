#!/usr/bin/env node
/* global console, process */
import { build } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";

// Check for command line arguments
const isStandalone = process.argv.includes("--standalone");
const isWebComponent =
  process.argv.includes("--web-component") || !isStandalone;

console.log(
  `🔨 Building Playlistz ${isStandalone ? "standalone HTML" : "web component"}...`
);

// Generate service worker code
function generateServiceWorker() {
  return `
// Playlistz Service Worker
const CACHE_NAME = 'playlistz-v1';
const urlsToCache = [
  '/',
  '/freqhole-playlistz.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});
`.trim();
}

// Generate HTML template for standalone build
function generateStandaloneHtml(jsCode, cssCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Playlistz</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#000000">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 16px;
      margin: 0;
      padding: 0;
      background-color: black;
      color: white;
    }
    /* Ensure proper text wrapping */
    .break-words {
      word-wrap: break-word;
      word-break: break-word;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    ${cssCode || ""}
  </style>
</head>
<body>
  <freqhole-playlistz></freqhole-playlistz>
  <script type="module">
${jsCode}
  </script>
</body>
</html>`;
}

// Create web component entry point if it doesn't exist
function createWebComponentEntry() {
  const webComponentPath = path.resolve("src/web-component.tsx");

  if (!fs.existsSync(webComponentPath)) {
    const webComponentCode = `
import { customElement } from "solid-element";
import { PlaylistManager } from "./components/PlaylistManager";
import "./styles.css";

customElement("freqhole-playlistz", {}, () => {
  return <PlaylistManager />;
});
`.trim();

    fs.writeFileSync(webComponentPath, webComponentCode);
    console.log("✅ Created web component entry point");
  }
}

// Build standalone HTML file
async function buildStandalone() {
  console.log("📦 Building standalone HTML...");

  // Ensure web component entry exists
  createWebComponentEntry();

  try {
    await build({
      configFile: false,
      plugins: [
        solid(),
        tailwindcss(),
        {
          name: "generate-standalone-html",
          generateBundle(_, bundle) {
            const jsChunk = Object.values(bundle).find(
              (file) => file.type === "chunk" && typeof file.code === "string"
            );

            const cssAsset = Object.values(bundle).find(
              (file) =>
                file.type === "asset" &&
                typeof file.fileName === "string" &&
                file.fileName.endsWith(".css")
            );

            if (jsChunk) {
              const cssCode = cssAsset ? cssAsset.source : undefined;
              const html = generateStandaloneHtml(jsChunk.code, cssCode);

              this.emitFile({
                type: "asset",
                fileName: "freqhole-playlistz.html",
                source: html,
              });

              console.log("✅ Generated: freqhole-playlistz.html");

              // Generate service worker
              const swCode = generateServiceWorker();
              this.emitFile({
                type: "asset",
                fileName: "sw.js",
                source: swCode,
              });
              console.log("✅ Generated: sw.js");

              // Remove JS and CSS files from output (but keep sw.js)
              Object.keys(bundle).forEach((fileName) => {
                if (
                  (fileName.endsWith(".js") || fileName.endsWith(".css")) &&
                  fileName !== "sw.js"
                ) {
                  delete bundle[fileName];
                }
              });
            }
          },
        },
      ],
      build: {
        outDir: "dist",
        target: "esnext",
        minify: true,
        sourcemap: false,
        emptyOutDir: false,
        rollupOptions: {
          input: "./src/web-component.tsx",
          output: {
            entryFileNames: "playlistz.js",
            chunkFileNames: "playlistz-[hash].js",
            assetFileNames: "playlistz.[ext]",
            inlineDynamicImports: true,
          },
        },
      },
    });

    console.log("🎉 Standalone build completed!");
  } catch (error) {
    console.error("❌ Error building standalone:", error);
    process.exit(1);
  }
}

// Build web component JS file
async function buildWebComponent() {
  console.log("📦 Building web component...");

  // Ensure web component entry exists
  createWebComponentEntry();

  try {
    await build({
      configFile: false,
      plugins: [solid(), tailwindcss()],
      build: {
        outDir: "dist",
        target: "esnext",
        minify: true,
        sourcemap: true,
        emptyOutDir: false,
        lib: {
          entry: "./src/web-component.tsx",
          name: "PlaylistzWebComponent",
          fileName: "web-component",
          formats: ["es"],
        },
        rollupOptions: {
          output: {
            inlineDynamicImports: true,
          },
        },
      },
    });

    console.log("✅ Generated: web-component.js");
    console.log("🎉 Web component build completed!");
  } catch (error) {
    console.error("❌ Error building web component:", error);
    process.exit(1);
  }
}

// Clear dist directory
function clearDist() {
  const distDir = path.resolve("dist");
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
}

// Main execution
async function main() {
  clearDist();

  if (isStandalone) {
    await buildStandalone();
  } else {
    await buildWebComponent();
  }
}

main();
