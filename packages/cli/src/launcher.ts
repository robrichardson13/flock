/**
 * The launcher contract (ADR 0029 §2): `launch` starts a worker session, optional `deliver`
 * puts a message in front of one. The built-in launcher is one adapter per harness; a
 * `launcher` executable in config replaces it, speaking the same JSON on stdin/stdout.
 */
import { FlockError } from "@flock/core";
import type { FlockConfig } from "./update.ts";

export const HARNESSES = ["claude-code", "codex", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface LaunchRequest {
  op: "launch";
  board: string;
  card: number;
  name: string;
  harness: Harness;
  model: string;
  effort: string | null;
  /** The board's project directory; with `worktree`, the repository to branch from. */
  cwd: string;
  worktree: boolean;
  prompt: string;
  /** Environment the session should run with; a launcher that cannot pass env relies on the prompt. */
  env: Record<string, string>;
}

export interface LaunchResult {
  sessionKey: string | null;
  pid: number | null;
  openUrl: string | null;
  /** Where the session actually runs: the worktree when one was made. */
  cwd: string;
}

export interface DeliverRequest {
  op: "deliver";
  board: string;
  name: string;
  harness: Harness;
  sessionKey: string;
  message: string;
}

/** `--harness` wins; otherwise `gpt-*`/`o<digit>*` is codex, `opencode:<p>/<m>` opencode, the rest Claude Code. */
export function harnessFor(model: string, explicit?: string): Harness {
  if (explicit) {
    if (!(HARNESSES as readonly string[]).includes(explicit)) throw new FlockError(`Unknown harness "${explicit}". One of: ${HARNESSES.join(", ")}`, "invalid");
    return explicit as Harness;
  }
  if (model.startsWith("opencode:")) return "opencode";
  if (/^(gpt-|o\d)/.test(model)) return "codex";
  return "claude-code";
}

/** Run an external launcher with one request, and parse its one JSON reply. */
export async function callExternal(launcher: string, request: LaunchRequest | DeliverRequest): Promise<unknown> {
  const proc = Bun.spawn([launcher], { stdin: new Blob([JSON.stringify(request)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new FlockError(`launcher ${launcher} ${request.op} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new FlockError(`launcher ${launcher} ${request.op} did not print JSON: ${stdout.trim().slice(0, 200)}`);
  }
}

export function parseLaunchResult(raw: unknown, fallbackCwd: string): LaunchResult {
  if (!raw || typeof raw !== "object") throw new FlockError("launcher reply is not a JSON object");
  const o = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    sessionKey: text(o.sessionKey),
    pid: typeof o.pid === "number" && Number.isInteger(o.pid) ? o.pid : null,
    openUrl: text(o.openUrl),
    cwd: text(o.cwd) ?? fallbackCwd,
  };
}

/** Which launcher `flock spawn` uses: the configured executable, else the built-in one. */
export function launcherName(config: FlockConfig): string {
  return config.launcher ?? "builtin";
}
