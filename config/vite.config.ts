import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import fs from "node:fs";
import path from "node:path";

// resolves the bare "midden" specifier that reliquary's blob worker
// dynamically imports (see @freqhole/reliquary/worker's midden-blake3.ts).
// a plain `resolve.alias` entry does not reach this import: it's inside a
// worker's own module graph, which vite builds through a separate plugin
// pipeline from the main app - `resolve.alias` only applies to the graph
// it's declared against, so the alias has to be re-declared as an actual
// plugin and included in both the main `plugins` and `worker.plugins` lists
// below for it to apply to both.
function middenBareSpecifierPlugin(): Plugin {
  return {
    name: "midden-bare-specifier",
    resolveId(source) {
      if (source === "midden") {
        return this.resolve("@freqhole/midden", undefined, { skipSelf: true });
      }
      return null;
    },
  };
}

// serve built dist/ assets (e.g. freqhole-playlistz.js) during dev
function serveDistAssets() {
  return {
    name: "serve-dist-assets",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "/";
        const distPath = path.resolve(
          __dirname,
          "../dist",
          url.replace(/^\//, "")
        );
        if (fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
          const ext = path.extname(distPath);
          const mime =
            ext === ".js" || ext === ".mjs"
              ? "application/javascript"
              : ext === ".map"
                ? "application/json"
                : "application/octet-stream";
          res.setHeader("Content-Type", mime);
          fs.createReadStream(distPath).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    solid(),
    tailwindcss(),
    serveDistAssets(),
    middenBareSpecifierPlugin(),
  ],
  // reliquary's blob worker pulls in @freqhole/midden (wasm) for blake3 -
  // worker bundles need the same wasm + bare-specifier handling as the
  // main app, via their own separate plugin pipeline.
  worker: {
    format: "es",
    plugins: () => [wasm(), middenBareSpecifierPlugin()],
  },
  server: {
    port: 3000,
    host: true,
    open: true,
    fs: {
      // @freqhole/haruspex, @freqhole/reliquary, @freqhole/midden, and
      // @freqhole/api-client are file: deps pointing at sibling repos
      // (../haruspex/ts, ../reliquary/ts, ../midden/pkg,
      // ../tomb/client-codegen/freqhole-api-client), so vite's default
      // dev-server file allowlist (project root + node_modules only)
      // blocks serving their real, non-symlink-resolved source/dist files -
      // matching spume's and skein/loam's vite configs, which need the
      // same allowance for the same reason.
      allow: [
        ".",
        "../haruspex",
        "../reliquary",
        "../midden",
        "../tomb/client-codegen/freqhole-api-client",
      ],
    },
  },
  // @freqhole/midden contains a .wasm file that esbuild can't pre-bundle;
  // vite-plugin-wasm handles it instead.
  optimizeDeps: {
    exclude: ["@freqhole/midden"],
  },
  build: {
    target: "esnext",
    minify: true,
    sourcemap: true,
  },
});
