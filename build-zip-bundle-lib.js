#!/usr/bin/env node
// builds the ./zip-bundle export as a pure ESM library.
import { build } from "esbuild";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outDir = path.resolve(__dirname, "dist/zip-bundle");
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

console.log("building dist/zip-bundle/index.js...");

await build({
  entryPoints: [path.resolve(__dirname, "src/zip-bundle/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: path.resolve(outDir, "index.js"),
  external: ["jszip", "zod"],
  sourcemap: true,
  minify: false,
});

console.log("generating dist/zip-bundle type declarations...");

execSync(
  "npx tsc --declaration --emitDeclarationOnly --noEmit false " +
    "--moduleResolution bundler --module esnext " +
    "--outDir dist/zip-bundle " +
    "src/zip-bundle/index.ts",
  { cwd: __dirname, stdio: "inherit" }
);

console.log("done: dist/zip-bundle/");
