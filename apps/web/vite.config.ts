import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HUB = "http://127.0.0.1:4242";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Playwright MCP writes screenshots into the repo; a full reload per PNG is not helpful.
    watch: { ignored: ["**/.playwright-mcp/**"] },
    proxy: {
      "/api": HUB,
      "/v1": HUB,
      "/ws": { target: HUB.replace("http://", "ws://"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
