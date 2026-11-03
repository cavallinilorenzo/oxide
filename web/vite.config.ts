import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // ES workers keep Shiki's grammars as lazily loaded chunks.
  worker: { format: "es" },
  clearScreen: false,
  test: {
    // Limit worker count so machines with many cores don't spawn more
    // isolated jsdom environments than the machine can comfortably run,
    // which caused flaky canvas/jsdom failures in AppGithubDock.
    maxWorkers: 4,
  },
  server: { port: 1420, strictPort: true },
});
