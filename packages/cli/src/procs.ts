import { spawnSync } from "node:child_process";

/**
 * The process table, for what a runfile cannot see: a dev child of this checkout that is still
 * running after its runfile is gone (the API died and the runfile was pruned, leaving vite behind).
 * See ADR 0020.
 */

export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface Stray {
  pid: number;
  kind: "api" | "web";
  port?: number;
}

const PS_TIMEOUT_MS = 2_000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
const POLL_MS = 100;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else: still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM every pid, then SIGKILL whatever is still alive once `graceMs` is up. */
export async function terminate(pids: number[], graceMs: number): Promise<void> {
  for (const pid of pids) signal(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(isAlive)) await Bun.sleep(POLL_MS);
  for (const pid of pids.filter(isAlive)) signal(pid, "SIGKILL");
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig);
  } catch (e) {
    // Already gone between the liveness check and the signal: exactly the outcome we wanted.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

/** `ps -axo pid=,ppid=,command=` output, one row per process. Lines that don't parse are skipped. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n").slice(0, MAX_ROWS)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** Every process on the machine. Empty (with one stderr line) when `ps` can't be run. */
export function listProcesses(): ProcRow[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER });
  if (r.error || r.status !== 0) {
    console.error(`flock: could not list processes (${r.error?.message ?? `ps exited ${r.status}`}); skipping stray-process cleanup.`);
    return [];
  }
  return parsePs(r.stdout);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pure: the processes that are this checkout's own dev children but that no live runfile owns.
 *
 * Three conditions, all required. The command runs this checkout's `main.ts serve` or its vite
 * (the absolute path `up` spawns, so another checkout or a worktree nested inside this one never
 * matches). The parent is pid 1: `up` spawns detached and exits, so a daemon child is always
 * reparented, while a `bun x vite` or `flock serve` someone runs by hand still has its shell as
 * parent and is left alone. And its pid isn't in any live runfile, which is what makes it a stray
 * rather than a running daemon.
 */
export function findStrays(rows: ProcRow[], root: string, owned: ReadonlySet<number>): Stray[] {
  const r = escapeRegExp(root);
  const api = new RegExp(`(^|\\s)${r}/packages/cli/src/main\\.ts serve(\\s|$)`);
  const web = new RegExp(`(^|\\s)${r}(/packages/web)?/node_modules/\\.bin/vite(\\s|$)`);
  const strays: Stray[] = [];
  for (const row of rows) {
    if (row.ppid !== 1 || owned.has(row.pid)) continue;
    const kind = api.test(row.command) ? "api" : web.test(row.command) ? "web" : undefined;
    if (!kind) continue;
    const port = /\s--port\s+(\d+)/.exec(row.command)?.[1];
    strays.push({ pid: row.pid, kind, ...(port ? { port: Number(port) } : {}) });
  }
  return strays;
}

export function strayLabel(s: Stray): string {
  return `pid ${s.pid} (${s.kind}${s.port ? ` :${s.port}` : ""})`;
}
