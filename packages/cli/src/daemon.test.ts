import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCheckout, portOffset, CANONICAL_API_PORT, CANONICAL_WEB_PORT } from "./dev.ts";
import { canonicalFallbackPlan, checkoutRunfileName, isAlive, listRunfiles, parseRunInfo, planDaemon, portFree, portHeldByOther, portsOf, readRunfile, runfilePath, settingsDiffer, type DaemonPlan, type RunInfo } from "./daemon.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "flock-run-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const runfile = (over: Partial<RunInfo> = {}): RunInfo => ({
  name: "flock",
  pid: process.pid,
  mode: "binary",
  apiPort: 4747,
  host: "127.0.0.1",
  root: "/tmp/x",
  db: "/tmp/x/flock.db",
  startedAt: "2026-09-07T00:00:00.000Z",
  url: "http://localhost:4747",
  ...over,
});

describe("parseRunInfo", () => {
  test("round-trips a written runfile", () => {
    const info = runfile({ webPid: 42, mode: "checkout", webPort: 5173 });
    expect(parseRunInfo(JSON.stringify(info))).toEqual(info);
  });

  test("rejects junk, arrays, and anything without a pid, name or port", () => {
    for (const bad of ["", "not json", "[]", "null", '"hi"', "{}", '{"pid":1}', '{"name":"flock"}', '{"name":"flock","pid":0,"apiPort":4747}', '{"name":"flock","pid":1.5,"apiPort":4747}', '{"name":"flock","pid":1}']) {
      expect(parseRunInfo(bad)).toBeUndefined();
    }
  });

  test("fills in defaults for the soft fields and normalizes an unknown mode", () => {
    const i = parseRunInfo('{"name":"w","pid":7,"apiPort":4801,"mode":"nonsense"}');
    expect(i?.mode).toBe("binary");
    expect(i?.host).toBe("127.0.0.1");
    expect(i?.url).toBe("http://localhost:4801");
    expect(i?.version).toBeUndefined();
  });
});

describe("isAlive", () => {
  test("true for this process, false for a pid that cannot exist", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0x7ffffff)).toBe(false);
  });
});

describe("readRunfile / listRunfiles pruning", () => {
  test("reads a live runfile", () => {
    const dir = scratch();
    writeFileSync(runfilePath("flock", dir), JSON.stringify(runfile()));
    expect(readRunfile("flock", dir)?.pid).toBe(process.pid);
  });

  test("prunes a runfile whose process is gone", () => {
    const dir = scratch();
    const file = runfilePath("dead", dir);
    writeFileSync(file, JSON.stringify(runfile({ name: "dead", pid: 0x7ffffff })));
    expect(readRunfile("dead", dir)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("prunes an unparseable runfile", () => {
    const dir = scratch();
    const file = runfilePath("junk", dir);
    writeFileSync(file, "{ not json");
    expect(readRunfile("junk", dir)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("missing runfile and missing directory are just 'not running'", () => {
    const dir = scratch();
    expect(readRunfile("nope", dir)).toBeUndefined();
    expect(listRunfiles(join(dir, "absent"))).toEqual([]);
  });

  test("listRunfiles returns the live ones, sorted, and prunes the dead", () => {
    const dir = scratch();
    writeFileSync(runfilePath("flock", dir), JSON.stringify(runfile()));
    writeFileSync(runfilePath("wt-b", dir), JSON.stringify(runfile({ name: "wt-b" })));
    writeFileSync(runfilePath("gone", dir), JSON.stringify(runfile({ name: "gone", pid: 0x7ffffff })));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(listRunfiles(dir).map((i) => i.name)).toEqual(["flock", "wt-b"]);
    expect(readdirSync(dir).sort()).toEqual(["flock.json", "notes.txt", "wt-b.json"]);
  });
});

describe("planDaemon — installed binary", () => {
  const base = { mode: "binary" as const, serveCmd: ["/home/me/.flock/bin/flock"], cwd: "/home/me/work", db: "/home/me/.flock/flock.db", env: {} };

  test("one serve child on :4747, named flock", () => {
    const p = planDaemon({ ...base, opts: {} });
    expect(p.name).toBe("flock");
    expect(p.apiPort).toBe(4747);
    expect(p.webPort).toBeUndefined();
    expect(p.url).toBe("http://127.0.0.1:4747");
    expect(p.children).toHaveLength(1);
    expect(p.children[0]).toMatchObject({ key: "api", cmd: ["/home/me/.flock/bin/flock", "serve", "--port", "4747", "--host", "127.0.0.1"], cwd: "/home/me/work" });
  });

  test("--port and --host win over FLOCK_PORT", () => {
    const p = planDaemon({ ...base, env: { FLOCK_PORT: "4900" }, opts: { port: 4999, host: "0.0.0.0" } });
    expect(p.apiPort).toBe(4999);
    expect(p.children[0].cmd).toContain("0.0.0.0");
    expect(p.url).toBe("http://localhost:4999");
  });

  test("FLOCK_PORT moves the daemon when no flag is given", () => {
    expect(planDaemon({ ...base, env: { FLOCK_PORT: "4900" }, opts: {} }).apiPort).toBe(4900);
  });
});

describe("planDaemon — checkout", () => {
  const root = "/Users/dev/repos/flock";
  const plan = (opts: Parameters<typeof planCheckout>[0]["opts"], canonical = true, r = root) =>
    planDaemon({
      mode: "checkout",
      serveCmd: ["/opt/bun/bin/bun", join(root, "packages/cli/src/main.ts")],
      bun: "/opt/bun/bin/bun",
      cwd: r,
      db: "/Users/dev/.flock/flock.db",
      checkout: planCheckout({ root: r, canonical, env: {}, opts }),
      opts,
      env: {},
    });

  test("canonical checkout: bun --watch serve on :4747 and vite on :5173, named dev", () => {
    const p = plan({});
    expect(p.name).toBe("dev");
    expect(p.apiPort).toBe(CANONICAL_API_PORT);
    expect(p.webPort).toBe(CANONICAL_WEB_PORT);
    expect(p.url).toBe(`http://localhost:${CANONICAL_WEB_PORT}`);
    expect(p.children.map((c) => c.key)).toEqual(["api", "web"]);
    expect(p.children[0].cmd).toEqual(["/opt/bun/bin/bun", "--watch", join(root, "packages/cli/src/main.ts"), "serve", "--port", "4747", "--host", "127.0.0.1"]);
    expect(p.children[0].cwd).toBe(root);
    expect(p.children[1].cmd).toEqual(["/opt/bun/bin/bun", "x", "vite", "--port", "5173", "--strictPort"]);
    expect(p.children[1].cwd).toBe(join(root, "packages/web"));
  });

  test("a worktree gets its ADR 0003 ports and its directory name, so runfiles do not collide", () => {
    const wt = "/Users/dev/repos/flock-feature-x";
    const p = plan({}, false, wt);
    expect(p.name).toBe("dev@flock-feature-x");
    expect(p.apiPort).toBe(4800 + portOffset(wt));
    expect(p.webPort).toBe(5200 + portOffset(wt));
  });

  test("a worktree still refuses the canonical ports", () => {
    expect(() => plan({ port: CANONICAL_API_PORT }, false, "/Users/dev/repos/flock-feature-x")).toThrow(/Refusing to serve the canonical ports/);
    expect(() => plan({ webPort: CANONICAL_WEB_PORT }, false, "/Users/dev/repos/flock-feature-x")).toThrow(/Refusing to serve the canonical ports/);
  });

  test("--isolated points both children at the checkout's own database", () => {
    const p = plan({ isolated: true });
    for (const c of p.children) expect(c.env.FLOCK_DB).toBe(join(root, ".flock", "flock.db"));
  });

  test("without --isolated FLOCK_DB is unset rather than inherited", () => {
    for (const c of plan({}).children) expect(c.env.FLOCK_DB).toBeUndefined();
  });
});

describe("runfile namespaces", () => {
  test("an installed daemon and a checkout never share a runfile name", () => {
    const binary = planDaemon({ mode: "binary", serveCmd: ["/bin/flock"], cwd: "/w", db: "/db.sqlite", env: {}, opts: {} });
    const canonical = planDaemon({
      mode: "checkout",
      serveCmd: ["/bin/bun", "/repo/packages/cli/src/main.ts"],
      cwd: "/repo",
      db: "/db.sqlite",
      checkout: planCheckout({ root: "/repo", canonical: true, env: {}, opts: {} }),
      opts: {},
      env: {},
    });
    expect(binary.name).toBe("flock");
    expect(canonical.name).toBe("dev");
    expect(binary.name).not.toBe(canonical.name);
  });

  test("worktrees keep their per-checkout name, under the checkout namespace", () => {
    expect(checkoutRunfileName("")).toBe("dev");
    expect(checkoutRunfileName("flock-feature-x")).toBe("dev@flock-feature-x");
    expect(checkoutRunfileName("a")).not.toBe(checkoutRunfileName("b"));
  });
});

describe("port guard", () => {
  const planWith = (over: Partial<DaemonPlan>): DaemonPlan => ({
    name: "dev",
    mode: "checkout",
    apiPort: 4747,
    webPort: 5173,
    host: "127.0.0.1",
    root: "/repo",
    db: "/db.sqlite",
    url: "http://localhost:5173",
    canonical: true,
    children: [],
    ...over,
  });

  test("portsOf covers both children in checkout mode and just the api port otherwise", () => {
    expect(portsOf({ apiPort: 4747, webPort: 5173 })).toEqual([4747, 5173]);
    expect(portsOf({ apiPort: 4747 })).toEqual([4747]);
  });

  test("a port held by a different runfile is refused, naming that daemon", () => {
    const other = runfile({ name: "flock", mode: "binary", apiPort: 4747, root: "/home/me" });
    const msg = portHeldByOther(planWith({}), [other]);
    expect(msg).toContain("Port 4747");
    expect(msg).toContain("installed daemon");
    expect(msg).toContain("/home/me");
  });

  test("the web port collides too, and the other daemon's name is quoted", () => {
    const other = runfile({ name: "dev@wt", mode: "checkout", apiPort: 4801, webPort: 5173 });
    expect(portHeldByOther(planWith({}), [other])).toContain('"dev@wt"');
  });

  test("our own runfile's ports are ours to retake, and an unrelated daemon is no conflict", () => {
    const mine = runfile({ name: "dev", mode: "checkout", apiPort: 4747, webPort: 5173 });
    expect(portHeldByOther(planWith({}), [mine], [4747, 5173])).toBeUndefined();
    expect(portHeldByOther(planWith({}), [runfile({ name: "flock", apiPort: 4999 })])).toBeUndefined();
  });

  test("portFree is false while something is listening and true once it stops", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = s.port ?? 0;
    expect(portFree(port, "127.0.0.1")).toBe(false);
    await s.stop(true);
    expect(portFree(port, "127.0.0.1")).toBe(true);
  });
});

describe("canonical port fallback", () => {
  const root = "/Users/dev/repos/flock";
  const canonical = planCheckout({ root, canonical: true, env: {}, opts: {} });
  const offset = portOffset(root);
  const fallbackApi = 4800 + offset;
  const fallbackWeb = 5200 + offset;
  const alwaysFree = () => true;

  test("free ports: canonical checkout keeps :4747/:5173, no note", () => {
    const r = canonicalFallbackPlan(canonical, {}, {}, [], alwaysFree);
    expect(r.checkout.apiPort).toBe(CANONICAL_API_PORT);
    expect(r.checkout.webPort).toBe(CANONICAL_WEB_PORT);
    expect(r.note).toBeUndefined();
  });

  test("held by the installed binary's runfile: falls back to the ADR 0003 offset ports", () => {
    const installed = runfile({ name: "flock", mode: "binary", apiPort: CANONICAL_API_PORT, root: "/home/me" });
    const r = canonicalFallbackPlan(canonical, {}, {}, [installed], alwaysFree);
    expect(r.checkout.apiPort).toBe(fallbackApi);
    expect(r.checkout.webPort).toBe(fallbackWeb);
    expect(r.note).toContain(`:${CANONICAL_API_PORT}`);
    expect(r.note).toContain(`:${fallbackApi}`);
  });

  test("held by an unidentified listener (no runfile at all): still falls back", () => {
    const neverFree = () => false;
    const r = canonicalFallbackPlan(canonical, {}, {}, [], neverFree);
    expect(r.checkout.apiPort).toBe(fallbackApi);
    expect(r.checkout.webPort).toBe(fallbackWeb);
  });

  test("held by our own runfile: retaken, not a fallback", () => {
    const mine = runfile({ name: "dev", mode: "checkout", apiPort: CANONICAL_API_PORT, webPort: CANONICAL_WEB_PORT, root });
    // Nothing else is free (as if the ports are bound), but they're bound by us.
    const r = canonicalFallbackPlan(canonical, {}, {}, [mine], () => false);
    expect(r.checkout.apiPort).toBe(CANONICAL_API_PORT);
    expect(r.checkout.webPort).toBe(CANONICAL_WEB_PORT);
    expect(r.note).toBeUndefined();
  });

  test("an explicit --port wins: no fallback even though the port is held", () => {
    const installed = runfile({ name: "flock", mode: "binary", apiPort: CANONICAL_API_PORT, root: "/home/me" });
    const r = canonicalFallbackPlan(canonical, { port: CANONICAL_API_PORT }, {}, [installed], alwaysFree);
    expect(r.checkout.apiPort).toBe(CANONICAL_API_PORT);
    expect(r.note).toBeUndefined();
  });

  test("an explicit FLOCK_PORT wins too", () => {
    const installed = runfile({ name: "flock", mode: "binary", apiPort: CANONICAL_API_PORT, root: "/home/me" });
    const r = canonicalFallbackPlan(canonical, {}, { FLOCK_PORT: String(CANONICAL_API_PORT) }, [installed], alwaysFree);
    expect(r.checkout.apiPort).toBe(CANONICAL_API_PORT);
    expect(r.note).toBeUndefined();
  });

  test("a worktree is untouched: never falls back, keeps its own ports", () => {
    const wt = planCheckout({ root: "/Users/dev/repos/flock-feature-x", canonical: false, env: {}, opts: {} });
    const other = runfile({ name: "flock", mode: "binary", apiPort: wt.apiPort, root: "/home/me" });
    const r = canonicalFallbackPlan(wt, {}, {}, [other], () => false);
    expect(r.checkout).toEqual(wt);
    expect(r.note).toBeUndefined();
  });
});

describe("settingsDiffer", () => {
  const p = planDaemon({ mode: "binary", serveCmd: ["/bin/flock"], cwd: "/w", db: "/db/flock.db", env: {}, opts: {} });
  const live = runfile({ apiPort: p.apiPort, host: p.host, db: p.db, mode: "binary", webPort: undefined });

  test("same settings: already running", () => {
    expect(settingsDiffer(live, p)).toBe(false);
  });

  test("a different port, host, database or mode is a restart", () => {
    expect(settingsDiffer({ ...live, apiPort: 4800 }, p)).toBe(true);
    expect(settingsDiffer({ ...live, host: "0.0.0.0" }, p)).toBe(true);
    expect(settingsDiffer({ ...live, db: "/other.db" }, p)).toBe(true);
    expect(settingsDiffer({ ...live, mode: "checkout", webPort: 5173 }, p)).toBe(true);
  });

  test("pid, url and startedAt are not settings", () => {
    expect(settingsDiffer({ ...live, pid: 1, url: "http://elsewhere", startedAt: "then" }, p)).toBe(false);
  });
});

/**
 * The real thing: spawn `flock up` from a directory outside any checkout (so it takes the
 * installed-binary path: one detached `serve` child), then `status` from a third directory, then
 * `down`. Everything is redirected into a scratch FLOCK_HOME and onto a free port, so it never
 * touches ~/.flock or the canonical :4747/:5173.
 */
describe("up / status / down, for real", () => {
  const cli = join(import.meta.dir, "main.ts");

  async function freePort(): Promise<number> {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const p = s.port ?? 0;
    await s.stop(true);
    return p;
  }

  const run = async (cwd: string, env: Record<string, string>, args: string[]) => {
    const proc = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  };

  test(
    "starts detached, is idempotent, is visible from elsewhere, and stops",
    async () => {
      const home = scratch();
      const work = scratch();
      const elsewhere = scratch();
      const port = await freePort();
      const env = { FLOCK_HOME: home, FLOCK_DB: join(home, "flock.db"), FLOCK_PORT: "", FLOCK_WEB_PORT: "" };
      let pid = 0;
      try {
        const started = await run(work, env, ["up", "--port", String(port), "--json"]);
        expect(started.code).toBe(0);
        const info = JSON.parse(started.out) as RunInfo & { action: string };
        expect(info.action).toBe("started");
        expect(info.mode).toBe("binary");
        expect(info.apiPort).toBe(port);
        pid = info.pid;
        expect(isAlive(pid)).toBe(true);
        expect(existsSync(join(home, "run", "flock.json"))).toBe(true);
        expect(existsSync(join(home, "logs", "flock.log"))).toBe(true);

        // It is actually serving, and it outlived the `up` process that spawned it.
        const res = await fetch(`http://127.0.0.1:${port}/api/boards`);
        expect(res.ok).toBe(true);

        const again = await run(work, env, ["up", "--port", String(port), "--json"]);
        expect(JSON.parse(again.out).action).toBe("already running");
        expect(JSON.parse(again.out).pid).toBe(pid);

        const status = await run(elsewhere, env, ["status", "--json"]);
        const seen = JSON.parse(status.out) as { here: RunInfo | null; others: RunInfo[]; binary: { execPath: string; standalone: boolean; version: string } };
        expect([...(seen.here ? [seen.here] : []), ...seen.others].map((i) => i.pid)).toContain(pid);
        // Card 16: status names which binary answered, without disturbing the existing fields.
        expect(seen.binary.execPath).toBe(process.execPath);
        expect(seen.binary.standalone).toBe(false);
        expect(seen.binary.version).toBe("dev");

        const statusText = await run(elsewhere, env, ["status"]);
        expect(statusText.out).toContain("Binary:");
        expect(statusText.out).toContain(process.execPath);
        expect(statusText.out).toContain('version() returns "dev"');

        const stopped = await run(elsewhere, env, ["down", "--all", "--json"]);
        expect(JSON.parse(stopped.out).stopped).toContain("flock");
        expect(existsSync(join(home, "run", "flock.json"))).toBe(false);
        expect(isAlive(pid)).toBe(false);
        pid = 0;
      } finally {
        if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
      }
    },
    60_000,
  );

  test(
    "refuses, rather than kills, when the port is already taken by something else",
    async () => {
      const home = scratch();
      const work = scratch();
      const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not flock") });
      const port = squatter.port ?? 0;
      try {
        const res = await run(work, { FLOCK_HOME: home, FLOCK_DB: join(home, "flock.db"), FLOCK_PORT: "", FLOCK_WEB_PORT: "" }, ["up", "--port", String(port)]);
        expect(res.code).toBe(1);
        expect(res.err).toContain(`Port ${port} is already in use`);
        // Nothing was started, and the squatter is untouched.
        expect(existsSync(join(home, "run", "flock.json"))).toBe(false);
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
      } finally {
        await squatter.stop(true);
      }
    },
    30_000,
  );
});
