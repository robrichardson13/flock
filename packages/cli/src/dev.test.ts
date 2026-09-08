import { describe, expect, test } from "bun:test";
import { FlockError } from "@flock/core";
import { CANONICAL_API_PORT, CANONICAL_WEB_PORT, planCheckout, portOffset } from "./dev.ts";

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
