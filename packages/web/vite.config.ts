import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on every interface so the UI is reachable over Tailscale (http://my-machine:5173),
    // and accept any Host header: Vite rejects non-localhost hostnames by default.
    host: true,
    allowedHosts: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.FLOCK_PORT ?? 4747}`, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
