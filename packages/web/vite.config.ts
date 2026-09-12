import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A build id the running page can report back on `POST /api/presence`, so a log line says which
 * bundle a device is actually running (card 54: an iOS home-screen app can serve a stale bundle
 * across a relaunch, and nothing else distinguishes that from a presence bug).
 *
 * `<short sha>[+dirty]-<base36 start time>`. The start-time suffix is what makes a dev-server
 * restart visible: two pages off the same commit but different server processes differ here.
 * Falls back to `nogit-<start>` outside a git checkout; never fails the build.
 */
function buildId(): string {
  let sha = "nogit";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (dirty.length > 0) sha += "+dirty";
  } catch {
    // A tarball or a shallow copy with no git: the timestamp alone still identifies the bundle.
  }
  return `${sha}-${Date.now().toString(36)}`.slice(0, 64);
}

export default defineConfig({
  plugins: [react()],
  define: { __FLOCK_BUILD_ID__: JSON.stringify(buildId()) },
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
