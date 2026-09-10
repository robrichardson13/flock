/**
 * Auto-update. See ADR 0012's "Auto-update" section (card G).
 *
 * The shape of it:
 *
 *  - **State** is `~/.flock/update.json` (`{lastCheck, lastSeen, lastUpdate}`) and a mutex at
 *    `~/.flock/update.lock`, created `O_EXCL` and considered stale after ten minutes. Both honour
 *    `FLOCK_HOME`.
 *  - **The passive trigger** runs after any CLI command has finished and written its output: if the
 *    stamp is older than 24 h it spawns a detached `flock self-update --if-newer` and returns. It
 *    does no network I/O, changes no exit code, and costs three `stat`s at most — in a checkout it
 *    costs one function call, because `isStandalone()` is the first thing it asks.
 *  - **The daemon trigger** is the same spawn on a timer: 60 s after `serve` starts, jittered by up
 *    to ten minutes so a fleet does not stampede GitHub, and every 6 h after that.
 *  - **The update itself** is not a bespoke self-replace. It writes the embedded `install.sh` to a
 *    temp file and runs it with `FLOCK_INSTALL_DIR` set to the directory the running binary lives
 *    in and `FLOCK_NO_SETUP=1` — the same platform detection, checksum verification and atomic `mv`
 *    the first install used. Then it runs the *new* binary's `setup --skill-only` to refresh the
 *    Claude Code skill, and, if an installed daemon is live, the new binary's `restart`.
 *
 * Guards, in the order they are cheapest to ask: not a checkout (`isStandalone()`), no
 * `FLOCK_NO_UPDATE=1`, no `{"autoupdate": false}` in `~/.flock/config.json`. They gate the
 * automatic path only; `flock upgrade` is a deliberate act and ignores them. One refusal is not a
 * guard and binds both paths: a dev checkout's launcher (`scripts/setup.sh --link`) at the
 * destination is never overwritten — see `isDevLauncher`.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FlockError } from "@flock/core";
import { flockHome } from "./paths.ts";
import { installScriptPath, isStandalone, version } from "./runtime.ts";

/**
 * The repo the GitHub redirect resolves `latest` against. `scripts/install.sh` and
 * `scripts/build-release.ts` each carry their own copy of the same value — keep them in sync.
 */
export const REPO = "robrichardson13/flock";

/** How old the stamp has to be before a CLI invocation spawns a check. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A lock older than this belonged to an updater that died without releasing it. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
/** The daemon's first check, and the jitter added to it so a fleet does not check in lockstep. */
export const DAEMON_FIRST_CHECK_MS = 60 * 1000;
export const DAEMON_JITTER_MS = 10 * 60 * 1000;
export const DAEMON_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Commands that must never trigger the passive check. `serve` blocks forever so it would never
 * reach the hook anyway; `self-update`/`upgrade` are the check; `setup` is what `install.sh` runs
 * one second after installing the newest binary there is.
 */
export const NO_AUTO_UPDATE_COMMANDS = new Set(["serve", "self-update", "upgrade", "setup"]);

export const stampPath = () => join(flockHome(), "update.json");
export const lockPath = () => join(flockHome(), "update.lock");
export const configPath = () => join(flockHome(), "config.json");
export const updateLogPath = () => join(flockHome(), "logs", "update.log");

// ---------------------------------------------------------------------------- versions

/** `v2026.09.07.2` and `2026.09.07.2` are the same version; `dev` is not a version at all. */
function numericParts(v: string): number[] | undefined {
  const s = v.trim().replace(/^v/, "");
  if (!/^\d+(\.\d+)*$/.test(s)) return undefined;
  return s.split(".").map(Number);
}

/** Strip a leading `v`, since the installer's `FLOCK_VERSION` does the same. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

/**
 * CalVer `vYYYY.MM.DD.n` compared component by component as integers, so `.2` < `.10`. `undefined`
 * when either side is not a version — which is how `dev` (a checkout, or an uncompiled binary)
 * falls out: nothing is ever "newer than dev", so `--if-newer` no-ops rather than guessing.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = numericParts(a);
  const pb = numericParts(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/**
 * The latest published version, without an API call.
 *
 * GitHub redirects `/releases/latest` to `/releases/tag/<tag>`, which is the same trick
 * `install.sh` uses for `/releases/latest/download/<asset>`: a redirect costs nothing against the
 * unauthenticated rate limit. When `FLOCK_RELEASE_BASE` points somewhere else — a mirror, or a
 * test's fake release directory — there is no redirect to read, so the base may publish a
 * plain-text `VERSION` file next to the assets instead. Neither available means `undefined`, and
 * an automatic check simply does nothing this time.
 */
export async function latestVersion(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const base = env.FLOCK_RELEASE_BASE;
  if (base) return readVersionFile(base.replace(/\/+$/, ""));
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
    const loc = res.headers.get("location");
    const m = loc?.match(/\/releases\/tag\/([^/?#]+)/);
    return m ? normalizeVersion(decodeURIComponent(m[1])) : undefined;
  } catch {
    return undefined;
  }
}

async function readVersionFile(base: string): Promise<string | undefined> {
  try {
    let text: string;
    if (base.startsWith("http://") || base.startsWith("https://")) {
      const res = await fetch(`${base}/VERSION`);
      if (!res.ok) return undefined;
      text = await res.text();
    } else {
      const dir = base.startsWith("file://") ? fileURLToPath(base) : base;
      text = readFileSync(join(dir, "VERSION"), "utf8");
    }
    const first = text.split("\n")[0].trim();
    return first ? normalizeVersion(first) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------- the stamp

export interface UpdateStamp {
  /** ISO timestamp of the last time a check was *started*. Freshness is measured from this. */
  lastCheck?: string;
  /** The newest version the last check saw, whether or not it was installed. */
  lastSeen?: string;
  /** ISO timestamp of the last successful update. */
  lastUpdate?: string;
}

export function readStamp(file = stampPath()): UpdateStamp | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw as UpdateStamp;
  } catch {
    return undefined;
  }
}

/** Merge `patch` into whatever is on disk and write it atomically. Returns the merged stamp. */
export function writeStamp(patch: UpdateStamp, file = stampPath()): UpdateStamp {
  const next = { ...readStamp(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}

/** No stamp, or an unreadable/missing/older-than-`maxAgeMs` `lastCheck`, all mean "check again". */
export function stampIsStale(stamp: UpdateStamp | undefined, now = Date.now(), maxAgeMs = CHECK_INTERVAL_MS): boolean {
  if (!stamp?.lastCheck) return true;
  const at = Date.parse(stamp.lastCheck);
  if (Number.isNaN(at)) return true;
  // A stamp from the future is a clock that moved; treat it as fresh rather than checking forever.
  return now - at >= maxAgeMs;
}

// ---------------------------------------------------------------------------- config and guards

/**
 * `~/.flock/config.json`. Unknown keys are ignored, junk is treated as absent.
 * `host` (ADR 0015): the bind host `flock serve`/`flock up` fall back to when there is no
 * `--host` and no `FLOCK_HOST` — below `FLOCK_HOST` and above the built-in `0.0.0.0` default in
 * `resolveHost` (dev.ts). See `docs/config.md`.
 */
export interface FlockConfig {
  autoupdate?: boolean;
  host?: string;
}

export function readConfig(file = configPath()): FlockConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const o = raw as Record<string, unknown>;
    const config: FlockConfig = {};
    if (typeof o.autoupdate === "boolean") config.autoupdate = o.autoupdate;
    if (typeof o.host === "string" && o.host) config.host = o.host;
    return config;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------- the dev launcher

/**
 * The marker `scripts/setup.sh --link` writes on line 2 of the launcher it installs at
 * `~/.flock/bin/flock`, followed by the checkout's absolute path. `scripts/install.sh` looks for
 * the same string; keep the two in step.
 */
export const DEV_LAUNCHER_MARKER = "# flock-dev-launcher:";

/**
 * Is this file a dev checkout's launcher rather than a release binary?
 *
 * Dev wins over prod: a contributor who ran `scripts/setup.sh --link` has deliberately pointed the
 * global `flock` at their source tree, and neither the installer nor an update may quietly undo
 * that. Reads 512 bytes, not the file — the alternative is a 60 MB binary on every check.
 */
export function isDevLauncher(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString("utf8").split("\n")[1];
    return line !== undefined && line.startsWith(DEV_LAUNCHER_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/**
 * The launcher an update would run over, if there is one: the running executable, what it resolves
 * to through symlinks, and the `flock` an install into its directory would replace.
 */
export function devLauncherInTheWay(execPath: string): string | undefined {
  const candidates = [execPath];
  try {
    candidates.push(realpathSync(execPath));
  } catch {}
  candidates.push(join(dirname(execPath), "flock"));
  return candidates.find((p) => isDevLauncher(p));
}

export type BlockReason = "checkout" | "env" | "config" | "launcher";

/** Pure: why the automatic path must not run, or `undefined` if it may. */
export function updateBlockedReason(o: { standalone: boolean; env?: Record<string, string | undefined>; config?: FlockConfig }): BlockReason | undefined {
  if (!o.standalone) return "checkout";
  const flag = (o.env ?? {}).FLOCK_NO_UPDATE;
  if (flag !== undefined && flag !== "" && !["0", "false", "no"].includes(flag.toLowerCase())) return "env";
  if (o.config?.autoupdate === false) return "config";
  return undefined;
}

/** The live version of the same question, reading `isStandalone()` and the config file. */
export function autoUpdateBlocked(env: Record<string, string | undefined> = process.env): BlockReason | undefined {
  if (!isStandalone()) return "checkout";
  return updateBlockedReason({ standalone: true, env, config: readConfig() });
}

// ---------------------------------------------------------------------------- the lock

export interface LockInfo {
  pid: number;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `O_EXCL` create, so two updaters racing each other resolve without a filesystem lock API: the
 * loser sees EEXIST and no-ops. A lock older than ten minutes, or one whose pid is gone, is stolen
 * — a killed updater must not wedge every future check.
 */
export function acquireLock(file = lockPath(), now = Date.now(), staleMs = LOCK_STALE_MS): boolean {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() } satisfies LockInfo));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (attempt > 0 || !lockIsStale(file, now, staleMs)) return false;
      try {
        unlinkSync(file);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function lockIsStale(file = lockPath(), now = Date.now(), staleMs = LOCK_STALE_MS): boolean {
  let info: LockInfo | undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && typeof (raw as LockInfo).pid === "number") info = raw as LockInfo;
  } catch {
    return true; // unreadable or unparseable: nobody can be relying on it
  }
  if (!info) return true;
  const at = Date.parse(info.at ?? "");
  if (Number.isNaN(at) || now - at >= staleMs) return true;
  return !pidAlive(info.pid);
}

export function releaseLock(file = lockPath()): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone, or stolen as stale: either way there is nothing to release
  }
}

// ---------------------------------------------------------------------------- logging

/** Append one line to `~/.flock/logs/update.log`. Never throws: logging must not fail an update. */
export function logUpdate(line: string, file = updateLogPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------- running an update

export type UpdateAction = "blocked" | "locked" | "up-to-date" | "unknown-latest" | "updated";

export interface UpdateResult {
  action: UpdateAction;
  /** The version that was running when the check started. */
  from: string;
  /** The version that was installed, or the latest one seen. */
  to?: string;
  reason?: BlockReason;
  daemonsRestarted?: number;
}

export interface UpdateOptions {
  /** A tag to install, with or without the leading `v`. Omitted means whatever is latest. */
  version?: string;
  /** The automatic path: honour the guards, and do nothing unless the latest is genuinely newer. */
  ifNewer?: boolean;
  json?: boolean;
  // Injected for tests; all default to the live values.
  standalone?: boolean;
  execPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** Run a command to completion, capturing its output into the update log. Returns the exit code. */
async function runLogged(cmd: string[], env: Record<string, string | undefined>, label: string): Promise<number> {
  const proc = Bun.spawn(cmd, { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  for (const line of `${out}${err}`.split("\n")) if (line.trim()) logUpdate(`${label}: ${line.trim()}`);
  return code;
}

/**
 * Write the embedded `install.sh` somewhere a shell can actually read it and run it.
 *
 * Inside a compiled binary `installScriptPath` points into the virtual `/$bunfs` filesystem, which
 * this process can read but `sh` cannot see at all — so the copy is mandatory, not a convenience.
 * A fresh 0700 directory rather than a predictable name in a shared `/tmp`: anyone who could create
 * that path first would be choosing the script this runs as the user.
 */
async function runInstaller(o: { dir: string; version?: string; env: Record<string, string | undefined> }): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "flock-update-"));
  const script = join(scratch, "install.sh");
  writeFileSync(script, readFileSync(installScriptPath, "utf8"));
  const env: Record<string, string | undefined> = { ...o.env, FLOCK_INSTALL_DIR: o.dir, FLOCK_NO_SETUP: "1" };
  if (o.version) env.FLOCK_VERSION = o.version;
  else delete env.FLOCK_VERSION;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  try {
    logUpdate(`installer: sh ${script} -> ${o.dir}${o.version ? ` (${o.version})` : " (latest)"}`);
    const code = await runLogged(["sh", script], env, "installer");
    if (code !== 0) throw new FlockError(`Installer exited ${code}; flock was not upgraded. See ${updateLogPath()}`, "invalid");
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Restart any *installed* daemon (mode `binary`) with the binary that was just written. Checkout
 * daemons are somebody's dev environment and are none of an updater's business.
 */
async function restartDaemons(bin: string, env: Record<string, string | undefined>): Promise<number> {
  const { listRunfiles } = await import("./daemon.ts");
  const targets = listRunfiles().filter((i) => i.mode === "binary");
  for (const i of targets) {
    logUpdate(`restarting daemon "${i.name}" (pid ${i.pid}) with ${bin}`);
    // The runfile's own settings, explicitly: `restart` would otherwise re-plan from the cwd and
    // the environment, and a daemon started on a non-default port would come back on 4747 —
    // someone else's port, on a machine that may well have something there already.
    const cmd = [bin, "restart", "--json", "--port", String(i.apiPort), "--host", i.host];
    if (i.db) cmd.push("--db", i.db);
    const proc = Bun.spawn(cmd, { cwd: existsSync(i.root) ? i.root : undefined, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    for (const line of `${out}${err}`.split("\n")) if (line.trim()) logUpdate(`restart: ${line.trim()}`);
    if (code !== 0) logUpdate(`restart of "${i.name}" exited ${code}`);
  }
  return targets.length;
}

/**
 * One code path behind both `flock upgrade` and `flock self-update`. `ifNewer` is what separates
 * them: it applies the guards and resolves the latest version first, where a manual upgrade just
 * re-runs the installer.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const standalone = opts.standalone ?? isStandalone();
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const from = version();

  // Before anything else, and before anything is replaced: a dev launcher at the destination is
  // somebody's deliberate choice, and an update is not allowed to overwrite it.
  const launcher = devLauncherInTheWay(execPath);
  if (launcher) {
    logUpdate(`skipped: dev launcher at ${launcher}`);
    if (opts.ifNewer) return { action: "blocked", from, reason: "launcher" };
    throw new FlockError(`A dev checkout's launcher owns ${launcher}; run \`scripts/setup.sh --unlink\` in that checkout to install a release.`, "invalid");
  }

  if (!standalone) {
    throw new FlockError("flock upgrade only upgrades an installed release binary. This is a checkout — use `git pull`.", "invalid");
  }
  if (opts.ifNewer) {
    const reason = updateBlockedReason({ standalone, env, config: readConfig() });
    if (reason) {
      logUpdate(`skipped: ${reason}`);
      return { action: "blocked", from, reason };
    }
  }

  if (!acquireLock()) {
    logUpdate("skipped: another updater holds the lock");
    return { action: "locked", from };
  }
  try {
    const stampNow = () => (opts.now ? opts.now() : new Date()).toISOString();
    const target = opts.version ? normalizeVersion(opts.version) : await latestVersion(env);
    logUpdate(`check: running ${from}, latest ${target ?? "unknown"}`);

    if (opts.ifNewer) {
      if (!target) {
        writeStamp({ lastCheck: stampNow() });
        return { action: "unknown-latest", from };
      }
      if (!isNewer(target, from)) {
        writeStamp({ lastCheck: stampNow(), lastSeen: target });
        return { action: "up-to-date", from, to: target };
      }
    }

    const dir = dirname(execPath);
    await runInstaller({ dir, version: target, env });

    // Everything after this point runs the *new* binary: it owns the skill format it ships with.
    const bin = join(dir, "flock");
    const code = await runLogged([bin, "setup", "--skill-only"], env, "setup");
    if (code !== 0) logUpdate(`setup --skill-only exited ${code}`);
    const daemonsRestarted = await restartDaemons(bin, env);

    const installed = target ?? (await installedVersion(bin)) ?? from;
    writeStamp({ lastCheck: stampNow(), lastSeen: installed, lastUpdate: stampNow() });
    logUpdate(`updated ${from} -> ${installed}${daemonsRestarted ? `, restarted ${daemonsRestarted} daemon(s)` : ""}`);
    return { action: "updated", from, to: installed, daemonsRestarted };
  } finally {
    releaseLock();
  }
}

/** `flock <bin> --version` -> the bare version, for the case where no target version was resolved. */
async function installedVersion(bin: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return text.trim().split(/\s+/)[1];
  } catch {
    return undefined;
  }
}

/**
 * `flock upgrade [--version V]` (the manual door, documented in `flock help`) and
 * `flock self-update [--if-newer] [--version V]` (the same thing, hidden, spawned by the automatic
 * checks). The automatic path is silent unless something actually happened.
 */
export async function updateCommand(opts: UpdateOptions & { quiet?: boolean } = {}): Promise<void> {
  const result = await runUpdate(opts);
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.action === "updated") {
    console.error(`flock: updated ${result.from} -> ${result.to}${result.daemonsRestarted ? ` (restarted ${result.daemonsRestarted} daemon)` : ""}`);
    return;
  }
  if (opts.quiet) return;
  if (result.action === "blocked") {
    if (result.reason === "launcher") console.error("flock: a dev checkout's launcher owns this install; `scripts/setup.sh --unlink` there restores the release binary");
    else console.error(`flock: auto-update is disabled (${result.reason})`);
  }
  else if (result.action === "locked") console.error("flock: another update is already running");
  else if (result.action === "unknown-latest") console.error("flock: could not work out the latest version");
  else console.error(`flock: already up to date (${result.from})`);
}

// ---------------------------------------------------------------------------- the triggers

/**
 * Spawn a detached `self-update --if-newer` if the guards allow it, and touch the stamp so nothing
 * else spawns another one for a day. Returns whether a child was spawned. Never throws: an update
 * check that fails must not change what the command the user actually ran did.
 */
export function spawnUpdateCheck(o: { ignoreStamp?: boolean; execPath?: string; env?: Record<string, string | undefined> } = {}): boolean {
  try {
    const env = o.env ?? process.env;
    if (autoUpdateBlocked(env)) return false;
    if (!o.ignoreStamp && !stampIsStale(readStamp())) return false;
    writeStamp({ lastCheck: new Date().toISOString() });
    const child = spawn(o.execPath ?? process.execPath, ["self-update", "--if-newer"], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The passive trigger, called once every CLI command has finished and flushed its output. The
 * first question is `isStandalone()`, so a contributor's checkout pays a function call and no
 * filesystem access at all.
 */
export function maybeSpawnUpdateCheck(cmd: string | undefined): boolean {
  if (!cmd || NO_AUTO_UPDATE_COMMANDS.has(cmd)) return false;
  return spawnUpdateCheck();
}

/**
 * The daemon trigger, started by `flock serve` once it is listening: 60 s plus up to ten minutes of
 * jitter, then every 6 h. Unref'd, so it is the server keeping the process alive, not these timers.
 * The stamp is not consulted — this schedule *is* the stamp's job, done by a process that is
 * already running.
 */
export function startDaemonUpdateChecks(o: { random?: () => number } = {}): void {
  if (autoUpdateBlocked()) return;
  const delay = DAEMON_FIRST_CHECK_MS + Math.floor((o.random ?? Math.random)() * DAEMON_JITTER_MS);
  const first = setTimeout(() => {
    spawnUpdateCheck({ ignoreStamp: true });
    const repeat = setInterval(() => spawnUpdateCheck({ ignoreStamp: true }), DAEMON_INTERVAL_MS);
    repeat.unref?.();
  }, delay);
  first.unref?.();
}
