#!/usr/bin/env node
/* global console, process */
import { build } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { transform, build as esbuild } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("building freqhole-playlistz.js + freqhole-playlistz-cli.mjs...");

// build the node cli as a standalone esm bundle
async function buildCli(indexHtml, swJs) {
  console.log("building freqhole-playlistz-cli.mjs...");
  const result = await esbuild({
    entryPoints: [path.resolve(__dirname, "src/cli/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.resolve("dist/freqhole-playlistz-cli.mjs"),
    minify: true,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  });

  // replace placeholder strings in the written file
  let code = fs.readFileSync(path.resolve("dist/freqhole-playlistz-cli.mjs"), "utf-8");
  code = code.replace('"__INDEX_HTML__"', JSON.stringify(indexHtml));
  code = code.replace('"__SW_JS__"', JSON.stringify(swJs));
  fs.writeFileSync(path.resolve("dist/freqhole-playlistz-cli.mjs"), code, "utf-8");

  // make executable
  fs.chmodSync(path.resolve("dist/freqhole-playlistz-cli.mjs"), 0o755);
  console.log("generated: freqhole-playlistz-cli.mjs");
  return result;
}

// read static service worker file
function readServiceWorker() {
  const swPath = path.resolve("public/sw.js");
  if (fs.existsSync(swPath)) {
    return fs.readFileSync(swPath, "utf-8");
  }
  console.warn("no service worker found at public/sw.js");
  return null;
}

// generate the minimal static index.html shell
function generateIndexHtml() {
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
</head>
<body>
  <script src="playlistz.js"></script>
  <script src="freqhole-playlistz.js"></script>
  <freqhole-playlistz></freqhole-playlistz>
</body>
</html>
`;
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

// build standalone freqhole-playlistz.js
async function buildStandalone() {
  console.log("building freqhole-playlistz.js...");

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
          name: "build-freqhole-playlistz",
          async generateBundle(_, bundle) {
            const jsChunk = Object.values(bundle).find(
              (file) => file.type === "chunk" && typeof file.code === "string"
            );

            const cssAsset = Object.values(bundle).find(
              (file) =>
                file.type === "asset" &&
                typeof file.fileName === "string" &&
                file.fileName.endsWith(".css")
            );

            if (!jsChunk) {
              console.error("no js chunk found in bundle");
              return;
            }

            // inline css: minify it first via esbuild, then embed as a string injector
            const cssCode = cssAsset ? String(cssAsset.source) : "";
            let cssInjector = "";
            if (cssCode) {
              const cssMinified = (await transform(cssCode, { loader: "css", minify: true })).code.replace(/\n/g, "");
              cssInjector = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(cssMinified)};document.head.appendChild(s);})();\n`;
            }

            // browser-only source: solid web component wrapped in iife.
            // no isNode block - the cli is a separate .mjs build.
            const source = cssInjector + jsChunk.code;

            // single esbuild pass: minify everything + generate sourcemap.
            // format:'iife' wraps the whole thing so no type="module" needed,
            // which means it works on file:// urls without cors issues.
            const result = await transform(source, {
              minify: true,
              sourcemap: true,
              format: "iife",
              target: "esnext",
            });

            jsChunk.code = result.code + "\n//# sourceMappingURL=freqhole-playlistz.js.map\n";
            jsChunk.fileName = "freqhole-playlistz.js";

            // rename the chunk key in the bundle
            const oldKey = Object.keys(bundle).find((k) => bundle[k] === jsChunk);
            if (oldKey && oldKey !== "freqhole-playlistz.js") {
              bundle["freqhole-playlistz.js"] = jsChunk;
              delete bundle[oldKey];
            }

            console.log("generated: freqhole-playlistz.js");

            // emit sourcemap as a separate asset
            if (result.map) {
              this.emitFile({
                type: "asset",
                fileName: "freqhole-playlistz.js.map",
                source: result.map,
              });
              console.log("generated: freqhole-playlistz.js.map");
            }

            // emit static index.html
            this.emitFile({
              type: "asset",
              fileName: "index.html",
              source: generateIndexHtml(),
            });
            console.log("generated: index.html");

            // emit service worker
            const swCode = readServiceWorker();
            if (swCode) {
              this.emitFile({
                type: "asset",
                fileName: "sw.js",
                source: swCode,
              });
              console.log("generated: sw.js");
            }

            // remove css from output (inlined into js)
            Object.keys(bundle).forEach((fileName) => {
              if (fileName.endsWith(".css")) {
                delete bundle[fileName];
              }
            });
          },
        },
      ],
      build: {
        outDir: "dist",
        target: "esnext",
        minify: false,
        sourcemap: false,
        emptyOutDir: false,
        rollupOptions: {
          input: "./src/web-component.tsx",
          output: {
            format: "es",
            entryFileNames: "playlistz-entry.js",
            chunkFileNames: "playlistz-[hash].js",
            assetFileNames: "playlistz.[ext]",
            inlineDynamicImports: true,
          },
        },
      },
    });

    const indexHtml = generateIndexHtml();
    const swJs = readServiceWorker() ?? "";
    await buildCli(indexHtml, swJs);

    console.log("build completed!");
    console.log(`  browser: ${path.resolve("dist/freqhole-playlistz.js")}`);
    console.log(`  cli:     ${path.resolve("dist/freqhole-playlistz-cli.mjs")}`);
  } catch (error) {
    console.error("error building:", error);
    process.exit(1);
  }
}

// main execution
buildStandalone();
