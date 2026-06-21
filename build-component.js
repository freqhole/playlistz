#!/usr/bin/env node
import { build } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { transform, build as esbuild } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skipClear = process.argv.includes("--no-clear");

function readServiceWorker() {
  const swPath = path.resolve("public/sw.js");
  return fs.existsSync(swPath) ? fs.readFileSync(swPath, "utf-8") : null;
}

function generateIndexHtml() {
  // this is the dev server / standalone shell - no playlistz.js here.
  // zip bundles get their own index.html (with playlistz.js) from standaloneTemplates.ts.
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
  <freqhole-playlistz></freqhole-playlistz>
  <script src="freqhole-playlistz.js" defer></script>
</body>
</html>
`;
}

async function buildStandalone() {
  const distDir = path.resolve("dist");
  if (!skipClear) {
    if (fs.existsSync(distDir))
      fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  const indexHtml = generateIndexHtml();
  const swJs = readServiceWorker() ?? "";

  // ---- browser bundle ----
  console.log("building freqhole-playlistz.js...");
  let browserCode = "";
  let cssCode = "";

  await build({
    configFile: false,
    plugins: [
      wasm(),
      topLevelAwait(),
      solid({ typescript: true, jsx: "preserve" }),
      tailwindcss(),
      {
        name: "capture-browser-bundle",
        enforce: "post",
        async generateBundle(_, bundle) {
          const jsChunk = Object.values(bundle).find(
            (f) => f.type === "chunk" && typeof f.code === "string"
          );
          const cssAsset = Object.values(bundle).find(
            (f) => f.type === "asset" && String(f.fileName).endsWith(".css")
          );
          if (!jsChunk) {
            console.error("no js chunk found");
            return;
          }
          for (const [fileName, file] of Object.entries(bundle)) {
            if (file.type === "asset" && fileName.endsWith(".wasm")) {
              const b64 = Buffer.from(file.source).toString("base64");
              const dataUri = `data:application/wasm;base64,${b64}`;
              jsChunk.code = jsChunk.code.split(`/${fileName}`).join(dataUri);
              delete bundle[fileName];
              console.log(
                `  inlined wasm: ${fileName} (${(b64.length / 1024 / 1024).toFixed(1)} mb)`
              );
            }
          }
          cssCode = cssAsset ? String(cssAsset.source) : "";
          browserCode = jsChunk.code;
          for (const key of Object.keys(bundle)) delete bundle[key];
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
        external: ["@freqhole/midden"],
      },
    },
  });

  let cssInjector = "";
  if (cssCode) {
    const cssMinified = (
      await transform(cssCode, { loader: "css", minify: true })
    ).code.replace(/\n/g, "");
    cssInjector = `(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(cssMinified)};document.head.appendChild(s);})();\n`;
  }
  const { code: browserMinified } = await transform(cssInjector + browserCode, {
    minify: true,
    sourcemap: false,
    format: "iife",
    target: "esnext",
  });
  fs.writeFileSync(
    path.resolve("dist/freqhole-playlistz.js"),
    browserMinified,
    "utf-8"
  );
  console.log(
    `generated: freqhole-playlistz.js (${(browserMinified.length / 1024 / 1024).toFixed(2)} mb)`
  );

  // ---- cli bundle ----
  console.log("building freqhole-playlistz.cli.mjs...");
  const cliOut = path.resolve("dist/freqhole-playlistz.cli.mjs");
  const cliEntry = path.resolve(__dirname, "src/cli/index.ts");
  await esbuild({
    entryPoints: [cliEntry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: cliOut,
    minify: true,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { "import.meta.url": '"file://"' },
  });
  let cliCode = fs.readFileSync(cliOut, "utf-8");
  cliCode = cliCode.replace('"__INDEX_HTML__"', JSON.stringify(indexHtml));
  cliCode = cliCode.replace('"__SW_JS__"', JSON.stringify(swJs));
  fs.writeFileSync(cliOut, cliCode, "utf-8");
  fs.chmodSync(cliOut, 0o755);
  console.log("generated: freqhole-playlistz.cli.mjs");

  // ---- static assets ----
  fs.writeFileSync(path.resolve("dist/index.html"), indexHtml, "utf-8");
  if (swJs) fs.writeFileSync(path.resolve("dist/sw.js"), swJs, "utf-8");
  console.log("generated: index.html, sw.js");

  console.log("\nbuild completed!");
  console.log("  browser: dist/freqhole-playlistz.js");
  console.log("  cli:     dist/freqhole-playlistz.cli.mjs");
}

buildStandalone().catch((err) => {
  console.error("build failed:", err);
  process.exit(1);
});
