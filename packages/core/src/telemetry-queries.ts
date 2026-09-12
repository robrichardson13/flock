/**
 * The read side of harness telemetry (ADR 0026): group-bys over `events`, exactly like
 * `boardActors` already does — no join table, no new notion of identity. See `telemetry.ts` for
 * the store this joins against.
 */
import type { Database } from "bun:sqlite";
import { rowToReading } from "./telemetry.ts";
import type { HarnessSessionRow, HarnessSessionTelemetry, SessionReading, CardDuration } from "./telemetry-types.ts";

/** Every `harness_sessions` row for a set of keys, keyed by `key`. Bun's bind list is bounded by
 * the caller (a card's or actor's own distinct session count, never unbounded). */
function readRows(db: Database, keys: string[]): Map<string, HarnessSessionRow> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.query(`SELECT * FROM harness_sessions WHERE key IN (${placeholders})`).all(...keys) as HarnessSessionRow[];
  return new Map(rows.map((r) => [r.key, r]));
}

type SessionEventGroup = { session: string; actor: string; model: string | null };

/**
 * The events group-by ADR 0026 §1 describes: one row per distinct session key that wrote on
 * this card, with the actor and declared model from that session's most recent write here.
 * SQLite takes the bare `actor`/`model` columns from the row that produced `MAX(seq)`, the same
 * trick `boardActors` already relies on.
 */
function sessionGroupsForCard(db: Database, boardId: string, cardNum: number): SessionEventGroup[] {
  return db
    .query(
      `SELECT session, actor, model, MAX(seq) AS seq
       FROM events WHERE board_id = ? AND card_num = ? AND session IS NOT NULL
       GROUP BY session`,
    )
    .all(boardId, cardNum) as SessionEventGroup[];
}

/** Other card numbers this session key wrote on, anywhere on this board — a session is a run,
 * not a per-board notion, but "alsoWorked" is only ever shown next to a card on one board. */
function alsoWorkedFor(db: Database, boardId: string, session: string, excludeCardNum: number): number[] {
  const rows = db
    .query(
      `SELECT DISTINCT card_num AS num FROM events
       WHERE board_id = ? AND session = ? AND card_num IS NOT NULL AND card_num != ?
       ORDER BY num`,
    )
    .all(boardId, session, excludeCardNum) as { num: number }[];
  return rows.map((r) => r.num);
}

function toTelemetry(group: SessionEventGroup, row: HarnessSessionRow | undefined, alsoWorked: number[]): HarnessSessionTelemetry {
  const base: SessionReading = row ? rowToReading(row) : { key: group.session, sessionId: group.session, observedAt: "" };
  return {
    ...base,
    actor: group.actor,
    ...(group.model ? { declaredModel: group.model } : {}),
    alsoWorked,
  };
}

/**
 * Every harness session that worked one card: a group-by over `events` joined against whatever
 * `harness_sessions` knows for each key. A session with no stored row yet (a reader has not run)
 * still appears, with only `key`/`sessionId`/`actor`/`declaredModel` filled in — the link exists
 * the moment an event carries the session, before any numbers do.
 */
export function sessionsForCard(db: Database, boardId: string, cardNum: number): HarnessSessionTelemetry[] {
  const groups = sessionGroupsForCard(db, boardId, cardNum);
  if (groups.length === 0) return [];
  const rows = readRows(db, groups.map((g) => g.session));
  return groups.map((g) => toTelemetry(g, rows.get(g.session), alsoWorkedFor(db, boardId, g.session, cardNum)));
}

/**
 * Every harness session one actor ran on one board. Same shape as `sessionsForCard`; a caller
 * sums `costUsd`/`toolCalls` over the returned rows for a totals strip, keyed by each entry's
 * own `key` so a session that touched several cards is not double counted.
 */
export function sessionsForActor(db: Database, boardId: string, actor: string): HarnessSessionTelemetry[] {
  const groups = db
    .query(
      `SELECT session, actor, model, card_num, MAX(seq) AS seq
       FROM events WHERE board_id = ? AND actor = ? AND session IS NOT NULL
       GROUP BY session, card_num`,
    )
    .all(boardId, actor) as (SessionEventGroup & { card_num: number | null })[];
  if (groups.length === 0) return [];

  // Collapse per (session, card_num) rows into one per session: keep the freshest declared
  // model and union alsoWorked from every card_num bucket that session touched.
  const bySession = new Map<string, { model: string | null; cards: Set<number> }>();
  for (const g of groups) {
    const entry = bySession.get(g.session) ?? { model: null, cards: new Set<number>() };
    entry.model = g.model ?? entry.model;
    if (g.card_num !== null) entry.cards.add(g.card_num);
    bySession.set(g.session, entry);
  }
  const keys = [...bySession.keys()];
  const rows = readRows(db, keys);
  return keys.map((key) => {
    const { model, cards } = bySession.get(key)!;
    const group: SessionEventGroup = { session: key, actor, model };
    return toTelemetry(group, rows.get(key), [...cards].sort((a, b) => a - b));
  });
}

/**
 * flock's own duration for a card: its most recent `card.claimed` to its most recent
 * `card.closed`, read off the events table alone — no harness needed, always available. A card
 * never claimed, or still open, reports the ends it has and `ms: null`.
 */
export function cardDuration(db: Database, boardId: string, cardNum: number): CardDuration {
  const claimed = db
    .query(`SELECT created_at FROM events WHERE board_id = ? AND card_num = ? AND type = 'card.claimed' ORDER BY seq ASC LIMIT 1`)
    .get(boardId, cardNum) as { created_at: string } | null;
  const closed = db
    .query(`SELECT created_at FROM events WHERE board_id = ? AND card_num = ? AND type = 'card.closed' ORDER BY seq DESC LIMIT 1`)
    .get(boardId, cardNum) as { created_at: string } | null;
  const claimedAt = claimed?.created_at ?? null;
  const closedAt = closed?.created_at ?? null;
  const ms = claimedAt && closedAt ? Date.parse(closedAt) - Date.parse(claimedAt) : null;
  return { claimedAt, closedAt, ms: ms !== null && ms >= 0 ? ms : null };
}
