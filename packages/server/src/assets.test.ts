import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock } from "@flock/core";
import { createApp } from "./index.ts";

/**
 * A stand-in for a compiled binary's embedded dist. Inside a real binary the values are `/$bunfs`
 * paths from `scripts/gen-assets.ts`; here they are ordinary files, which exercises the same code.
 */
function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), "flock-assets-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "index-def456.css"), "body{color:red}");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('push', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  return {
    "/index.html": join(dir, "index.html"),
    "/assets/index-abc123.js": join(dir, "assets", "index-abc123.js"),
    "/assets/index-def456.css": join(dir, "assets", "index-def456.css"),
    "/sw.js": join(dir, "sw.js"),
    "/manifest.webmanifest": join(dir, "manifest.webmanifest"),
  };
}

function appWith(opts: { assets?: Record<string, string>; staticDir?: string }) {
  const flock = new Flock(":memory:");
  return createApp({ flock, dbPath: ":memory:", push: false, ...opts });
}

describe("embedded asset map", () => {
  test("serves the shell at / and on any SPA route", async () => {
    const app = appWith({ assets: fakeDist() });
    for (const path of ["/", "/b/assets", "/b/assets/c/1"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>shell</title>");
    }
  });

  test("serves a hashed asset with its content type", async () => {
    const app = appWith({ assets: fakeDist() });
    const js = await app.request("/assets/index-abc123.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("console.log('app')");
    const css = await app.request("/assets/index-def456.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}");
  });

  test("an asset path not in the map falls back to the shell, not a 404 or a disk read", async () => {
    const app = appWith({ assets: fakeDist() });
    const res = await app.request("/assets/does-not-exist.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>shell</title>");
  });

  test("the map wins over staticDir when both are given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>on disk</title>");
    const app = appWith({ assets: fakeDist(), staticDir: dir });
    expect(await (await app.request("/")).text()).toContain("<title>shell</title>");
  });

  test("staticDir still serves when there is no map — the dev path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>on disk</title>");
    const app = appWith({ staticDir: dir });
    expect(await (await app.request("/")).text()).toContain("<title>on disk</title>");
  });

  test("staticDir: /sw.js is carved out of the immutable cache-control too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>on disk</title>");
    writeFileSync(join(dir, "sw.js"), "self.addEventListener('push', () => {});");
    writeFileSync(join(dir, "app.js"), "console.log('app')");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    const app = appWith({ staticDir: dir });
    const sw = await app.request("/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const manifest = await app.request("/manifest.webmanifest");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
    const js = await app.request("/app.js");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("manifest.webmanifest is carved out of the immutable cache-control too — it points at the icons", async () => {
    const app = appWith({ assets: fakeDist() });
    const manifest = await app.request("/manifest.webmanifest");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
  });

  test("an empty map is ignored rather than serving a UI-less 200", async () => {
    const app = appWith({ assets: {} });
    const res = await app.request("/");
    expect(await res.text()).toContain("flock api is up");
  });

  test("the API is unaffected by the map", async () => {
    const app = appWith({ assets: fakeDist() });
    const res = await app.request("/api/boards");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("/sw.js is carved out of the immutable cache-control", async () => {
    const app = appWith({ assets: fakeDist() });
    const sw = await app.request("/sw.js");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    // A hashed asset right next to it keeps the immutable year, so the carve-out is specific.
    const js = await app.request("/assets/index-abc123.js");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

describe("GET /install.sh", () => {
  test("404s when unset", async () => {
    const app = appWith({});
    const res = await app.request("/install.sh");
    expect(res.status).toBe(404);
  });

  test("serves the embedded script when set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-install-"));
    const scriptPath = join(dir, "install.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    const flock = new Flock(":memory:");
    const app = createApp({ flock, dbPath: ":memory:", push: false, installScriptPath: scriptPath });
    const res = await app.request("/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(await res.text()).toContain("echo hi");
  });
});
