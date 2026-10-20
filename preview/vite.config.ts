import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Browser preview of the UI with the Tauri APIs swapped for in-memory fakes,
// so the interface can be developed and screenshotted without building the
// Rust side. `npm run preview:ui`, then open http://localhost:1421.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const mock = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  root: fileURLToPath(new URL("..", import.meta.url)),
  clearScreen: false,
  server: { port: 1421, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: mock("core.ts") },
      { find: "@tauri-apps/api/window", replacement: mock("window.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: mock("dialog.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: mock("opener.ts") },
    ],
  },
});
