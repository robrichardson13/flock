/**
 * Liveness primitives for Claude Code (ADR 0023 §4): find the pid behind a session, check it is
 * alive, and guard against pid reuse by comparing `procStart` — the pid file's is UTC, `ps`'s is
 * local, and both are second-precision human-formatted timestamps, not epoch numbers.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_FILES_GLOBBED, DEFAULT_PROC_CHECK_TIMEOUT_MS, PROC_START_TOLERANCE_MS } from "./limits.ts";

export interface ClaudeSessionPidFile {
  pid: number;
  sessionId: string;
  cwd?: string;
  /** `ps -o lstart=`-style timestamp, written in UTC. */
  procStart?: string;
  /** The harness's own raw word: busy/idle/shell/… Never a heartbeat — see ADR 0023 §4 rule 1. */
  status?: string;
}

/** Find the `~/.claude/sessions/<pid>.json` naming this session id, or null if none does.
 * Bounded by `limit` files; never throws on a missing directory or an unreadable/malformed file. */
export async function findPidFileForSession(home: string, sessionId: string, limit = DEFAULT_MAX_FILES_GLOBBED): Promise<ClaudeSessionPidFile | null> {
  const dir = join(home, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, limit)) {
    const parsed = await readPidFile(join(dir, name));
    if (parsed?.sessionId === sessionId) return parsed;
  }
  return null;
}

async function readPidFile(path: string): Promise<ClaudeSessionPidFile | null> {
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsePidFile(json);
  } catch {
    return null;
  }
}

function parsePidFile(json: unknown): ClaudeSessionPidFile | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.pid !== "number" || typeof obj.sessionId !== "string") return null;
  return {
    pid: obj.pid,
    sessionId: obj.sessionId,
    cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
    procStart: typeof obj.procStart === "string" ? obj.procStart : undefined,
    status: typeof obj.status === "string" ? obj.status : undefined,
  };
}

/** `process.kill(pid, 0)`: alive if it succeeds or fails with EPERM (belongs to someone else,
 * still alive). Mirrors `isAlive()` in `packages/cli/src/procs.ts`, reimplemented here so this
 * package never depends on the CLI. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Does `ps`'s own `lstart` for `pid` match the pid file's `procStart`? `true`/`false` is a
 * confident answer; `null` means the check could not be made (no such pid, `ps` unavailable, the
 * timeout fired, or either timestamp failed to parse) — callers must not treat `null` as a match.
 */
export async function procStartMatches(pid: number, fileProcStartUtc: string, timeoutMs = DEFAULT_PROC_CHECK_TIMEOUT_MS): Promise<boolean | null> {
  const lstart = await psLstart(pid, timeoutMs);
  if (!lstart) return null;
  const fileMs = parseAsctime(fileProcStartUtc, "utc");
  const psMs = parseAsctime(lstart, "local");
  if (fileMs === null || psMs === null) return null;
  return Math.abs(fileMs - psMs) <= PROC_START_TOLERANCE_MS;
}

async function psLstart(pid: number, timeoutMs: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ASCTIME_RE = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/** Parse a `ps -o lstart=`-shaped timestamp ("Fri Sep 11 23:03:19 2026") as either UTC or local
 * time, returning epoch ms, or null if it does not match the expected shape. */
function parseAsctime(s: string, zone: "utc" | "local"): number | null {
  const m = ASCTIME_RE.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month === -1) return null;
  const [, , day, hour, minute, second, year] = m;
  const parts = [Number(year), month, Number(day), Number(hour), Number(minute), Number(second)] as const;
  return zone === "utc" ? Date.UTC(...parts) : new Date(...parts).getTime();
}
