import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

// serve built dist/ assets (e.g. freqhole-playlistz.js) during dev
function serveDistAssets() {
  return {
    name: "serve-dist-assets",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "/";
        const distPath = path.resolve(__dirname, "../dist", url.replace(/^\//, ""));
        if (fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
          const ext = path.extname(distPath);
          const mime = ext === ".js" || ext === ".mjs" ? "application/javascript"
            : ext === ".map" ? "application/json"
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
  plugins: [solid(), tailwindcss(), serveDistAssets()],
  server: {
    port: 3000,
    host: true,
    open: true,
  },
  build: {
    target: "esnext",
    minify: true,
    sourcemap: true,
  },
});
