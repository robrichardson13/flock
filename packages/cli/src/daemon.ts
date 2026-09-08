import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DB_DIRNAME, DB_FILENAME, FlockError, globalDbPath, resolveDbPath } from "@flock/core";
import { CANONICAL_API_PORT, CANONICAL_WEB_PORT, REPO_ROOT, devUrl, networkHosts, portOffset, resolveCheckout, type Checkout } from "./dev.ts";
import { flockHome } from "./paths.ts";
import { isStandalone, version } from "./runtime.ts";

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
  return {
    name: o.name,
    pid: o.pid,
    webPid: num(o.webPid),
    mode: o.mode === "checkout" ? "checkout" : "binary",
    apiPort,
    webPort: num(o.webPort),
    host: typeof o.host === "string" ? o.host : "127.0.0.1",
    root: typeof o.root === "string" ? o.root : "",
    db: typeof o.db === "string" ? o.db : "",
    startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
    url: typeof o.url === "string" ? o.url : `http://localhost:${apiPort}`,
    version: typeof o.version === "string" ? o.version : undefined,
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else: still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const info = {
    name: "flock",
    mode: "binary" as Mode,
    url: `http://localhost:${live.apiPort ?? 4747}`,
    ...fromParent,
    webPid: existing?.pid === process.pid ? existing.webPid : undefined,
    pid: process.pid,
    apiPort: live.apiPort ?? 4747,
    host: live.host ?? "127.0.0.1",
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
}

/** The fields `up` compares against a running daemon to decide already-running vs restart. */
export function settingsOf(p: DaemonPlan | RunInfo): Record<string, string> {
  return { mode: p.mode, apiPort: String(p.apiPort), webPort: String(p.webPort ?? ""), host: p.host, db: p.db };
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
}): DaemonPlan {
  const { mode, serveCmd, cwd, db, checkout, opts, env } = args;
  const bun = args.bun ?? "bun";
  const host = opts.host ?? "127.0.0.1";
  if (mode === "binary") {
    const apiPort = opts.port ?? (env.FLOCK_PORT ? Number(env.FLOCK_PORT) : 4747);
    const name = BINARY_RUNFILE_NAME;
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${apiPort}`;
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
      { key: "web", cmd: [bun, "x", "vite", "--port", String(c.webPort), "--strictPort"], cwd: join(c.root, "packages", "web"), env: childEnv },
    ],
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
  const db = mode === "checkout" && effectiveCheckout?.db ? effectiveCheckout.db : resolveDbPath(opts.db).path;
  const plan = planDaemon({ mode, serveCmd: serveCmd(), bun: bunPath(), cwd, db, checkout: effectiveCheckout, opts, env: process.env });
  if (portFallbackNote) plan.portFallbackNote = portFallbackNote;
  return plan;
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
  const host = opts.host ?? "127.0.0.1";
  const ownName = checkoutRunfileName(checkout.name);
  const mine = runfiles.find((r) => r.name === ownName);
  const heldByMe = mine ? portsOf(mine) : [];
  const heldElsewhere = [checkout.apiPort, checkout.webPort].some((port) => {
    if (heldByMe.includes(port)) return false;
    if (runfiles.some((o) => o.name !== ownName && portsOf(o).includes(port))) return true;
    return !isPortFree(port, host);
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

function spawnChildren(plan: DaemonPlan): { api: number; web?: number } {
  mkdirSync(logsDir(), { recursive: true });
  mkdirSync(runDir(), { recursive: true });
  const log = openSync(logPath(plan.name), "a");
  const pids: { api?: number; web?: number } = {};
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
    pids[child.key] = proc.pid;
  }
  if (pids.api === undefined) throw new FlockError("No API child was started.", "invalid");
  return { api: pids.api, web: pids.web };
}

async function waitForRunfile(plan: DaemonPlan, timeoutMs = READY_TIMEOUT_MS): Promise<RunInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readRunfile(plan.name);
    if (info) return info;
    if (Date.now() >= deadline) {
      throw new FlockError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the daemon to start listening.\nCheck ${logPath(plan.name)}`, "invalid");
    }
    await Bun.sleep(READY_POLL_MS);
  }
}

/** SIGTERM every pid in the runfile, then SIGKILL whatever is still alive after the grace period. */
async function stop(info: RunInfo, graceMs = TERM_GRACE_MS) {
  const pids = [info.pid, ...(info.webPid ? [info.webPid] : [])];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(isAlive)) await Bun.sleep(100);
  for (const pid of pids.filter(isAlive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    unlinkSync(runfilePath(info.name));
  } catch {}
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

/** The daemon's addresses: its own URL first, then the LAN and Tailscale ones another device can use. */
function urls(d: { mode: Mode; apiPort: number; webPort?: number; url: string }): string[] {
  const port = d.mode === "checkout" ? d.webPort : d.apiPort;
  return [d.url, ...networkHosts().map((h) => `http://${h}:${port}`)];
}

/**
 * Where, on what ports, against which database. Takes the live runfile when there is one, so
 * `status` describes what is actually running rather than what `up` would start.
 */
function describe(d: { name: string; mode: Mode; canonical?: boolean; apiPort: number; webPort?: number; url: string; root: string; db: string }): string {
  const where =
    d.mode === "binary"
      ? "installed daemon"
      : (d.canonical ?? d.name === CHECKOUT_RUNFILE_NAME)
        ? "canonical checkout"
        : `worktree "${d.name.replace(`${CHECKOUT_RUNFILE_NAME}@`, "")}"`;
  const [local, ...net] = urls(d);
  const web = [local, ...net.map((u) => `\n      ${u}`)].join("");
  const isolated = d.db !== globalDbPath();
  return `${where} at ${d.root}\n  web ${web}\n  api http://localhost:${d.apiPort}\n  db  ${d.db}${isolated ? " (isolated)" : " (shared)"}`;
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
    if (!portFree(port, plan.host)) {
      throw new FlockError(`Port ${port} is already in use by another process (not a flock daemon).\nStop it, or start this one on another port.`, "invalid");
    }
  }
}

/** `flock up`: idempotent. Already running / started / restarted with new settings. */
async function up(plan: DaemonPlan, opts: DaemonOptions, label?: "restarted", heldPorts?: number[]) {
  if (plan.mode === "checkout" && opts.isolated && plan.db) {
    mkdirSync(dirname(plan.db), { recursive: true });
    const gi = join(dirname(plan.db), ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*.db\n*.db-wal\n*.db-shm\n");
  }
  const existing = readRunfile(plan.name);
  guardPorts(plan, existing ? portsOf(existing) : (heldPorts ?? []));
  let action: "already running" | "started" | "restarted" | "restarted with new settings" = "started";
  const fallback = plan.portFallbackNote;
  if (existing && !settingsDiffer(existing, plan)) {
    action = "already running";
    if (opts.json) console.log(JSON.stringify({ action, ...existing, ...(fallback ? { portFallback: fallback } : {}) }));
    else console.log(`${fallback ? `${fallback}\n\n` : ""}${action}: pid ${existing.pid}\n\n${describe(existing)}\n\nLogs: flock logs`);
    if (opts.open) openUrl(existing.url);
    return;
  }
  if (existing) {
    await stop(existing);
    action = "restarted with new settings";
  }
  try {
    unlinkSync(runfilePath(plan.name));
  } catch {}
  if (label) action = label as typeof action;
  const pids = spawnChildren(plan);
  const info = await waitForRunfile(plan);
  if (pids.web !== undefined) writeRunfile(runfilePath(plan.name), { ...info, webPid: pids.web });
  if (opts.json) return console.log(JSON.stringify({ action, ...info, webPid: pids.web, ...(fallback ? { portFallback: fallback } : {}) }));
  if (fallback) console.log(fallback);
  console.log(`${action}: pid ${info.pid}${pids.web !== undefined ? `, web pid ${pids.web}` : ""}`);
  console.log(`\n${describe(plan)}\n\nLogs: flock logs`);
  if (opts.open) openUrl(info.url);
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
      await up(resolvePlan(opts), opts);
      return;
    }
    case "down":
    case "stop": {
      const targets = opts.all ? listRunfiles() : [readRunfile(resolvePlan(opts).name)].filter((i): i is RunInfo => i !== undefined);
      for (const i of targets) await stop(i);
      if (opts.json) return console.log(JSON.stringify({ stopped: targets.map((i) => i.name) }));
      if (!targets.length) return console.log("not running");
      console.log(`stopped ${targets.map((i) => i.name).join(", ")}`);
      return;
    }
    case "restart": {
      const plan = resolvePlan(opts);
      const existing = readRunfile(plan.name);
      // Guard before stopping, and hand `up` the ports we just released — they are ours to retake.
      if (existing) guardPorts(plan, portsOf(existing));
      if (existing) await stop(existing);
      await up(plan, opts, existing ? "restarted" : undefined, existing ? portsOf(existing) : []);
      return;
    }
    case "status": {
      const plan = resolvePlan(opts);
      const all = listRunfiles();
      const mine = all.find((i) => i.name === plan.name);
      const others = all.filter((i) => i !== mine);
      const binary = { execPath: process.execPath, standalone: isStandalone(), version: version() };
      if (opts.json) return console.log(JSON.stringify({ here: mine ?? null, others, plan: { name: plan.name, mode: plan.mode, apiPort: plan.apiPort, webPort: plan.webPort, root: plan.root, db: plan.db, url: plan.url }, binary }));
      console.log(binaryLine());
      if (plan.portFallbackNote) console.log(plan.portFallbackNote);
      if (!mine) console.log(`not running here. Start with: flock up\n\n${describe(plan)}`);
      else console.log(`${statusLine(mine)}\n\n${describe(mine)}`);
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
      const list = urls(readRunfile(plan.name) ?? plan);
      return console.log(opts.json ? JSON.stringify(list) : list.join("\n"));
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
