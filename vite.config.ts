import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Bundle the parser's CommonJS entry, not the ESM wrapper shipped beside
      // it. That wrapper is `import mod from "./index.js"` plus a named
      // re-export per function, and the CJS entry sets `__esModule` with its
      // own `default` — so a bundler hands the wrapper the DEFAULT export (one
      // function) where it expects the whole namespace, and every named export
      // resolves to undefined. `parseFilter` then became `undefined` at module
      // init and every query in a packaged build failed with "is not a
      // function", whatever it contained. Dev never showed it: unbundled, the
      // named import is resolved at run time and works.
      //
      // Resolved through the package's own entry rather than a written-out
      // path, so it follows the package if it moves.
      "mongodb-query-parser": createRequire(import.meta.url).resolve(
        "mongodb-query-parser",
      ),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
