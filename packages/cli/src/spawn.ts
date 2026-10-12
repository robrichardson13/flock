/**
 * `flock spawn` and `flock team` (ADR 0029 §1): start a top-level worker session on a card
 * through the configured launcher, record it, and list the board's workers.
 */
import { FlockError, type Actor, type Agent, type Card, type Flock } from "@flock/core";
import { launchBuiltin } from "./builtin-launcher.ts";
import { callExternal, harnessFor, launcherName, parseLaunchResult, type LaunchRequest, type LaunchResult } from "./launcher.ts";
import { readConfig } from "./update.ts";

export interface SpawnOptions {
  name: string;
  model: string;
  effort?: string;
  harness?: string;
  worktree: boolean;
  dbPath: string;
}

export async function spawnWorker(flock: Flock, boardRef: string, cardRef: string, opts: SpawnOptions): Promise<Agent> {
  const board = flock.board(boardRef);
  if (!board.project) throw new FlockError(`Board "${board.slug}" has no project directory to run a worker in. Set one with \`flock board edit --project DIR\`.`, "invalid");
  const card = flock.card(board.id, cardRef);
  const config = readConfig();
  const harness = harnessFor(opts.model, opts.harness);
  const launcher = launcherName(config);
  const request: LaunchRequest = {
    op: "launch",
    board: board.slug,
    card: card.num,
    name: opts.name,
    harness,
    model: opts.model,
    effort: opts.effort ?? null,
    cwd: board.project,
    worktree: opts.worktree,
    prompt: workerPrompt(board.slug, card, opts.name, { pushed: isPushed(launcher, harness) }),
    env: {
      FLOCK_ACTOR: opts.name,
      FLOCK_ACTOR_KIND: "agent",
      FLOCK_MODEL: opts.model,
      ...(opts.effort ? { FLOCK_EFFORT: opts.effort } : {}),
    },
  };
  const result: LaunchResult = config.launcher
    ? parseLaunchResult(await callExternal(config.launcher, request), request.cwd)
    : await launchBuiltin(request, { dbPath: opts.dbPath, harness: config.harnesses?.[harness] ?? {}, boardId: board.id });
  if (opts.worktree && result.cwd !== board.project) flock.linkDir(board.id, result.cwd, card.num);
  const spawner: Actor = { name: opts.name, kind: "agent", harness, model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}) };
  return flock.registerAgent(spawner, board.id, {
    name: opts.name,
    cardNum: card.num,
    harness,
    model: opts.model,
    effort: opts.effort ?? null,
    sessionKey: result.sessionKey,
    openUrl: result.openUrl,
    cwd: result.cwd,
    pid: result.pid,
    launcher,
  });
}

/** A built-in Claude Code worker's supervisor writes its inbox into the session (`deliverInbox`). */
export function isPushed(launcher: string, harness: string): boolean {
  return launcher === "builtin" && harness === "claude-code";
}

/**
 * What a worker is told first. Every command names the board and `--as`, because a launcher
 * that cannot pass env, or a worker that `cd`s, must still land its writes in the right place.
 */
export function workerPrompt(board: string, card: Pick<Card, "num" | "title">, name: string, opts: { pushed: boolean }): string {
  const listen = opts.pushed
    ? "2. Messages addressed to you on the board arrive in this session on their own, as a turn starting `New on flock board`. Do not arm a Monitor on your inbox."
    : `2. Watch your inbox for the whole session: arm a Monitor (\`timeout_ms: 1800000\`) on \`flock inbox ${board} --as ${name} --follow --json\`. A Monitor lives at most 30 minutes; every time it expires, re-arm it in that same turn.`;
  const after = opts.pushed ? "answer what still reaches you" : "keep the Monitor re-armed and answer what still reaches you";
  return `You are ${name}, a flock worker on board ${board}. Your job is card #${card.num}: ${card.title}

1. Run \`flock handoff ${board} --as ${name}\` and follow it. Pass \`--as ${name}\` on every flock command.
${listen}
3. Claim the card (\`flock claim ${board} ${card.num} --as ${name}\`), work it, and close it with \`flock done\`, or \`flock release\` it if you cannot finish.

After the card is closed or released, ${after}; your session is ended for you once your inbox goes quiet.`;
}

/** Whether a worker's process is still there. Only meaningful on the machine that spawned it. */
export function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function printTeam(team: (Agent & { unread: number })[]) {
  if (team.length === 0) return console.log("No spawned agents on this board. Start one with `flock spawn <card> --as <name> --model <m>`.");
  for (const a of team) {
    const status = a.status === "running" && a.pid !== null && !isAlive(a.pid) ? "gone" : a.status;
    const card = a.cardNum === null ? "" : `#${a.cardNum}`;
    const unread = a.unread ? `  ${a.unread} unread` : "";
    const open = a.openUrl ? `  ${a.openUrl}` : "";
    console.log(`${a.name}  ${card}  ${a.harness} ${a.model ?? ""}  ${status}${unread}${open}`);
  }
}
