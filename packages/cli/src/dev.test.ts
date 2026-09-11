import { describe, expect, test } from "bun:test";
import { FlockError } from "@flock/core";
import { CANONICAL_API_PORT, CANONICAL_WEB_PORT, DEFAULT_HOST, advertisedUrls, baseUrl, planCheckout, portOffset, resolveHost } from "./dev.ts";

describe("portOffset", () => {
  test("is stable for a given path", () => {
    const a = portOffset("/Users/dev/repos/flock-worktree-1");
    const b = portOffset("/Users/dev/repos/flock-worktree-1");
    expect(a).toBe(b);
  });

  test("is always in [0, 100)", () => {
    for (const p of ["/a", "/Users/dev/repos/flock", "/tmp/whatever/deeply/nested/path", ""]) {
      const o = portOffset(p);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(100);
    }
  });

  test("differs across distinct paths (in general)", () => {
    // Not a guarantee for every pair, but true for these two.
    expect(portOffset("/repos/flock-a")).not.toBe(portOffset("/repos/flock-b"));
  });
});

describe("planCheckout — canonical checkout", () => {
  const root = "/Users/dev/repos/flock";

  test("defaults to the canonical ports and empty name", () => {
    const c = planCheckout({ root, canonical: true, env: {}, opts: {} });
    expect(c.root).toBe(root);
    expect(c.canonical).toBe(true);
    expect(c.name).toBe("");
    expect(c.apiPort).toBe(CANONICAL_API_PORT);
    expect(c.webPort).toBe(CANONICAL_WEB_PORT);
    expect(c.db).toBeUndefined();
  });

  test("serving the canonical ports is fine for the canonical checkout", () => {
    const c = planCheckout({ root, canonical: true, env: {}, opts: { port: CANONICAL_API_PORT, webPort: CANONICAL_WEB_PORT } });
    expect(c.apiPort).toBe(CANONICAL_API_PORT);
    expect(c.webPort).toBe(CANONICAL_WEB_PORT);
  });
});

describe("planCheckout — worktree", () => {
  const root = "/Users/dev/repos/flock-feature-x";

  test("defaults to 4800+offset / 5200+offset and a suffixed name", () => {
    const offset = portOffset(root);
    const c = planCheckout({ root, canonical: false, env: {}, opts: {} });
    expect(c.canonical).toBe(false);
    expect(c.name).toBe("flock-feature-x");
    expect(c.apiPort).toBe(4800 + offset);
    expect(c.webPort).toBe(5200 + offset);
  });

  test("env FLOCK_PORT / FLOCK_WEB_PORT override the defaults", () => {
    const c = planCheckout({ root, canonical: false, env: { FLOCK_PORT: "4801", FLOCK_WEB_PORT: "5201" }, opts: {} });
    expect(c.apiPort).toBe(4801);
    expect(c.webPort).toBe(5201);
  });

  test("--port / --web-port options beat env", () => {
    const c = planCheckout({ root, canonical: false, env: { FLOCK_PORT: "4801", FLOCK_WEB_PORT: "5201" }, opts: { port: 4802, webPort: 5202 } });
    expect(c.apiPort).toBe(4802);
    expect(c.webPort).toBe(5202);
  });

  test("refuses the canonical api port via option", () => {
    expect(() => planCheckout({ root, canonical: false, env: {}, opts: { port: CANONICAL_API_PORT } })).toThrow(FlockError);
    try {
      planCheckout({ root, canonical: false, env: {}, opts: { port: CANONICAL_API_PORT } });
    } catch (e) {
      expect((e as FlockError).code).toBe("invalid");
    }
  });

  test("refuses the canonical web port via env", () => {
    expect(() => planCheckout({ root, canonical: false, env: { FLOCK_WEB_PORT: String(CANONICAL_WEB_PORT) }, opts: {} })).toThrow(FlockError);
    try {
      planCheckout({ root, canonical: false, env: { FLOCK_WEB_PORT: String(CANONICAL_WEB_PORT) }, opts: {} });
    } catch (e) {
      expect((e as FlockError).code).toBe("invalid");
    }
  });
});

describe("resolveHost", () => {
  test("defaults to every interface", () => {
    expect(resolveHost(undefined, {}, {})).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe("0.0.0.0");
  });

  test("FLOCK_HOST overrides the default", () => {
    expect(resolveHost(undefined, { FLOCK_HOST: "127.0.0.1" }, {})).toBe("127.0.0.1");
  });

  test("--host wins over FLOCK_HOST", () => {
    expect(resolveHost("192.168.1.5", { FLOCK_HOST: "127.0.0.1" }, {})).toBe("192.168.1.5");
  });

  test("an empty-string FLOCK_HOST is treated as absent", () => {
    expect(resolveHost(undefined, { FLOCK_HOST: "" }, {})).toBe(DEFAULT_HOST);
  });

  test("config host applies when there is no --host or FLOCK_HOST", () => {
    expect(resolveHost(undefined, {}, { host: "10.0.0.5" })).toBe("10.0.0.5");
  });

  test("full precedence: --host > FLOCK_HOST > config host > default", () => {
    expect(resolveHost("a", { FLOCK_HOST: "b" }, { host: "c" })).toBe("a");
    expect(resolveHost(undefined, { FLOCK_HOST: "b" }, { host: "c" })).toBe("b");
    expect(resolveHost(undefined, {}, { host: "c" })).toBe("c");
    expect(resolveHost(undefined, {}, {})).toBe(DEFAULT_HOST);
  });

  test("omitting config reads the real ~/.flock/config.json rather than throwing", () => {
    expect(() => resolveHost(undefined, {})).not.toThrow();
  });
});

describe("advertisedUrls", () => {
  const interfaces = ["10.0.0.5", "my-machine.tailnet.ts.net"];

  test("loopback bind: just the loopback URL, plus a hint kept out of the urls array", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(advertisedUrls(host, 4747, interfaces)).toEqual({ urls: ["http://localhost:4747"], hint: "to reach from other devices: flock up --host 0.0.0.0" });
    }
  });

  test("wildcard bind: loopback first, then every interface, no hint", () => {
    for (const host of ["0.0.0.0", "::", ""]) {
      expect(advertisedUrls(host, 4747, interfaces)).toEqual({ urls: ["http://localhost:4747", "http://10.0.0.5:4747", "http://my-machine.tailnet.ts.net:4747"] });
    }
  });

  test("wildcard bind with no other interfaces: just the loopback URL", () => {
    expect(advertisedUrls("0.0.0.0", 4747, [])).toEqual({ urls: ["http://localhost:4747"] });
  });

  test("a specific non-loopback host: only that host's URL, not the interface list, no hint", () => {
    expect(advertisedUrls("192.168.1.5", 4747, interfaces)).toEqual({ urls: ["http://192.168.1.5:4747"] });
  });

  test("the first entry is always the loopback/localhost base URL the skill uses, except for a specific host", () => {
    expect(advertisedUrls("0.0.0.0", 4747, interfaces).urls[0]).toBe("http://localhost:4747");
    expect(advertisedUrls("127.0.0.1", 4747, interfaces).urls[0]).toBe("http://localhost:4747");
  });

  test("IPv6 addresses are bracketed so the port suffix parses", () => {
    expect(advertisedUrls("fe80::1", 4747, interfaces)).toEqual({ urls: ["http://[fe80::1]:4747"] });
    expect(advertisedUrls("0.0.0.0", 4747, ["fe80::1%en0", "10.0.0.5"])).toEqual({ urls: ["http://localhost:4747", "http://[fe80::1%en0]:4747", "http://10.0.0.5:4747"] });
  });

  test("an already-bracketed host is left alone", () => {
    expect(advertisedUrls("[fe80::1]", 4747, [])).toEqual({ urls: ["http://[fe80::1]:4747"] });
  });

  // ADR 0018: a live tailscale mount's https URL leads urls[], ahead of the http entries above,
  // in every host branch; the loopback-bind hint is dropped once the mount already provides a way
  // to reach the daemon from elsewhere.
  const TS_URL = "https://robs-macbook-pro.tailnet.ts.net";

  test("wildcard bind with a tailscale URL: https first, then loopback, then every interface", () => {
    expect(advertisedUrls("0.0.0.0", 4747, interfaces, TS_URL)).toEqual({
      urls: [TS_URL, "http://localhost:4747", "http://10.0.0.5:4747", "http://my-machine.tailnet.ts.net:4747"],
    });
  });

  test("loopback bind with a tailscale URL: https first, then loopback, no hint", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(advertisedUrls(host, 4747, interfaces, TS_URL)).toEqual({ urls: [TS_URL, "http://localhost:4747"] });
    }
  });

  test("a specific non-loopback host with a tailscale URL: https first, then that host's URL", () => {
    expect(advertisedUrls("192.168.1.5", 4747, interfaces, TS_URL)).toEqual({ urls: [TS_URL, "http://192.168.1.5:4747"] });
  });

  test("without a tailscale URL, every branch is unaffected (the existing expectations above)", () => {
    expect(advertisedUrls("0.0.0.0", 4747, interfaces, undefined)).toEqual(advertisedUrls("0.0.0.0", 4747, interfaces));
  });
});

describe("baseUrl", () => {
  test("matches advertisedUrls' first entry without needing an interface list", () => {
    expect(baseUrl("0.0.0.0", 4747)).toBe("http://localhost:4747");
    expect(baseUrl("127.0.0.1", 4747)).toBe("http://localhost:4747");
    expect(baseUrl("192.168.1.5", 4747)).toBe("http://192.168.1.5:4747");
    expect(baseUrl("::1", 4747)).toBe("http://localhost:4747");
  });

  test("returns the https URL when given one, in every host branch", () => {
    const ts = "https://robs-macbook-pro.tailnet.ts.net";
    expect(baseUrl("0.0.0.0", 4747, ts)).toBe(ts);
    expect(baseUrl("127.0.0.1", 4747, ts)).toBe(ts);
    expect(baseUrl("192.168.1.5", 4747, ts)).toBe(ts);
  });
});

describe("planCheckout — db resolution", () => {
  const root = "/Users/dev/repos/flock-feature-x";

  test("no db option or env leaves db undefined (CLI default)", () => {
    const c = planCheckout({ root, canonical: false, env: {}, opts: {} });
    expect(c.db).toBeUndefined();
  });

  test("--isolated yields <root>/.flock/flock.db", () => {
    const c = planCheckout({ root, canonical: false, env: {}, opts: { isolated: true } });
    expect(c.db).toBe(`${root}/.flock/flock.db`);
  });

  test("env FLOCK_DB is used when no --db is given", () => {
    const c = planCheckout({ root, canonical: false, env: { FLOCK_DB: "/tmp/env.db" }, opts: {} });
    expect(c.db).toBe("/tmp/env.db");
  });

  test("--db wins over env FLOCK_DB", () => {
    const c = planCheckout({ root, canonical: false, env: { FLOCK_DB: "/tmp/env.db" }, opts: { db: "/tmp/opt.db" } });
    expect(c.db).toBe("/tmp/opt.db");
  });

  test("--isolated wins over --db and env", () => {
    const c = planCheckout({ root, canonical: false, env: { FLOCK_DB: "/tmp/env.db" }, opts: { db: "/tmp/opt.db", isolated: true } });
    expect(c.db).toBe(`${root}/.flock/flock.db`);
  });
});
