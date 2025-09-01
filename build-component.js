#!/usr/bin/env node
/* global console, process */
import { build } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";

console.log("building standalone playlistz html...");

// copy static service worker file
function copyServiceWorker() {
  const swPath = path.resolve("public/sw.js");
  if (fs.existsSync(swPath)) {
    return fs.readFileSync(swPath, "utf-8");
  }
  console.warn("no service worker found at public/sw.js");
  return null;
}

// generate html template for standalone build
function generateStandaloneHtml(jsCode, cssCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>playlistz</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#000000">
  <link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">
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
    /* ensure proper text wrapping */
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

// create web component entry point if it doesn't exist
function createWebComponentEntry() {
  const webComponentPath = path.resolve("src/web-component.tsx");

  if (!fs.existsSync(webComponentPath)) {
    const webComponentCode = `
import { customElement } from "solid-element";
import { Playlistz } from "./components";
import "./styles.css";

customElement("freqhole-playlistz", {}, () => {
  return <Playlistz />;
});
`.trim();

    fs.writeFileSync(webComponentPath, webComponentCode);
    console.log("created web component entry point");
  }
}

// build standalone html file
async function buildStandalone() {
  console.log("building standalone html...");

  // ensure web component entry exists
  createWebComponentEntry();

  // clear and create dist directory
  const distDir = path.resolve("dist");
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  try {
    await build({
      configFile: false,
      plugins: [
        solid({
          typescript: true,
          jsx: "preserve",
        }),
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

              console.log("generated: freqhole-playlistz.html");

              // copy service worker if it exists
              const swCode = copyServiceWorker();
              if (swCode) {
                this.emitFile({
                  type: "asset",
                  fileName: "sw.js",
                  source: swCode,
                });
                console.log("generated: sw.js");
              }

              // remove js and css files from output (but keep sw.js)
              Object.keys(bundle).forEach((fileName) => {
                if (
                  (fileName.endsWith(".js") || fileName.endsWith(".css")) &&
                  fileName !== "sw.js"
                ) {
                  delete bundle[fileName];
                }
              });
            } else {
              console.error("no js chunk found in bundle");
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

    console.log("standalone build completed!");
    console.log(`output: ${path.resolve("dist/freqhole-playlistz.html")}`);
  } catch (error) {
    console.error("error building standalone:", error);
    process.exit(1);
  }
}

// main execution
buildStandalone();
