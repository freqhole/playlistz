import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
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
