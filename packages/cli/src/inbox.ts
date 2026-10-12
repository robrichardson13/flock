import type { Event, Flock } from "@flock/core";

/** How far back a bare `flock inbox` looks, in board events. */
const RECENT_WINDOW = 500;

/**
 * `flock inbox`: print the events addressed to `actor`, then with `follow` keep printing new
 * ones until `timeoutMs` (0 = forever). A Claude Code worker arms a Monitor on the follow form.
 */
export async function runInbox(
  flock: Flock,
  boardRef: string,
  actor: string,
  opts: { since?: number; follow: boolean; timeoutMs: number },
  print: (events: Event[]) => void,
) {
  const boardId = flock.board(boardRef).id;
  const latest = flock.lastSeq(boardId);
  let since = opts.since ?? (opts.follow ? latest : Math.max(0, latest - RECENT_WINDOW));
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    const { events, through } = flock.inbox(boardId, actor, { since });
    since = through;
    print(events);
    if (!opts.follow || Date.now() >= deadline) return;
    if (events.length === 0) await flock.waitForEvents({ boardId, since, timeoutMs: Math.min(30_000, Math.max(0, deadline - Date.now())) });
  }
}
