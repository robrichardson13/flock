/**
 * An actor's inbox (ADR 0029 §3): the board events addressed to it. Derived from `events` on
 * read, like telemetry, so it covers history and needs no table of its own.
 */
import type { Database } from "bun:sqlite";
import { mentionsActor } from "./mentions.ts";
import type { Event, EventType } from "./types.ts";

/** The only event types an inbox can hold; the query filters on them before the rule runs. */
export const INBOX_EVENT_TYPES: EventType[] = ["message.posted", "comment.posted", "card.answered", "decision.recorded"];

/**
 * Whether `event` belongs in `actor`'s inbox, given the cards that actor holds right now.
 * Never its own writes. A mention of it or `@all`, anyone else's comment on a card it holds,
 * the answer to a question it asked, and every new decision.
 */
export function isForActor(event: Event, actor: string, heldCards: ReadonlySet<number>): boolean {
  if (event.actor.toLowerCase() === actor.toLowerCase()) return false;
  const body = typeof event.data.body === "string" ? event.data.body : "";
  switch (event.type) {
    case "message.posted":
      return mentionsActor(body, actor);
    case "comment.posted":
      return mentionsActor(body, actor) || (event.cardNum !== null && heldCards.has(event.cardNum));
    case "card.answered":
      return typeof event.data.askedBy === "string" && event.data.askedBy.toLowerCase() === actor.toLowerCase();
    case "decision.recorded":
      return true;
    default:
      return false;
  }
}

/** Card numbers `actor` is the assignee of on one board. */
export function heldCardNums(db: Database, boardId: string, actor: string): Set<number> {
  const rows = db.query("SELECT num FROM cards WHERE board_id = ? AND assignee = ? COLLATE NOCASE").all(boardId, actor) as { num: number }[];
  return new Set(rows.map((r) => r.num));
}
