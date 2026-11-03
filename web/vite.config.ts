import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // ES workers keep Shiki's grammars as lazily loaded chunks.
  worker: { format: "es" },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
