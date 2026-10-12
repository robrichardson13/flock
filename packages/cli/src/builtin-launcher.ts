/**
 * The built-in launcher (ADR 0029 §2): makes the worktree when asked, then starts the session
 * through its harness adapter. Claude Code runs headless under a detached supervisor.
 */
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FlockError } from "@flock/core";
import { cliCommand } from "./daemon.ts";
import type { LaunchRequest, LaunchResult } from "./launcher.ts";
import { flockHome } from "./paths.ts";
import type { SuperviseSpec } from "./supervise.ts";
import type { HarnessConfig } from "./update.ts";

/** Env a nested session must not inherit from whoever ran `flock spawn` (often a Claude Code session itself). */
const PARENT_SESSION_ENV = ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "FLOCK_SESSION", "FLOCK_ACTOR", "FLOCK_ACTOR_KIND", "FLOCK_MODEL", "FLOCK_EFFORT", "FLOCK_HARNESS"];

export async function launchBuiltin(request: LaunchRequest, opts: { dbPath: string; harness: HarnessConfig; boardId: string }): Promise<LaunchResult> {
  const cwd = request.worktree ? ensureWorktree(request.cwd, request.board, request.card) : request.cwd;
  if (request.harness !== "claude-code") throw new FlockError(`The built-in launcher cannot start ${request.harness} yet`, "invalid");
  return launchClaudeCode({ ...request, cwd }, opts);
}

/** A sibling worktree `<repo>-<board>-<card>` on branch `flock/<board>-<card>`, reused if it exists. */
function ensureWorktree(repo: string, board: string, card: number): string {
  const path = join(dirname(repo), `${basename(repo)}-${board}-${card}`);
  if (existsSync(path)) return path;
  const git = Bun.spawnSync(["git", "-C", repo, "worktree", "add", "-B", `flock/${board}-${card}`, path], { stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new FlockError(`git worktree add failed: ${git.stderr.toString().trim()}`);
  return path;
}

/** `claude -p` in stream-json mode with a session id minted here, so the run key is known before it starts. */
export function claudeArgs(opts: { bin: string; sessionId: string; model: string; effort: string | null; harness: HarnessConfig }): string[] {
  const args = [
    opts.bin, "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", opts.sessionId,
    "--model", opts.model,
    "--permission-mode", opts.harness.permissionMode ?? "bypassPermissions",
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.harness.allowedTools?.length) args.push("--allowedTools", ...opts.harness.allowedTools);
  return args;
}

function launchClaudeCode(request: LaunchRequest, opts: { dbPath: string; harness: HarnessConfig; boardId: string }): LaunchResult {
  const sessionId = crypto.randomUUID();
  const logDir = join(flockHome(), "agents", request.board, request.name);
  mkdirSync(logDir, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PARENT_SESSION_ENV.includes(k)) env[k] = v;
  Object.assign(env, request.env, { FLOCK_DB: opts.dbPath });
  const spec: SuperviseSpec = {
    dbPath: opts.dbPath,
    boardId: opts.boardId,
    name: request.name,
    card: request.card,
    argv: claudeArgs({ bin: opts.harness.bin ?? "claude", sessionId, model: request.model, effort: request.effort, harness: opts.harness }),
    cwd: request.cwd,
    prompt: request.prompt,
    logDir,
  };
  const out = openSync(join(logDir, "supervisor.out"), "a");
  const child = spawnProcess(cliCommand()[0]!, [...cliCommand().slice(1), "_supervise", JSON.stringify(spec)], {
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  return { sessionKey: `claude-code:${sessionId}`, pid: child.pid ?? null, openUrl: null, cwd: request.cwd };
}
