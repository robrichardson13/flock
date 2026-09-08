import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  LOCK_STALE_MS,
  NO_AUTO_UPDATE_COMMANDS,
  acquireLock,
  compareVersions,
  DEV_LAUNCHER_MARKER,
  configPath,
  devLauncherInTheWay,
  isDevLauncher,
  isNewer,
  latestVersion,
  lockIsStale,
  lockPath,
  maybeSpawnUpdateCheck,
  normalizeVersion,
  readConfig,
  readStamp,
  releaseLock,
  stampIsStale,
  stampPath,
  updateBlockedReason,
  writeStamp,
} from "./update.ts";

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "flock-update-home-"));

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const dirs: string[] = [];
let savedHome: string | undefined;
let savedFlockHome: string | undefined;
let savedNoUpdate: string | undefined;
let savedReleaseBase: string | undefined;

/** A fresh FLOCK_HOME (and HOME) per test: nothing here ever touches the real ~/.flock. */
function useScratchHome(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const home = mkdtempSync(join(SCRATCH_ROOT, "home-"));
  dirs.push(home);
  process.env.HOME = home;
  process.env.FLOCK_HOME = join(home, ".flock");
  return home;
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedFlockHome = process.env.FLOCK_HOME;
  savedNoUpdate = process.env.FLOCK_NO_UPDATE;
  savedReleaseBase = process.env.FLOCK_RELEASE_BASE;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("HOME", savedHome);
  restore("FLOCK_HOME", savedFlockHome);
  restore("FLOCK_NO_UPDATE", savedNoUpdate);
  restore("FLOCK_RELEASE_BASE", savedReleaseBase);
});

// ---------------------------------------------------------------------------- versions

describe("version comparison", () => {
  test("CalVer compares component by component, numerically", () => {
    expect(isNewer("2026.09.08.1", "2026.09.07.9")).toBe(true);
    expect(isNewer("v2026.09.07.10", "2026.09.07.2")).toBe(true);
    expect(isNewer("2026.09.07.2", "2026.09.07.10")).toBe(false);
    expect(isNewer("2026.09.07.1", "2026.09.07.1")).toBe(false);
    expect(isNewer("2026.10.01.1", "2026.9.30.1")).toBe(true);
    expect(compareVersions("2026.09.07", "2026.09.07.0")).toBe(0);
  });

  test("the dev fallback is never newer and is never overtaken", () => {
    // A checkout reports "dev"; nothing is comparable to it, so --if-newer simply no-ops.
    expect(compareVersions("2026.09.07.1", "dev")).toBeUndefined();
    expect(isNewer("2026.09.07.1", "dev")).toBe(false);
    expect(isNewer("dev", "2026.09.07.1")).toBe(false);
    expect(isNewer("not-a-version", "2026.09.07.1")).toBe(false);
  });

  test("normalizeVersion strips the tag's leading v", () => {
    expect(normalizeVersion("v2026.09.07.1")).toBe("2026.09.07.1");
    expect(normalizeVersion("  2026.09.07.1\n")).toBe("2026.09.07.1");
  });

  test("a release base publishes its version in a VERSION file", async () => {
    const dir = mkdtempSync(join(SCRATCH_ROOT_ensured(), "base-"));
    dirs.push(dir);
    expect(await latestVersion({ FLOCK_RELEASE_BASE: dir })).toBeUndefined();
    writeFileSync(join(dir, "VERSION"), "v2026.09.07.3\n");
    expect(await latestVersion({ FLOCK_RELEASE_BASE: dir })).toBe("2026.09.07.3");
    expect(await latestVersion({ FLOCK_RELEASE_BASE: `file://${dir}/` })).toBe("2026.09.07.3");
  });
});

function SCRATCH_ROOT_ensured(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return SCRATCH_ROOT;
}

// ---------------------------------------------------------------------------- the stamp

describe("the stamp", () => {
  test("missing, unparseable and old stamps are all stale; a recent one is not", () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    expect(stampIsStale(undefined, now)).toBe(true);
    expect(stampIsStale({}, now)).toBe(true);
    expect(stampIsStale({ lastCheck: "not a date" }, now)).toBe(true);
    expect(stampIsStale({ lastCheck: new Date(now - CHECK_INTERVAL_MS - 1).toISOString() }, now)).toBe(true);
    expect(stampIsStale({ lastCheck: new Date(now - CHECK_INTERVAL_MS + 1000).toISOString() }, now)).toBe(false);
    expect(stampIsStale({ lastCheck: new Date(now - 60_000).toISOString() }, now)).toBe(false);
  });

  test("a stamp from the future is treated as fresh, not as a reason to check forever", () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    expect(stampIsStale({ lastCheck: new Date(now + 86_400_000).toISOString() }, now)).toBe(false);
  });

  test("writeStamp merges and honours FLOCK_HOME", () => {
    useScratchHome();
    expect(readStamp()).toBeUndefined();
    writeStamp({ lastCheck: "2026-09-07T00:00:00.000Z" });
    writeStamp({ lastSeen: "2026.09.07.1" });
    expect(stampPath().startsWith(process.env.FLOCK_HOME!)).toBe(true);
    expect(readStamp()).toEqual({ lastCheck: "2026-09-07T00:00:00.000Z", lastSeen: "2026.09.07.1" });
  });

  test("junk in update.json reads as no stamp rather than throwing", () => {
    useScratchHome();
    mkdirSync(process.env.FLOCK_HOME!, { recursive: true });
    writeFileSync(stampPath(), "{not json");
    expect(readStamp()).toBeUndefined();
    expect(stampIsStale(readStamp())).toBe(true);
  });
});

// ---------------------------------------------------------------------------- guards

describe("guards", () => {
  test("a checkout never auto-updates", () => {
    expect(updateBlockedReason({ standalone: false, env: {}, config: {} })).toBe("checkout");
  });

  test("FLOCK_NO_UPDATE is honoured, and its off-switches are not", () => {
    expect(updateBlockedReason({ standalone: true, env: { FLOCK_NO_UPDATE: "1" }, config: {} })).toBe("env");
    expect(updateBlockedReason({ standalone: true, env: { FLOCK_NO_UPDATE: "yes" }, config: {} })).toBe("env");
    expect(updateBlockedReason({ standalone: true, env: { FLOCK_NO_UPDATE: "0" }, config: {} })).toBeUndefined();
    expect(updateBlockedReason({ standalone: true, env: { FLOCK_NO_UPDATE: "false" }, config: {} })).toBeUndefined();
    expect(updateBlockedReason({ standalone: true, env: { FLOCK_NO_UPDATE: "" }, config: {} })).toBeUndefined();
    expect(updateBlockedReason({ standalone: true, env: {}, config: {} })).toBeUndefined();
  });

  test('autoupdate: false in ~/.flock/config.json blocks it', () => {
    expect(updateBlockedReason({ standalone: true, env: {}, config: { autoupdate: false } })).toBe("config");
    expect(updateBlockedReason({ standalone: true, env: {}, config: { autoupdate: true } })).toBeUndefined();
  });

  test("readConfig reads only that one key, and treats junk as absent", () => {
    useScratchHome();
    expect(readConfig()).toEqual({});
    mkdirSync(process.env.FLOCK_HOME!, { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ autoupdate: false, somethingElse: 3 }));
    expect(readConfig()).toEqual({ autoupdate: false });
    writeFileSync(configPath(), JSON.stringify({ autoupdate: "no" }));
    expect(readConfig()).toEqual({});
    writeFileSync(configPath(), "[]");
    expect(readConfig()).toEqual({});
    writeFileSync(configPath(), "nope");
    expect(readConfig()).toEqual({});
  });

  test("the passive hook never fires for serve, self-update, upgrade or setup", () => {
    // These four are guarded by name; from a checkout every command is guarded anyway, which is
    // what makes this test safe to run here — no child is ever spawned.
    for (const cmd of ["serve", "self-update", "upgrade", "setup"]) expect(NO_AUTO_UPDATE_COMMANDS.has(cmd)).toBe(true);
    for (const cmd of ["serve", "self-update", "upgrade", "setup", "claim", undefined]) {
      expect(maybeSpawnUpdateCheck(cmd)).toBe(false);
    }
  });

  test("running from a checkout, the passive hook does not even touch the stamp", () => {
    useScratchHome();
    expect(maybeSpawnUpdateCheck("claim")).toBe(false);
    expect(existsSync(stampPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------- the dev launcher

describe("dev launcher detection", () => {
  /** What `scripts/setup.sh --link` writes, verbatim in shape: marker on line 2. */
  function writeLauncher(path: string, checkout = "/checkout/flock"): string {
    writeFileSync(path, `#!/bin/sh\n${DEV_LAUNCHER_MARKER} ${checkout}\n# a comment\nexec bun "${checkout}/packages/cli/src/main.ts" "$@"\n`);
    return path;
  }

  test("recognises a launcher by the marker on line 2", () => {
    const home = useScratchHome();
    expect(isDevLauncher(writeLauncher(join(home, "flock")))).toBe(true);
  });

  test("a release binary, a shell script without the marker, and a missing file are not launchers", () => {
    const home = useScratchHome();
    const binary = join(home, "binary");
    // A real bun binary starts with a Mach-O/ELF header and contains NUL bytes; the point is that
    // reading it must be cheap and must not match.
    writeFileSync(binary, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), Buffer.alloc(4096, 0x41)]));
    expect(isDevLauncher(binary)).toBe(false);

    const script = join(home, "script");
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    expect(isDevLauncher(script)).toBe(false);

    expect(isDevLauncher(join(home, "nope"))).toBe(false);
    expect(isDevLauncher(home)).toBe(false);
  });

  test("the marker only counts on line 2", () => {
    const home = useScratchHome();
    const late = join(home, "late");
    writeFileSync(late, `#!/bin/sh\n# something else\n${DEV_LAUNCHER_MARKER} /checkout\n`);
    expect(isDevLauncher(late)).toBe(false);
  });

  test("devLauncherInTheWay finds the launcher an install would replace, not just the running file", () => {
    const home = useScratchHome();
    const dir = join(home, "bin");
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, "flock-old");
    writeFileSync(binary, "#!/bin/sh\necho not a launcher\n");
    expect(devLauncherInTheWay(binary)).toBeUndefined();

    writeLauncher(join(dir, "flock"));
    expect(devLauncherInTheWay(binary)).toBe(join(dir, "flock"));
    expect(devLauncherInTheWay(join(dir, "flock"))).toBe(join(dir, "flock"));
  });
});

// ---------------------------------------------------------------------------- the lock

describe("the lock", () => {
  test("two updaters at once: the first takes it, the second no-ops", () => {
    useScratchHome();
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(false);
    expect(acquireLock()).toBe(false);
    releaseLock();
    expect(acquireLock()).toBe(true);
  });

  test("releasing a lock nobody holds is not an error", () => {
    useScratchHome();
    releaseLock();
    releaseLock();
    expect(existsSync(lockPath())).toBe(false);
  });

  test("a lock older than ten minutes is stale and is stolen", () => {
    useScratchHome();
    const now = Date.now();
    expect(acquireLock(lockPath(), now - LOCK_STALE_MS - 1000)).toBe(true);
    expect(lockIsStale(lockPath(), now)).toBe(true);
    expect(acquireLock(lockPath(), now)).toBe(true);
    // Freshly stolen: the new holder's timestamp is now, so it is no longer stale.
    expect(lockIsStale(lockPath(), now)).toBe(false);
    expect(acquireLock(lockPath(), now)).toBe(false);
  });

  test("a lock whose pid is gone is stale, however recent", () => {
    useScratchHome();
    mkdirSync(process.env.FLOCK_HOME!, { recursive: true });
    // A pid that cannot exist: kill(pid, 0) fails with ESRCH, so the holder is gone.
    writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }));
    expect(lockIsStale()).toBe(true);
    expect(acquireLock()).toBe(true);
  });

  test("an unreadable lock file is stale rather than a wedge", () => {
    useScratchHome();
    mkdirSync(process.env.FLOCK_HOME!, { recursive: true });
    writeFileSync(lockPath(), "half-writ");
    expect(lockIsStale()).toBe(true);
    expect(acquireLock()).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------- end to end
//
// Compiling two ~60 MB binaries takes a couple of minutes, so this is gated. Run it with:
//
//   FLOCK_E2E=1 bun test packages/cli/src/update.test.ts
//
// It builds v2026.01.01.1 and v2026.01.02.1 with scripts/build-release.ts, installs the older one
// into a scratch FLOCK_INSTALL_DIR from a fake release base (a plain directory, reached over
// file://), then runs that installed binary's `self-update --if-newer` and asserts it replaced
// itself with the newer one and refreshed the skill. HOME, FLOCK_HOME and the install dir all
// point into the scratchpad; the real ~/.flock/bin, ~/.claude/skills and daemon are never touched.

const E2E_ROOT = mkdtempSync(join(tmpdir(), "flock-update-e2e-"));
const OLD_VERSION = "2026.01.01.1";
const NEW_VERSION = "2026.01.02.1";

afterAll(() => {
  rmSync(E2E_ROOT, { recursive: true, force: true });
});

function repoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

async function sh(cmd: string[], o: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe.skipIf(!process.env.FLOCK_E2E)("end to end against a fake release base", () => {
  test(
    "an outdated binary replaces itself and refreshes the skill",
    async () => {
      const target = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
      const oldBase = join(E2E_ROOT, "release", OLD_VERSION);
      const newBase = join(E2E_ROOT, "release", NEW_VERSION);
      const home = join(E2E_ROOT, "home");
      const installDir = join(home, "bin");
      rmSync(home, { recursive: true, force: true });
      mkdirSync(installDir, { recursive: true });

      for (const [v, out] of [
        [OLD_VERSION, oldBase],
        [NEW_VERSION, newBase],
      ] as const) {
        if (!existsSync(join(out, `flock-${target}.tar.gz`))) {
          const built = await sh(["bun", "run", "scripts/build-release.ts", "--version", v, "--targets", target, "--out", out], { cwd: repoRoot() });
          expect(built.code).toBe(0);
        }
        // How --if-newer learns the latest version when FLOCK_RELEASE_BASE bypasses the GitHub redirect.
        writeFileSync(join(out, "VERSION"), `${v}\n`);
      }

      const env = {
        HOME: home,
        FLOCK_HOME: join(home, ".flock"),
        CLAUDE_SKILLS_DIR: join(home, "skills"),
        FLOCK_INSTALL_DIR: installDir,
        FLOCK_NO_SETUP: "1",
      };

      // Install the older release the way a real user would.
      const installed = await sh(["sh", join(repoRoot(), "scripts", "install.sh")], { env: { ...env, FLOCK_RELEASE_BASE: `file://${oldBase}` } });
      expect(installed.code).toBe(0);
      const bin = join(installDir, "flock");
      expect((await sh([bin, "--version"])).stdout).toContain(`flock ${OLD_VERSION}`);

      // A daemon of the *old* binary, on a port nothing else on this machine uses. FLOCK_NO_UPDATE
      // keeps `up`'s own passive hook from racing the update below for the lock.
      const daemonEnv = { ...env, FLOCK_DB: join(home, "e2e.db"), FLOCK_NO_UPDATE: "1" };
      const started = await sh([bin, "up", "--port", "4919", "--json"], { cwd: home, env: daemonEnv });
      expect(JSON.parse(started.stdout).version).toBe(OLD_VERSION);

      // Now let it update itself against the newer one.
      const updated = await sh([bin, "self-update", "--if-newer", "--json"], { env: { ...env, FLOCK_RELEASE_BASE: `file://${newBase}` } });
      expect(updated.code).toBe(0);
      const result = JSON.parse(updated.stdout);
      expect(result.action).toBe("updated");
      expect(result.from).toBe(OLD_VERSION);
      expect(result.to).toBe(NEW_VERSION);

      expect(result.daemonsRestarted).toBe(1);
      expect((await sh([bin, "--version"])).stdout).toContain(`flock ${NEW_VERSION}`);

      // The daemon came back on its own port, running the new binary, and still serving.
      const runfile = JSON.parse(readFileSync(join(home, ".flock", "run", "flock.json"), "utf8"));
      expect(runfile.version).toBe(NEW_VERSION);
      expect(runfile.apiPort).toBe(4919);
      expect((await fetch("http://127.0.0.1:4919/api/boards")).status).toBe(200);
      await sh([bin, "down", "--json"], { cwd: home, env: daemonEnv });
      const skill = JSON.parse(readFileSync(join(home, ".flock", "skill.json"), "utf8"));
      expect(skill.version).toBe(NEW_VERSION);
      expect(existsSync(join(home, "skills", "flock", "SKILL.md"))).toBe(true);
      expect(readStamp(join(home, ".flock", "update.json"))?.lastSeen).toBe(NEW_VERSION);
      expect(existsSync(join(home, ".flock", "update.lock"))).toBe(false);

      // Running it again is a no-op: it is already the newest thing the base publishes.
      const again = await sh([bin, "self-update", "--if-newer", "--json"], { env: { ...env, FLOCK_RELEASE_BASE: `file://${newBase}` } });
      expect(JSON.parse(again.stdout).action).toBe("up-to-date");

      // And the guards hold for the binary too.
      const blocked = await sh([bin, "self-update", "--if-newer", "--json"], { env: { ...env, FLOCK_NO_UPDATE: "1", FLOCK_RELEASE_BASE: `file://${newBase}` } });
      expect(JSON.parse(blocked.stdout)).toMatchObject({ action: "blocked", reason: "env" });
    },
    600_000,
  );
});
