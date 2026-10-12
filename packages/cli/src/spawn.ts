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
    prompt: workerPrompt(board.slug, card, opts.name),
    env: {
      FLOCK_ACTOR: opts.name,
      FLOCK_ACTOR_KIND: "agent",
      FLOCK_MODEL: opts.model,
      ...(opts.effort ? { FLOCK_EFFORT: opts.effort } : {}),
    },
  };
  const launcher = launcherName(config);
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

/**
 * What a worker is told first. Every command names the board and `--as`, because a launcher
 * that cannot pass env, or a worker that `cd`s, must still land its writes in the right place.
 */
export function workerPrompt(board: string, card: Pick<Card, "num" | "title">, name: string): string {
  return `You are ${name}, a flock worker on board ${board}. Your job is card #${card.num}: ${card.title}

1. Run \`flock handoff ${board} --as ${name}\` and follow it. Pass \`--as ${name}\` on every flock command.
2. Watch your inbox for the whole session: arm a persistent Monitor on \`flock inbox ${board} --as ${name} --follow --json\`.
3. Claim the card (\`flock claim ${board} ${card.num} --as ${name}\`), work it, and close it with \`flock done\`, or \`flock release\` it if you cannot finish.

After the card is closed or released, keep the Monitor armed and answer what still reaches you; your session is ended for you once your inbox goes quiet.`;
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
