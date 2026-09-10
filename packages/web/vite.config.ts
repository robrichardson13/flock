import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fallback for a bare `bun x vite` / `bun run dev` with no CLI in front: listen on every
    // interface so the UI is reachable over Tailscale (http://my-machine:5173). `flock up`
    // overrides this with an explicit --host (ADR 0015), resolved from --host/FLOCK_HOST/default.
    host: true,
    // Accept any Host header: Vite rejects non-localhost hostnames by default.
    allowedHosts: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.FLOCK_PORT ?? 4747}`, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
