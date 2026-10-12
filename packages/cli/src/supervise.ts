/**
 * The process behind a built-in Claude Code worker (ADR 0029 §2, §5). It owns the session's
 * stream-json stdin, so the session stays alive between turns and wakes on its own Monitor,
 * and it closes that stdin once the worker is off duty and its inbox has gone quiet.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED_STATUSES, Flock, type Card } from "@flock/core";

/** How long an off-duty worker's inbox must stay quiet before it is retired. */
export const QUIET_MS = 10 * 60_000;
const POLL_MS = 30_000;
/** After stdin closes, how long the session gets to finish its turn before it is killed. */
const GRACE_MS = 2 * 60_000;

export interface SuperviseSpec {
  dbPath: string;
  boardId: string;
  name: string;
  card: number;
  argv: string[];
  cwd: string;
  prompt: string;
  logDir: string;
}

/** Off duty: its card is closed, or it claimed the card once and no longer holds it. */
export function isOffDuty(card: Pick<Card, "status" | "assignee">, name: string, claimedOnce: boolean): boolean {
  if (CLOSED_STATUSES.includes(card.status)) return true;
  return claimedOnce && card.assignee?.toLowerCase() !== name.toLowerCase();
}

export function shouldRetire(offDutySince: number | null, lastInboxAt: number, now: number): boolean {
  if (offDutySince === null) return false;
  return now - Math.max(offDutySince, lastInboxAt) >= QUIET_MS;
}

export async function supervise(spec: SuperviseSpec) {
  const log = (line: string) => appendFileSync(join(spec.logDir, "supervisor.log"), `${new Date().toISOString()} ${line}\n`);
  const flock = new Flock(spec.dbPath);
  const child = Bun.spawn(spec.argv, {
    cwd: spec.cwd,
    stdin: "pipe",
    stdout: Bun.file(join(spec.logDir, "session.jsonl")),
    stderr: Bun.file(join(spec.logDir, "session.err")),
  });
  log(`started pid ${child.pid}: ${spec.argv.join(" ")}`);
  // Without this a `kill <supervisor>` orphans the session and leaves the row "running".
  process.on("SIGTERM", () => child.kill());
  child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: spec.prompt } })}\n`);
  await child.stdin.flush();

  let exited = false;
  child.exited.then((code) => {
    exited = true;
    log(`session exited ${code}`);
  });
  let claimedOnce = false;
  let offDutySince: number | null = null;
  let lastInboxAt = Date.now();
  let inboxCursor = flock.lastSeq(spec.boardId);

  while (!exited) {
    await Promise.race([Bun.sleep(POLL_MS), child.exited]);
    if (exited) break;
    const card = flock.card(spec.boardId, spec.card);
    if (card.assignee?.toLowerCase() === spec.name.toLowerCase()) claimedOnce = true;
    const inbox = flock.inbox(spec.boardId, spec.name, { since: inboxCursor });
    inboxCursor = inbox.through;
    if (inbox.events.length) lastInboxAt = Date.now();
    offDutySince = isOffDuty(card, spec.name, claimedOnce) ? (offDutySince ?? Date.now()) : null;
    if (shouldRetire(offDutySince, lastInboxAt, Date.now())) {
      log("off duty and inbox quiet: closing stdin");
      child.stdin.end();
      await Promise.race([child.exited, Bun.sleep(GRACE_MS)]);
      if (!exited) child.kill();
      break;
    }
  }
  await child.exited;
  // A re-spawn of the same name owns the row now; only retire the row this process still owns.
  if (flock.agent(spec.boardId, spec.name).pid === process.pid) flock.updateAgent(spec.boardId, spec.name, { status: "exited" });
  flock.close();
}
