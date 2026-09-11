import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DB_DIRNAME, DB_FILENAME, FlockError, globalDbPath, resolveDbPath } from "@flock/core";
import { CANONICAL_API_PORT, CANONICAL_WEB_PORT, DEFAULT_HOST, REPO_ROOT, advertisedUrls, baseUrl, devUrl, portOffset, resolveCheckout, resolveHost, type Checkout } from "./dev.ts";
import { flockHome } from "./paths.ts";
import { findStrays, isAlive, listProcesses, strayLabel, terminate, type Stray } from "./procs.ts";
import { isStandalone, version } from "./runtime.ts";
import { fallbackDbPath, fallbackMarkerExists, fallbackNote, needsFallback, rejoinHint, schemaStamp, seedFallback, type SchemaSite } from "./schema-policy.ts";
import { browserPort, establishTailscale, findTailscaleReal, preflightTailscale, preserveRunningTailscale, releaseTailscale, resolveTailscale, spawnRunner, type Runner } from "./tailscale.ts";

/**
 * `flock up|down|restart|status|logs|url`: the daemon, supervised by nothing but a runfile.
 *
 * `up` spawns detached children with stdio pointed at ~/.flock/logs/<name>.log and unref()s them,
 * so the terminal can close. The *child* writes ~/.flock/run/<name>.json once it is actually
 * listening, which makes the runfile a readiness signal rather than a race; `up` polls for it.
 * Liveness is `process.kill(pid, 0)` and a runfile whose pid is gone is pruned on read. See
 * ADR 0012; the ports, worktree detection and canonical-port refusal are ADR 0003's, reused
 * from dev.ts unchanged.
 */

/** Set by the parent on a spawned child: where that child writes its runfile once listening. */
export const RUNFILE_ENV = "FLOCK_RUNFILE";
/** Set by the parent on a spawned child: the JSON fields only the parent knows (name, mode, web port…). */
export const RUNINFO_ENV = "FLOCK_RUN_INFO";

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const TERM_GRACE_MS = 5_000;

export type Mode = "binary" | "checkout";

export interface RunInfo {
  /** Runfile namespace: `flock` for an installed daemon, `dev` for the canonical checkout, `dev@<dir>` for a worktree. */
  name: string;
  /** The serving child's pid. Liveness of the daemon is this pid's liveness. */
  pid: number;
  /** The vite child's pid, checkout mode only. */
  webPid?: number;
  mode: Mode;
  apiPort: number;
  webPort?: number;
  host: string;
  /** Checkout root in checkout mode, else the directory `up` ran in. */
  root: string;
  /** Database the daemon actually opened. */
  db: string;
  startedAt: string;
  url: string;
  version?: string;
  /** True when this daemon established a `tailscale serve` mount for its browser port (ADR 0019). */
  tailscale?: boolean;
  /** The `https://<magicdns>` origin that mount serves. */
  tailscaleUrl?: string;
  /** What the mount proxies to: exactly the string passed to `tailscale serve`. Compared against
   *  on teardown, rather than recomputed, since the daemon may have fallen back onto offset ports
   *  since the mount was established. */
  tailscaleTarget?: string;
}

export interface DaemonOptions {
  json: boolean;
  port?: number;
  webPort?: number;
  host?: string;
  db?: string;
  isolated?: boolean;
  open?: boolean;
  foreground?: boolean;
  all?: boolean;
  follow?: boolean;
  lines?: number;
  /** --tailscale / --no-tailscale. Tri-state: undefined means "not specified on this invocation". */
  tailscale?: boolean;
}

/** ~/.flock, or FLOCK_HOME. Everything the daemon writes lives under it. Defined in paths.ts so
 * update.ts can reach it without importing this module; re-exported here for existing callers. */
export { flockHome };
export const runDir = () => join(flockHome(), "run");
export const logsDir = () => join(flockHome(), "logs");
export const runfilePath = (name: string, dir = runDir()) => join(dir, `${name}.json`);
export const logPath = (name: string, dir = logsDir()) => join(dir, `${name}.log`);

/** True when `root` looks like a flock checkout we can run bun --watch and vite from. */
export function isCheckout(root: string): boolean {
  return existsSync(join(root, "packages", "web", "package.json")) && existsSync(join(root, "packages", "cli", "src", "main.ts"));
}

/**
 * Runfile namespace. An installed binary's daemon and a checkout's dev environment are two
 * different things that both want to be called "flock", so they get separate names: `flock` for
 * the installed daemon, `dev` for the canonical checkout, `dev@<dir>` for a worktree (ADR 0003's
 * per-checkout naming, kept, so worktrees still never collide with each other).
 */
export const BINARY_RUNFILE_NAME = "flock";
export const CHECKOUT_RUNFILE_NAME = "dev";
export function checkoutRunfileName(checkoutName: string): string {
  return checkoutName ? `${CHECKOUT_RUNFILE_NAME}@${checkoutName}` : CHECKOUT_RUNFILE_NAME;
}

// ---------------------------------------------------------------------------- runfiles

/** Tolerant runfile parse: anything that is not an object with a numeric pid and a name is not a runfile. */
export function parseRunInfo(text: string): RunInfo | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
  if (typeof o.name !== "string" || !o.name) return undefined;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const apiPort = num(o.apiPort);
  if (apiPort === undefined) return undefined;
  // A runfile from before ADR 0015 never named a wildcard bind it never did: the honest reading of
  // a missing `host` is what every build before this change actually bound, `127.0.0.1`, not the
  // new `0.0.0.0` default.
  const host = typeof o.host === "string" ? o.host : "127.0.0.1";
  return {
    name: o.name,
    pid: o.pid,
    webPid: num(o.webPid),
    mode: o.mode === "checkout" ? "checkout" : "binary",
    apiPort,
    webPort: num(o.webPort),
    host,
    root: typeof o.root === "string" ? o.root : "",
    db: typeof o.db === "string" ? o.db : "",
    startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
    url: typeof o.url === "string" ? o.url : baseUrl(host, apiPort),
    version: typeof o.version === "string" ? o.version : undefined,
    // Flat, tolerant fields (ADR 0019): a pre-0019 runfile has none of them and reads as
    // tailscale-off, which is what those daemons are.
    tailscale: o.tailscale === true ? true : undefined,
    tailscaleUrl: typeof o.tailscaleUrl === "string" && o.tailscaleUrl ? o.tailscaleUrl : undefined,
    tailscaleTarget: typeof o.tailscaleTarget === "string" && o.tailscaleTarget ? o.tailscaleTarget : undefined,
  };
}

/** Read one runfile, pruning it if it is unparseable or its pid is gone. */
export function readRunfile(name: string, dir = runDir()): RunInfo | undefined {
  const file = runfilePath(name, dir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const info = parseRunInfo(text);
  if (!info || !isAlive(info.pid)) {
    try {
      unlinkSync(file);
    } catch {}
    return undefined;
  }
  return info;
}

/** Every live daemon on this machine, in name order. Stale runfiles are pruned as a side effect. */
export function listRunfiles(dir = runDir()): RunInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.endsWith(".json"))
    .map((f) => readRunfile(f.slice(0, -5), dir))
    .filter((i): i is RunInfo => i !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function writeRunfile(file: string, info: RunInfo) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Called by `flock serve` once Bun.serve is listening. A no-op unless this process was spawned by
 * `flock up`, which is what makes the runfile a readiness signal. Merges the parent's static
 * fields (RUNINFO_ENV) with what only the child knows, and preserves a webPid the parent patched
 * in — `bun --watch` re-runs this on every reload.
 */
export function announceListening(live: { apiPort?: number; host?: string; db: string }) {
  const file = process.env[RUNFILE_ENV];
  if (!file) return;
  let fromParent: Record<string, unknown> = {};
  try {
    fromParent = JSON.parse(process.env[RUNINFO_ENV] ?? "{}") as Record<string, unknown>;
  } catch {}
  let existing: RunInfo | undefined;
  try {
    existing = parseRunInfo(readFileSync(file, "utf8"));
  } catch {}
  const apiPort = live.apiPort ?? 4747;
  const host = live.host ?? DEFAULT_HOST;
  const info = {
    name: "flock",
    mode: "binary" as Mode,
    // Overwritten by fromParent.url below whenever `up` spawned this (it always sets RUNINFO_ENV);
    // this is only the fallback for a malformed/missing RUNINFO_ENV.
    url: baseUrl(host, apiPort),
    ...fromParent,
    webPid: existing?.pid === process.pid ? existing.webPid : undefined,
    pid: process.pid,
    apiPort,
    host,
    db: live.db,
    startedAt: existing?.pid === process.pid && existing.startedAt ? existing.startedAt : new Date().toISOString(),
    version: version(),
  } as RunInfo;
  writeRunfile(file, info);
}

// ---------------------------------------------------------------------------- the plan

export interface ChildSpec {
  key: "api" | "web";
  cmd: string[];
  cwd: string;
  /** Applied over the parent env; an explicit undefined unsets an inherited variable. */
  env: Record<string, string | undefined>;
}

export interface DaemonPlan {
  name: string;
  mode: Mode;
  apiPort: number;
  webPort?: number;
  host: string;
  root: string;
  db: string;
  url: string;
  canonical: boolean;
  children: ChildSpec[];
  /** Set when the canonical checkout fell back off :4747/:5173 because they were held elsewhere. */
  portFallbackNote?: string;
  /** ADR 0021: set when a worktree stepped off the shared database onto a private copy. `up` seeds it. */
  schemaFallbackNote?: string;
  /** ADR 0019: set when this plan wants a `tailscale serve` mount established for its browser port. */
  tailscale?: boolean;
  tailscaleUrl?: string;
  tailscaleTarget?: string;
}

/** The fields `up` compares against a running daemon to decide already-running vs restart. */
export function settingsOf(p: DaemonPlan | RunInfo): Record<string, string> {
  return { mode: p.mode, apiPort: String(p.apiPort), webPort: String(p.webPort ?? ""), host: p.host, db: p.db, tailscale: String(p.tailscale ?? false) };
}

export function settingsDiffer(running: RunInfo, planned: DaemonPlan): boolean {
  const a = settingsOf(running);
  const b = settingsOf(planned);
  return Object.keys(b).some((k) => a[k] !== b[k]);
}

/**
 * Pure: what `up` would start, with the checkout (from dev.ts's planCheckout), the runtime mode
 * and the executable paths injected so it is testable without git, a real checkout or a binary.
 */
export function planDaemon(args: {
  mode: Mode;
  /** Argv prefix that runs this CLI's `serve`: the installed binary, or bun plus main.ts in a checkout. */
  serveCmd: string[];
  bun?: string;
  cwd: string;
  db: string;
  checkout?: Checkout;
  opts: Partial<DaemonOptions>;
  env: Record<string, string | undefined>;
  /** Resolved by the caller (resolvePlan, pure over `resolveTailscale`); this function never calls
   *  tailscale itself. Whether the mount is actually established happens in `up`, after the daemon
   *  is listening; `plan.url`/`tailscaleUrl`/`tailscaleTarget` are filled in there once it is. */
  tailscale?: boolean;
}): DaemonPlan {
  const { mode, serveCmd, cwd, db, checkout, opts, env } = args;
  const bun = args.bun ?? "bun";
  const host = resolveHost(opts.host, env);
  const tailscaleFields = args.tailscale ? { tailscale: true as const } : {};
  if (mode === "binary") {
    const apiPort = opts.port ?? (env.FLOCK_PORT ? Number(env.FLOCK_PORT) : 4747);
    const name = BINARY_RUNFILE_NAME;
    const url = baseUrl(host, apiPort);
    return {
      name,
      mode,
      apiPort,
      host,
      root: cwd,
      db,
      url,
      canonical: true,
      children: [
        {
          key: "api",
          cmd: [...serveCmd, "serve", "--port", String(apiPort), "--host", host],
          cwd,
          env: { FLOCK_PORT: String(apiPort), FLOCK_DB: db },
        },
      ],
      ...tailscaleFields,
    };
  }
  const c = checkout;
  if (!c) throw new FlockError("Checkout mode needs a resolved checkout.", "invalid");
  // Distinct namespace from an installed daemon's `flock`: a contributor who has flock installed
  // *and* runs a dev checkout has two different daemons, and one `up` must never stop the other.
  const name = checkoutRunfileName(c.name);
  const url = devUrl(c);
  const childEnv: Record<string, string | undefined> = {
    FLOCK_PORT: String(c.apiPort),
    FLOCK_WEB_PORT: String(c.webPort),
    // No --isolated and no --db: never let a stale FLOCK_DB leak in from the parent's environment.
    FLOCK_DB: c.db,
  };
  return {
    name,
    mode,
    apiPort: c.apiPort,
    webPort: c.webPort,
    host,
    root: c.root,
    db,
    url,
    canonical: c.canonical,
    children: [
      { key: "api", cmd: [bun, "--watch", join(c.root, "packages", "cli", "src", "main.ts"), "serve", "--port", String(c.apiPort), "--host", host], cwd: c.root, env: childEnv },
      { key: "web", cmd: [bun, "x", "vite", "--port", String(c.webPort), "--strictPort", "--host", host], cwd: join(c.root, "packages", "web"), env: childEnv },
    ],
    ...tailscaleFields,
  };
}

/**
 * The live entry point: resolves the checkout (git, cwd) and the database, then plans.
 *
 * Checkout mode needs both a checkout on disk *and* a cwd inside it — dev.ts's walk-up falls back
 * to the CLI's own source tree, and `flock up` run from somewhere else should serve a board, not
 * start someone's dev environment.
 */
export function resolvePlan(opts: Partial<DaemonOptions> = {}): DaemonPlan {
  const cwd = process.cwd();
  const standalone = isStandalone();
  const checkout = standalone ? undefined : resolveCheckout(opts);
  const inside = checkout ? cwd === checkout.root || resolve(cwd).startsWith(`${checkout.root}${sep}`) : false;
  const mode: Mode = standalone || !checkout || !inside || !isCheckout(checkout.root) ? "binary" : "checkout";
  let effectiveCheckout = checkout;
  let portFallbackNote: string | undefined;
  if (mode === "checkout" && checkout) {
    const fallback = canonicalFallbackPlan(checkout, opts, process.env, listRunfiles(), portFree);
    effectiveCheckout = fallback.checkout;
    portFallbackNote = fallback.note;
  }
  const name = mode === "binary" ? BINARY_RUNFILE_NAME : checkoutRunfileName((effectiveCheckout as Checkout).name);
  const existingRunfile = readRunfile(name);
  const effectiveOpts: Partial<DaemonOptions> = { ...opts, host: preserveRunningHost(opts, process.env, existingRunfile) };
  const resolvedDb = mode === "checkout" && effectiveCheckout?.db ? effectiveCheckout.db : resolveDbPath(opts.db).path;
  const schemaFallback = worktreeDbFallback({ site: siteOf(mode, effectiveCheckout), db: resolvedDb, shared: globalDbPath(), stamp: schemaStamp });
  const db = schemaFallback.db;
  if (mode === "checkout" && effectiveCheckout && schemaFallback.note) effectiveCheckout = { ...effectiveCheckout, db };
  // Pure: whether this plan wants a tailscale mount. No subprocess here — preflight and the mount
  // itself happen in `up`, so `status`/`down`/`url`/`logs` (which also call resolvePlan) never probe
  // tailscale and stay fast and offline-safe.
  const tailscale = resolveTailscale(preserveRunningTailscale(opts.tailscale, process.env, existingRunfile), process.env);
  const plan = planDaemon({ mode, serveCmd: serveCmd(), bun: bunPath(), cwd, db, checkout: effectiveCheckout, opts: effectiveOpts, env: process.env, tailscale });
  if (portFallbackNote) plan.portFallbackNote = portFallbackNote;
  if (schemaFallback.note) plan.schemaFallbackNote = schemaFallback.note;
  return plan;
}

function siteOf(mode: Mode, checkout?: Checkout): SchemaSite {
  if (mode === "binary" || !checkout) return { standalone: mode === "binary", worktree: false, root: checkout?.root ?? process.cwd() };
  return { standalone: false, worktree: !checkout.canonical, root: checkout.root };
}

/**
 * ADR 0021, the daemon's half: decide *before* spawning whether this worktree's children would
 * stamp the shared database, and point them at the private copy instead. Pure over `stamp` so
 * it is testable without a real file; `up` does the seeding.
 */
export function worktreeDbFallback(args: { site: SchemaSite; db: string; shared: string; stamp: (path: string) => number; version?: number }): { db: string; note?: string } {
  const { site, db, shared, stamp, version } = args;
  const current = stamp(shared);
  if (!needsFallback({ site, db, shared, stamp: current, version })) return { db };
  const dest = fallbackDbPath(site.root);
  return { db: dest, note: fallbackNote({ stamp: current, version, dest }) };
}

/**
 * `up`/`restart` must not flip a daemon someone started with `--host 127.0.0.1` back onto the
 * wildcard (or config) default just because a later invocation carries neither `--host` nor
 * `FLOCK_HOST`: recomputing the default every time would otherwise fight the very thing that made
 * the daemon idempotent (`settingsDiffer`) and would silently re-expose a deliberately closed
 * daemon on `restart`. When there is no explicit override, an already-running daemon's own runfile
 * wins over `FLOCK_HOST`'s absence and over config/default; a first start (no runfile yet) is
 * unaffected and still resolves through `resolveHost`'s normal precedence. Pure over an injected
 * runfile lookup so it's testable without one on disk.
 */
export function preserveRunningHost(opts: Partial<DaemonOptions>, env: Record<string, string | undefined>, existing: RunInfo | undefined): string | undefined {
  if (opts.host !== undefined || env.FLOCK_HOST) return opts.host;
  return existing?.host ?? opts.host;
}

/**
 * The canonical checkout's port fallback, in isolation: pure over an injected runfile list and a
 * `portFree` probe, so it's testable without git, a real checkout, or binding a real socket.
 *
 * A worktree is untouched (it never defaults onto the canonical ports in the first place, and
 * still refuses an explicit override — `planCheckout`'s job). For the canonical checkout, an
 * explicit `--port`/`--web-port`/`FLOCK_PORT`/`FLOCK_WEB_PORT` always wins and is left alone here;
 * `guardPorts` still refuses it later if it is held. Otherwise, if :4747/:5173 are held by a
 * different runfile (the installed binary's `flock`, a worktree, anything) or by an unidentified
 * listener, and are not already this same checkout's own runfile's ports, this returns the ADR
 * 0003 worktree-style offset ports instead, plus a one-line note explaining why.
 */
export function canonicalFallbackPlan(
  checkout: Checkout,
  opts: Partial<DaemonOptions>,
  env: Record<string, string | undefined>,
  runfiles: RunInfo[],
  isPortFree: (port: number, host: string) => boolean,
): { checkout: Checkout; note?: string } {
  if (!checkout.canonical) return { checkout };
  const explicitPort = opts.port !== undefined || env.FLOCK_PORT !== undefined;
  const explicitWebPort = opts.webPort !== undefined || env.FLOCK_WEB_PORT !== undefined;
  if (explicitPort || explicitWebPort) return { checkout };
  const host = resolveHost(opts.host, env);
  const ownName = checkoutRunfileName(checkout.name);
  const mine = runfiles.find((r) => r.name === ownName);
  const heldByMe = mine ? portsOf(mine) : [];
  const heldElsewhere = [checkout.apiPort, checkout.webPort].some((port) => {
    if (heldByMe.includes(port)) return false;
    if (runfiles.some((o) => o.name !== ownName && portsOf(o).includes(port))) return true;
    return probeHosts(host).some((h) => !isPortFree(port, h));
  });
  if (!heldElsewhere) return { checkout };
  const offset = portOffset(checkout.root);
  const apiPort = 4800 + offset;
  const webPort = 5200 + offset;
  return {
    checkout: { ...checkout, apiPort, webPort },
    note: `Canonical ports :${CANONICAL_API_PORT}/:${CANONICAL_WEB_PORT} are held elsewhere; falling back to :${apiPort}/:${webPort}.`,
  };
}

function bunPath(): string {
  // In a checkout the CLI is itself running under bun, so process.execPath is the bun binary.
  return isStandalone() ? "bun" : process.execPath;
}

/** How to invoke this same CLI's `serve`: the binary itself, or bun plus the CLI entry point. */
function serveCmd(): string[] {
  return isStandalone() ? [process.execPath] : [process.execPath, join(REPO_ROOT, "packages", "cli", "src", "main.ts")];
}

// ---------------------------------------------------------------------------- lifecycle

interface Spawned {
  api: number;
  web?: number;
  /** Flips when the API child exits: before readiness, that is a failed start. */
  apiExited: () => boolean;
}

function spawnChildren(plan: DaemonPlan): Spawned {
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(runDir(), { recursive: true });
  const log = openSync(logPath(plan.name), "a");
  const pids: { api?: number; web?: number } = {};
  let apiExited = false;
  for (const child of plan.children) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const [k, v] of Object.entries(child.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    if (child.key === "api") {
      env[RUNFILE_ENV] = runfilePath(plan.name);
      env[RUNINFO_ENV] = JSON.stringify({ name: plan.name, mode: plan.mode, webPort: plan.webPort, root: plan.root, url: plan.url });
    } else {
      delete env[RUNFILE_ENV];
      delete env[RUNINFO_ENV];
    }
    const proc = spawn(child.cmd[0], child.cmd.slice(1), { cwd: child.cwd, env, detached: true, stdio: ["ignore", log, log] });
    proc.unref();
    if (proc.pid === undefined) throw new FlockError(`Could not start ${child.cmd[0]}.`, "invalid");
    if (child.key === "api") proc.once("exit", () => (apiExited = true));
    pids[child.key] = proc.pid;
  }
  if (pids.api === undefined) throw new FlockError("No API child was started.", "invalid");
  return { api: pids.api, web: pids.web, apiExited: () => apiExited };
}

async function waitForRunfile(plan: DaemonPlan, spawned: Spawned, logOffset: number, timeoutMs = READY_TIMEOUT_MS): Promise<RunInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readRunfile(plan.name);
    if (info) return info;
    if (spawned.apiExited() || !isAlive(spawned.api)) throw startupFailure(plan, logOffset, "The daemon exited before it started listening:");
    if (Date.now() >= deadline) throw startupFailure(plan, logOffset, `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the daemon to start listening.`);
    await Bun.sleep(READY_POLL_MS);
  }
}

/**
 * Spawn the plan's children and wait for readiness. On any failure, every child this call spawned
 * is stopped before the error propagates: a vite whose API never came up is exactly the orphan
 * that otherwise holds the web port with nothing tracking it (ADR 0020).
 */
async function startChildren(plan: DaemonPlan): Promise<{ info: RunInfo; web?: number }> {
  const logOffset = logSize(plan.name);
  const spawned = spawnChildren(plan);
  try {
    return { info: await waitForRunfile(plan, spawned, logOffset), web: spawned.web };
  } catch (e) {
    await terminate([spawned.api, ...(spawned.web !== undefined ? [spawned.web] : [])], TERM_GRACE_MS);
    throw e;
  }
}

/** SIGTERM every pid in the runfile, then SIGKILL whatever is still alive after the grace period. */
async function stop(info: RunInfo, graceMs = TERM_GRACE_MS) {
  await terminate([info.pid, ...(info.webPid ? [info.webPid] : [])], graceMs);
  try {
    unlinkSync(runfilePath(info.name));
  } catch {}
}

/** Live runfiles' pids: those children are supervised, so they are never strays. */
function ownedPids(runfiles: RunInfo[]): Set<number> {
  return new Set(runfiles.flatMap((r) => [r.pid, ...(r.webPid ? [r.webPid] : [])]));
}

/** This checkout's dev children that no runfile tracks any more (ADR 0020). None outside checkout mode. */
function straysOf(plan: DaemonPlan): Stray[] {
  if (plan.mode !== "checkout") return [];
  return findStrays(listProcesses(), plan.root, ownedPids(listRunfiles()));
}

async function reapStrays(plan: DaemonPlan): Promise<Stray[]> {
  const strays = straysOf(plan);
  if (strays.length) await terminate(strays.map((s) => s.pid), TERM_GRACE_MS);
  return strays;
}

const straysPhrase = (strays: Stray[]) => `${strays.length} stray process${strays.length === 1 ? "" : "es"} from an earlier run: ${strays.map(strayLabel).join(", ")}`;

/**
 * `up` and `restart` clear this checkout's strays before planning, so a vite orphan squatting on
 * :5173 neither blocks the start nor pushes the canonical checkout onto its fallback ports. Returns
 * the plan to use: re-resolved if anything was freed, since the port fallback depends on it.
 */
async function healStrays(plan: DaemonPlan, opts: DaemonOptions): Promise<DaemonPlan> {
  const strays = await reapStrays(plan);
  if (!strays.length) return plan;
  console.error(`Stopped ${straysPhrase(strays)}.`);
  return resolvePlan(opts);
}

/**
 * The lines this start appended to the log that explain a failure: error lines first, else the
 * tail. Vite's proxy errors are dropped — an open tab polling a dead API floods the shared log.
 */
export function startupFailureExcerpt(appended: string, max = 5): string[] {
  const lines = appended
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !/proxy error|ECONNREFUSED/.test(l));
  const errors = lines.filter((l) => /^(error:|\w*Error:)/i.test(l.trim()));
  return (errors.length ? errors : lines).slice(-max);
}

function logSize(name: string): number {
  return existsSync(logPath(name)) ? statSync(logPath(name)).size : 0;
}

function startupFailure(plan: DaemonPlan, logOffset: number, what: string): FlockError {
  const file = logPath(plan.name);
  const appended = existsSync(file) ? readFileSync(file).subarray(logOffset).toString("utf8") : "";
  const excerpt = startupFailureExcerpt(appended).map((l) => `  ${l}`);
  return new FlockError([what, ...excerpt, `Check ${file}`].join("\n"), "invalid");
}

/** Every port a plan or a running daemon occupies: the API port, plus vite's in checkout mode. */
export function portsOf(d: { apiPort: number; webPort?: number }): number[] {
  return [d.apiPort, ...(d.webPort ? [d.webPort] : [])];
}

/**
 * Would starting `plan` land on a port another daemon already holds? Pure, so the message is
 * testable: `others` is every live runfile, `held` the ports the daemon we are about to restart
 * already owns (those are ours to take back). Returns the error text, or undefined for "go ahead".
 */
export function portHeldByOther(plan: DaemonPlan, others: RunInfo[], held: number[] = []): string | undefined {
  for (const port of portsOf(plan)) {
    if (held.includes(port)) continue;
    const other = others.find((o) => o.name !== plan.name && portsOf(o).includes(port));
    if (other) {
      const what = other.mode === "binary" ? "the installed daemon" : `the "${other.name}" daemon`;
      return `Port ${port} is already served by ${what} (pid ${other.pid}) at ${other.root}.\nStop it there with \`flock down\`, or start this one on another port.`;
    }
  }
  return undefined;
}

/** Can we bind this port right now? False means something we do not know about is listening. */
export function portFree(port: number, host: string): boolean {
  try {
    const s = Bun.serve({ port, hostname: host, fetch: () => new Response("") });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hosts to probe availability against for a bind host: itself, plus loopback too when it's the
 * wildcard. A squatter on 127.0.0.1 does not reliably block a later 0.0.0.0 bind on the same port
 * (SO_REUSEADDR lets both coexist on some platforms), so treating that port as free would still
 * crash the child on startup; probing loopback as well catches it up front.
 */
function probeHosts(host: string): string[] {
  return host === "0.0.0.0" || host === "::" || host === "" ? [host || "0.0.0.0", "127.0.0.1"] : [host];
}

/** The daemon's addresses, host-aware: see `advertisedUrls` in dev.ts (ADR 0015, ADR 0019). */
function urls(d: { mode: Mode; apiPort: number; webPort?: number; host: string; tailscaleUrl?: string }): { urls: string[]; hint?: string } {
  return advertisedUrls(d.host, browserPort(d), undefined, d.tailscaleUrl);
}

/**
 * Where, on what ports, against which database. Takes the live runfile when there is one, so
 * `status` describes what is actually running rather than what `up` would start.
 */
function describe(d: {
  name: string;
  mode: Mode;
  canonical?: boolean;
  apiPort: number;
  webPort?: number;
  host: string;
  root: string;
  db: string;
  tailscaleUrl?: string;
  tailscaleTarget?: string;
}): string {
  const where =
    d.mode === "binary"
      ? "installed daemon"
      : (d.canonical ?? d.name === CHECKOUT_RUNFILE_NAME)
        ? "canonical checkout"
        : `worktree "${d.name.replace(`${CHECKOUT_RUNFILE_NAME}@`, "")}"`;
  const { urls: list, hint } = urls(d);
  const [local, ...net] = list;
  const web = [local, ...net.map((u) => `\n      ${u}`), ...(hint ? [`\n      ${hint}`] : [])].join("");
  const isolated = d.db !== globalDbPath();
  // The api line uses the same host-aware URL as `web` in binary mode, not a hardcoded "localhost":
  // a specific non-loopback --host means the API is only reachable at that host, not at loopback.
  // It never gets the tailscale URL: the mount fronts the browser-facing port only (ADR 0019 d2).
  const api = `\n  api ${baseUrl(d.host, d.apiPort)}`;
  // Names the mechanism and its target, so a reader who did not start the daemon knows where the
  // certificate comes from and what to turn off (ADR 0019 §8).
  const tls = d.tailscaleTarget ? `\n  tls tailscale serve :443 -> ${d.tailscaleTarget}` : "";
  return `${where} at ${d.root}\n  web ${web}${api}\n  db  ${d.db}${isolated ? " (isolated)" : " (shared)"}${tls}`;
}

/**
 * Refuse rather than kill. A port we are about to take may belong to a *different* daemon (an
 * installed one while this is a checkout, say) or to something that is not flock at all; in either
 * case the old behaviour — SIGTERM whatever the runfile named, or race the bind and die in the log
 * — is worse than one clear line. Ports the daemon being restarted already holds are ours.
 */
function guardPorts(plan: DaemonPlan, held: number[]) {
  const conflict = portHeldByOther(plan, listRunfiles(), held);
  if (conflict) throw new FlockError(conflict, "invalid");
  for (const port of portsOf(plan)) {
    if (held.includes(port)) continue;
    for (const host of probeHosts(plan.host)) {
      if (!portFree(port, host)) {
        throw new FlockError(`Port ${port} is already in use by another process (not a flock daemon).\nStop it, or start this one on another port.`, "invalid");
      }
    }
  }
}

/**
 * Establish (or re-assert) the plan's tailscale mount and fold the result into a `RunInfo` patch.
 * Every `up --tailscale` calls this, whether the daemon was just started or was already running:
 * the mount lives in tailscaled, not in the runfile, so a `tailscale down`, a reboot, or a manual
 * `serve reset` can remove it behind flock's back, and `flock up` is the reconciler (ADR 0019 §5).
 */
function mountTailscale(plan: DaemonPlan): Pick<RunInfo, "tailscale" | "tailscaleUrl" | "tailscaleTarget" | "url"> {
  const bin = findTailscaleReal();
  const run: Runner = spawnRunner;
  const mount = establishTailscale({ run, bin, host: plan.host, port: browserPort(plan) });
  return { tailscale: true, tailscaleUrl: mount.url, tailscaleTarget: mount.target, url: mount.url };
}

/** Guarded teardown for `down` and `restart`'s stop half: a no-op unless the runfile says this
 *  daemon established a mount. Prints (but does not throw on) whatever `releaseTailscale` reports. */
function teardownTailscale(info: RunInfo) {
  if (!info.tailscale || !info.tailscaleTarget) return;
  const note = releaseTailscale({ run: spawnRunner, bin: findTailscaleReal(), target: info.tailscaleTarget });
  if (note) console.error(note);
}

/** `flock up`: idempotent. Already running / started / restarted with new settings. */
async function up(plan: DaemonPlan, opts: DaemonOptions, label?: "restarted", heldPorts?: number[]) {
  if (plan.mode === "checkout" && opts.isolated && plan.db) {
    mkdirSync(dirname(plan.db), { recursive: true });
    const gi = join(dirname(plan.db), ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*.db\n*.db-wal\n*.db-shm\n");
  }
  // ADR 0021: the plan chose a private copy; make it exist before the children open it.
  if (plan.schemaFallbackNote) seedFallback(globalDbPath(), plan.db);
  const existing = readRunfile(plan.name);
  guardPorts(plan, existing ? portsOf(existing) : (heldPorts ?? []));
  // Preflight only (steps 1-5 of ADR 0019 §4): entirely read-only, so a refusal here costs nothing
  // and starts nothing, whether this call goes on to do nothing (already running) or a fresh start.
  if (plan.tailscale) preflightTailscale({ run: spawnRunner, bin: findTailscaleReal() });
  let action: "already running" | "started" | "restarted" | "restarted with new settings" = "started";
  const fallback = [plan.portFallbackNote, plan.schemaFallbackNote].filter(Boolean).join("\n") || undefined;
  // Half a dev environment is not "already running": an API whose vite has died gets restarted.
  const webGone = existing?.mode === "checkout" && !(existing.webPid !== undefined && isAlive(existing.webPid));
  if (existing && !settingsDiffer(existing, plan) && !webGone) {
    action = "already running";
    // Not ours to kill if the mount fails: this invocation did not start the daemon.
    const info = plan.tailscale ? { ...existing, ...mountTailscale(plan) } : existing;
    if (plan.tailscale) writeRunfile(runfilePath(plan.name), info);
    if (opts.json) console.log(JSON.stringify({ action, ...info, ...(fallback ? { portFallback: fallback } : {}) }));
    else console.log(`${fallback ? `${fallback}\n\n` : ""}${action}: pid ${existing.pid}\n\n${describe(info)}\n\nLogs: flock logs`);
    // Deliberately not `info.url` (the tailscale https URL when a mount is active): `--open`
    // opens a browser on this machine, so it stays on the loopback/bound address rather than
    // round-tripping through the tailnet — see the doc comment on `AdvertisedUrls.urls`.
    if (opts.open) openUrl(baseUrl(plan.host, browserPort(plan)));
    return;
  }
  if (existing) {
    // Settings differ (e.g. `up --no-tailscale` on a mounted daemon): tear down whatever mount
    // the old settings established before stopping it, same as the `restart` command does —
    // otherwise a bare settings-changing `up` leaves tailscaled still proxying to the port that
    // is about to be replaced (or torn down entirely), a stale mount nothing else will notice.
    teardownTailscale(existing);
    await stop(existing);
    action = settingsDiffer(existing, plan) ? "restarted with new settings" : "restarted";
  }
  try {
    unlinkSync(runfilePath(plan.name));
  } catch {}
  if (label) action = label as typeof action;
  const started = await startChildren(plan);
  const pids = { web: started.web };
  let info = started.info;
  if (pids.web !== undefined) info = { ...info, webPid: pids.web };
  if (plan.tailscale) {
    try {
      info = { ...info, ...mountTailscale(plan) };
    } catch (e) {
      // "up --tailscale gives you HTTPS or it gives you nothing" (ADR 0019 §5): this invocation
      // started the daemon, so a mount failure after readiness stops it again rather than leaving
      // an HTTP-only daemon up that silently lacks the capability it was started for.
      await stop(info);
      throw e;
    }
  }
  if (plan.tailscale || pids.web !== undefined) writeRunfile(runfilePath(plan.name), info);
  if (opts.json) return console.log(JSON.stringify({ action, ...info, ...(fallback ? { portFallback: fallback } : {}) }));
  if (fallback) console.log(fallback);
  console.log(`${action}: pid ${info.pid}${pids.web !== undefined ? `, web pid ${pids.web}` : ""}`);
  console.log(`\n${describe(info)}\n\nLogs: flock logs`);
  // Same reasoning as the "already running" branch above: stay on loopback, not the tailscale URL.
  if (opts.open) openUrl(baseUrl(plan.host, browserPort(plan)));
}

function openUrl(url: string) {
  try {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

function statusLine(i: RunInfo): string {
  const port = i.webPort ?? i.apiPort;
  return `${i.name.padEnd(20)} ${String(i.pid).padEnd(8)} ${i.mode.padEnd(9)} :${String(port).padEnd(6)} ${i.root}`;
}

/** Which binary this `flock` invocation is: an installed release build, or a checkout's source. */
function binaryLine(): string {
  const path = process.execPath;
  return isStandalone() ? `Binary: ${path} (flock ${version()})` : `Binary: ${path} (source checkout, version() returns "${version()}")`;
}

/**
 * `flock <up|down|restart|status|logs|url>`: the daemon for the directory you are in. An installed
 * binary serves the embedded web app on one port; a checkout starts bun --watch plus vite on the
 * ports ADR 0003 gives it. `status` lists every daemon on the machine, from any directory.
 */
export async function daemonCommand(cmd: string, opts: DaemonOptions) {
  switch (cmd) {
    case "up":
    case "start": {
      await up(await healStrays(resolvePlan(opts), opts), opts);
      return;
    }
    case "down":
    case "stop": {
      const plan = resolvePlan(opts);
      const targets = opts.all ? listRunfiles() : [readRunfile(plan.name)].filter((i): i is RunInfo => i !== undefined);
      for (const i of targets) {
        teardownTailscale(i);
        await stop(i);
      }
      const strays = await reapStrays(plan);
      if (opts.json) return console.log(JSON.stringify({ stopped: targets.map((i) => i.name), strays: strays.map((s) => s.pid) }));
      const parts = [...targets.map((i) => i.name), ...(strays.length ? [straysPhrase(strays)] : [])];
      if (!parts.length) return console.log("not running");
      console.log(`stopped ${parts.join(", ")}`);
      return;
    }
    case "restart": {
      const plan = await healStrays(resolvePlan(opts), opts);
      const existing = readRunfile(plan.name);
      // Guard before stopping, and hand `up` the ports we just released — they are ours to retake.
      if (existing) guardPorts(plan, portsOf(existing));
      if (existing) {
        teardownTailscale(existing);
        await stop(existing);
      }
      await up(plan, opts, existing ? "restarted" : undefined, existing ? portsOf(existing) : []);
      return;
    }
    case "status": {
      const plan = resolvePlan(opts);
      const all = listRunfiles();
      const mine = all.find((i) => i.name === plan.name);
      const others = all.filter((i) => i !== mine);
      const binary = { execPath: process.execPath, standalone: isStandalone(), version: version() };
      const strays = straysOf(plan);
      if (opts.json) return console.log(JSON.stringify({ here: mine ?? null, others, strays, plan: { name: plan.name, mode: plan.mode, apiPort: plan.apiPort, webPort: plan.webPort, root: plan.root, db: plan.db, url: plan.url }, binary }));
      console.log(binaryLine());
      if (plan.portFallbackNote) console.log(plan.portFallbackNote);
      if (plan.schemaFallbackNote) console.log(`${plan.schemaFallbackNote.split("\n")[0]} \`flock up\` will use a private copy.`);
      if (!mine) console.log(`not running here. Start with: flock up\n\n${describe(plan)}`);
      else console.log(`${statusLine(mine)}\n\n${describe(mine)}`);
      const rejoin = rejoinHint({ db: plan.db, marker: fallbackMarkerExists(plan.db), sharedStamp: schemaStamp(globalDbPath()), copyStamp: schemaStamp(plan.db) });
      if (rejoin) console.log(`\n${rejoin}`);
      if (strays.length) console.log(`\nNot tracked by any runfile (\`flock down\` or \`flock up\` stops them):\n  ${strays.map(strayLabel).join("\n  ")}`);
      if (others.length) {
        console.log(`\nAlso running:`);
        for (const i of others) console.log(`  ${statusLine(i)}`);
      }
      return;
    }
    case "logs": {
      const plan = resolvePlan(opts);
      const file = logPath(plan.name);
      if (!existsSync(file)) throw new FlockError(`No log yet at ${file}. Start the daemon with \`flock up\`.`, "not_found");
      const args = ["-n", String(opts.lines ?? 40), ...(opts.follow ? ["-f"] : []), file];
      const proc = spawn("tail", args, { stdio: "inherit" });
      await new Promise<void>((res) => proc.on("exit", () => res()));
      return;
    }
    case "url": {
      const plan = resolvePlan(opts);
      // The running daemon's URL when there is one; otherwise the one `up` would print.
      const { urls: list, hint } = urls(readRunfile(plan.name) ?? plan);
      // --json is URLs only, no hint line, so a machine consumer never has to filter it out.
      if (opts.json) return console.log(JSON.stringify(list));
      console.log(list.join("\n"));
      if (hint) console.log(hint);
      return;
    }
    default:
      throw new FlockError(`Unknown daemon command "${cmd}".`, "invalid");
  }
}

/**
 * `flock up --foreground` delegates to `flock serve`: this sets the port that plan would have
 * used, so a worktree's foreground run still lands on the worktree's API port.
 */
export function foregroundPort(opts: Partial<DaemonOptions> = {}): number {
  return resolvePlan(opts).apiPort;
}

export { DB_DIRNAME, DB_FILENAME };
