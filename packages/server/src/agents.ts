/**
 * Spawned agents on the server (ADR 0029 §3): pushing unread inbox to the workers whose harness
 * cannot pull its own, and keeping a non-web `openUrl` off any client but this machine.
 */
import { randomUUID } from "node:crypto";
import { inboxMessage, type Agent, type Flock } from "@flock/core";

/** Puts `message` in front of `agent`'s session; false leaves its inbox unread for a later tick. */
export type DeliverToAgent = (agent: Agent, boardSlug: string, message: string) => Promise<boolean>;

/** A built-in Claude Code worker gets its inbox from its own supervisor, an externally launched one pulls; pushing here too would say everything twice. */
const PULLING_HARNESSES = new Set(["claude-code"]);

/**
 * Every `intervalMs`, while `leading()`, deliver each running push-only worker's unread inbox and
 * move its cursor past what was delivered. One tick at a time.
 */
export function startAgentDelivery(opts: { flock: Flock; deliver: DeliverToAgent; leading: () => boolean; intervalMs?: number }) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !opts.leading()) return;
    busy = true;
    try {
      await deliverUnread(opts.flock, opts.deliver);
    } catch (err) {
      console.error("[agents] delivery tick failed:", err);
    } finally {
      busy = false;
    }
  }, opts.intervalMs ?? 5_000);
  return { stop: () => clearInterval(timer) };
}

export async function deliverUnread(flock: Flock, deliver: DeliverToAgent) {
  for (const board of flock.listBoards()) {
    for (const agent of flock.agents(board.id)) {
      if (agent.status !== "running" || !agent.sessionKey || PULLING_HARNESSES.has(agent.harness) || agent.unread === 0) continue;
      const { events, through } = flock.inbox(board.id, agent.name, { since: agent.inboxSeq });
      if (events.length && !(await deliver(agent, board.slug, inboxMessage(board.slug, agent.name, events)))) continue;
      flock.markInboxRead(board.id, agent.name, through);
    }
  }
}

/** When push is off there is no push pump to follow, so take the same single-writer lease (ADR 0023) under its own owner. */
export function leaseClaimer(flock: Flock, ttlMs = 30_000): () => boolean {
  const owner = randomUUID();
  return () => flock.acquirePushLease({ owner, ttlMs, at: Date.now(), pid: process.pid });
}

/** An `openUrl` that is not a web link opens an app on this machine, so only a loopback client sees it. */
export function gateOpenUrl<T extends Pick<Agent, "openUrl">>(agent: T, loopback: boolean): T {
  if (!agent.openUrl || loopback || /^https?:\/\//i.test(agent.openUrl)) return agent;
  return { ...agent, openUrl: null };
}
