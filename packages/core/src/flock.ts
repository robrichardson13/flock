import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ATTACHMENT_MIMES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, ORPHAN_TTL_MS, normalizeMime, sanitizeAttachmentName, sniffImageMime } from "./attachments.ts";
import { openDatabase, readStamp, SCHEMA_VERSION, type OpenOptions } from "./db.ts";
import { setTaskChecked, taskItems } from "./tasks.ts";
import type { PushSubscriptionInput, PushSubscriptionRecord } from "./notify.ts";
import { assertDeclarableLevel, resolveNotifySettingsFields, clampSettledThreshold, type NotifySettings, type NotifySettingsFields } from "./notify-levels.ts";
import { upsertSessionReading, type SessionReading } from "./telemetry.ts";
import { cardDuration as queryCardDuration, sessionsForActor as querySessionsForActor, sessionsForCard as querySessionsForCard } from "./telemetry-queries.ts";
import type { CardDuration, HarnessSessionTelemetry } from "./telemetry.ts";
import {
  ACTOR_CARD_ROLES,
  CARD_STATUSES,
  CLOSED_STATUSES,
  FlockError,
  type Actor,
  type ActorCard,
  type ActorCardRole,
  type ActorKind,
  type ActorProfile,
  type Attachment,
  type Board,
  type BoardState,
  type BoardSummary,
  type Card,
  type CardStatus,
  type Comment,
  type CommentKind,
  type Decision,
  type DecisionSelector,
  type DoingCard,
  type Event,
  type EventType,
  type Message,
  type CommentReactionResult,
  type Reaction,
  type ReactionResult,
  type TeamMember,
} from "./types.ts";

const now = () => new Date().toISOString();

/**
 * Which event types say something about an actor's relationship to a card, and what they
 * say. Everything absent (a move, an edit, a blocker change) still counts as a touch and
 * still lists the card; it just has no role of its own to add.
 */
const ROLE_OF_EVENT: Partial<Record<EventType, ActorCardRole>> = {
  "card.created": "created",
  "card.claimed": "claimed",
  "comment.posted": "commented",
  "card.asked": "commented",
  "card.answered": "commented",
  "card.closed": "resolved",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function shortId(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** How a channel message is spelled everywhere a human or an agent sees it: `m7`. See ADR 0018. */
export function messageRef(num: number): string {
  return `m${num}`;
}

/**
 * How a card comment is spelled everywhere a human or an agent sees it: `4.2`, the second
 * comment on card #4. A comment is numbered within its card, not the board. See ADR 0019.
 */
export function commentRef(cardNum: number, num: number): string {
  return `${cardNum}.${num}`;
}

/**
 * The inverse of `commentRef`, for a CLI or a route that takes one token: `"4.2"` (or `"#4.2"`)
 * becomes `{ cardNum: 4, num: 2 }`. Null when the token is not a comment ref, so a caller can
 * fall through to whatever else it accepts.
 */
export function parseCommentRef(ref: string): { cardNum: number; num: number } | null {
  const m = /^#?(\d+)\.(\d+)$/.exec((ref ?? "").trim());
  if (!m) return null;
  const cardNum = Number(m[1]);
  const num = Number(m[2]);
  return cardNum > 0 && num > 0 ? { cardNum, num } : null;
}

/** Longest emoji accepted, in code points: enough for a flag or a ZWJ family, short of a sentence. */
export const MAX_EMOJI_LENGTH = 12;

/**
 * A reaction is a short pictograph, not free text. Core does not police *which* emoji — new ones
 * ship faster than any table of them — it only rejects what would turn the reaction row into a
 * chat: empty strings, whitespace, and anything long.
 */
export function normalizeEmoji(raw: string): string {
  const emoji = (raw ?? "").trim();
  if (!emoji) throw new FlockError("a reaction needs an emoji");
  if (/\s/.test(emoji)) throw new FlockError("a reaction emoji cannot contain whitespace");
  if ([...emoji].length > MAX_EMOJI_LENGTH) throw new FlockError(`a reaction emoji is at most ${MAX_EMOJI_LENGTH} code points`);
  return emoji;
}

/** Longest message gist carried on a reaction event, in characters. */
const GIST_LENGTH = 120;

/** Ceiling on a push lease ttl (ADR 0023). A stale lease this long would mute push for a minute;
 *  nothing legitimate asks for more, and a typo must not silence notifications for hours. */
const MAX_PUSH_LEASE_TTL_MS = 60_000;

/**
 * A one-line precis of a message, for event consumers: whitespace collapsed, truncated, and
 * standing in for the body when the message is nothing but images.
 */
export function messageGist(message: Pick<Message, "body" | "attachments">): string {
  return gistOf(message);
}

/** The same precis for a card comment, which carries a body and images the same way. */
export function commentGist(comment: Pick<Comment, "body" | "attachments">): string {
  return gistOf(comment);
}

function gistOf(it: { body: string; attachments: unknown[] }): string {
  const body = it.body.replace(/\s+/g, " ").trim();
  if (body) return body.length > GIST_LENGTH ? `${body.slice(0, GIST_LENGTH - 1)}\u2026` : body;
  const n = it.attachments.length;
  return n === 0 ? "" : n === 1 ? "(image)" : `(${n} images)`;
}

/**
 * The `data` of `message.reacted` / `message.unreacted`. Everything a listener tailing
 * `flock log --follow --json` needs to act — who was reacted to, with what, and roughly what
 * they said — without a second lookup.
 */
function reactionEventData(emoji: string, message: Message): Record<string, unknown> {
  return {
    emoji,
    num: message.num,
    ref: messageRef(message.num),
    messageAuthor: message.author,
    messageAuthorKind: message.authorKind,
    gist: messageGist(message),
    count: message.reactions.find((r) => r.emoji === emoji)?.count ?? 0,
  };
}

/**
 * The `data` of `comment.reacted` / `comment.unreacted`, the comment twin of the message shape
 * above: the card the comment is on, the comment's ref, who wrote it, and a gist of what it
 * said. The event itself already carries the card number, like every comment event.
 */
function commentReactionEventData(emoji: string, comment: Comment): Record<string, unknown> {
  return {
    emoji,
    card: comment.cardNum,
    num: comment.num,
    ref: commentRef(comment.cardNum, comment.num),
    commentAuthor: comment.author,
    commentAuthorKind: comment.authorKind,
    gist: commentGist(comment),
    count: comment.reactions.find((r) => r.emoji === emoji)?.count ?? 0,
  };
}

/** The one sentence a claim on a held card fails with, everywhere. */
export function holdConflictMessage(c: Pick<Card, "num" | "heldBy" | "holdReason">): string {
  const who = c.heldBy ? ` by ${c.heldBy}` : "";
  const why = c.holdReason ? `: ${c.holdReason}` : "";
  return `#${c.num} is on hold${who}${why}. Lift it with \`flock unhold ${c.num}\` — force does not override a hold`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "board";
}

type BoardRow = {
  id: string; slug: string; title: string; body: string; project: string | null; status: string; created_at: string; updated_at: string;
};
type CardRow = {
  id: string; board_id: string; num: number; title: string; body: string; status: CardStatus; assignee: string | null;
  labels: string; question: string | null; question_by: string | null; position: number; created_by: string;
  created_at: string; updated_at: string; closed_at: string | null;
  held_at: string | null; held_by: string | null; hold_reason: string | null;
};
type CommentRow = { id: string; card_id: string; num: number; author: string; author_kind: string; kind: string; body: string; created_at: string };
type MessageRow = { id: string; board_id: string; num: number; author: string; author_kind: string; body: string; created_at: string };
type AttachmentRow = {
  id: string; board_id: string; message_id: string | null; comment_id: string | null; author: string; author_kind: string;
  mime: string; name: string | null; size: number; sha256: string; width: number | null; height: number | null; created_at: string;
};
type DecisionRow = {
  id: string; board_id: string; card_num: number | null; gist: string; author: string; created_at: string;
  num: number; archived_at: string | null; archived_by: string | null; archive_reason: string | null; superseded_by: number | null;
};
type EventRow = {
  seq: number; board_id: string; actor: string; actor_kind: string; type: string; card_num: number | null; data: string; created_at: string;
  harness: string | null; model: string | null; effort: string | null; session: string | null;
};
type PushSubscriptionRow = {
  id: string; endpoint: string; p256dh: string; auth: string; actor: string; actor_kind: string;
  board_id: string | null; user_agent: string | null; created_at: string; last_used_at: string | null;
};
type NotifySettingsRow = {
  actor: string; board_id: string; needs_me: number | null; review: number | null; info: number | null;
  settled: number | null; settled_after_ms: number | null; updated_at: string;
};

/** SQLite has no boolean type; a stored flag is 0/1/NULL, and NULL always means "inherit". */
function boolFromCol(v: number | null): boolean | null {
  return v === null ? null : v === 1;
}
function colFromBool(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}
/** `undefined` (field absent from a patch) is handled by the caller; this only clamps a real value. */
function clampedOrNull(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : clampSettledThreshold(v);
}

export interface CardFilter {
  status?: CardStatus | CardStatus[];
  assignee?: string;
  label?: string;
  /** Only open, unblocked, unheld, unclaimed cards. */
  frontier?: boolean;
  open?: boolean;
  /** true: only held cards. false: only unheld. Omitted: both. */
  held?: boolean;
}

export interface NewCard {
  title: string;
  body?: string;
  labels?: string[];
  blockedBy?: number[];
  assignee?: string | null;
  status?: CardStatus;
}

export interface CardPatch {
  title?: string;
  body?: string;
  addLabels?: string[];
  removeLabels?: string[];
  position?: number;
}

/**
 * The whole domain behind one SQLite file. Every write is attributed to an actor and
 * appends to the board's event log. Safe to open from many processes at once (WAL).
 */
export class Flock {
  readonly db: Database;
  /**
   * Set when the database is stamped newer than this build and was opened with `allowNewer`
   * (ADR 0021). Core never prints; the CLI and server turn this into one stderr line.
   */
  readonly schemaSkew?: { dbVersion: number; binaryVersion: number };

  constructor(pathOrDb: string | Database, opts: OpenOptions = {}) {
    this.db = typeof pathOrDb === "string" ? openDatabase(pathOrDb, opts) : pathOrDb;
    const dbVersion = readStamp(this.db);
    if (dbVersion > SCHEMA_VERSION) this.schemaSkew = { dbVersion, binaryVersion: SCHEMA_VERSION };
  }

  close() {
    this.db.close();
  }

  // ---------- actors ----------

  touchActor(actor: Actor) {
    // Only overwrite a runtime column when the incoming value is non-null, so a later
    // runtime-less write does not erase a known model/harness/effort/session.
    this.db
      .query(
        `INSERT INTO actors(name, kind, last_seen, harness, model, effort, session) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind,
           last_seen = excluded.last_seen,
           harness = COALESCE(excluded.harness, actors.harness),
           model = COALESCE(excluded.model, actors.model),
           effort = COALESCE(excluded.effort, actors.effort),
           session = COALESCE(excluded.session, actors.session)`,
      )
      .run(actor.name, actor.kind, now(), actor.harness ?? null, actor.model ?? null, actor.effort ?? null, actor.session ?? null);
  }

  listActors(): { name: string; kind: Actor["kind"]; lastSeen: string; harness?: string; model?: string; effort?: string; session?: string }[] {
    type ActorRow = { name: string; kind: Actor["kind"]; last_seen: string; harness: string | null; model: string | null; effort: string | null; session: string | null };
    return (this.db.query("SELECT name, kind, last_seen, harness, model, effort, session FROM actors ORDER BY last_seen DESC").all() as ActorRow[]).map((r) => ({
      name: r.name,
      kind: r.kind,
      lastSeen: r.last_seen,
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      ...(r.session ? { session: r.session } : {}),
    }));
  }

  /**
   * Everyone who has written on one board, most recently active first. The team strip
   * reads this: the global `actors` table has no notion of which board someone worked,
   * and its `last_seen` moves whenever that actor writes anywhere.
   *
   * Everything but the count is read off that actor's latest event, via MAX(seq) and
   * SQLite's bare-column rule: seq is the only total order the events table has, since
   * several writes can share a millisecond. So `kind` is what they last wrote as.
   *
   * Runtime comes from that actor's own latest event on this board that carried a model,
   * which is what actually ran here; the global actor cache fills in for an actor whose
   * events predate the runtime columns.
   */
  boardActors(boardId: string): TeamMember[] {
    const rows = this.db
      .query(
        `SELECT actor AS name, MAX(seq) AS seq, actor_kind AS kind, created_at AS last_seen, COUNT(*) AS events
         FROM events WHERE board_id = ? GROUP BY actor ORDER BY seq DESC`,
      )
      .all(boardId) as { name: string; kind: Actor["kind"]; last_seen: string; seq: number; events: number }[];
    if (rows.length === 0) return [];
    // SQLite takes the bare columns from the row that produced MAX(seq).
    const latest = new Map(
      (
        this.db
          .query(
            `SELECT actor, MAX(seq) AS seq, harness, model, effort
             FROM events WHERE board_id = ? AND model IS NOT NULL GROUP BY actor`,
          )
          .all(boardId) as { actor: string; harness: string | null; model: string | null; effort: string | null }[]
      ).map((r) => [r.actor, r]),
    );
    const cached = new Map(this.listActors().map((a) => [a.name, a]));
    return rows.map((r) => {
      const rt = latest.get(r.name) ?? cached.get(r.name) ?? {};
      return {
        name: r.name,
        kind: r.kind,
        lastSeen: r.last_seen,
        events: r.events,
        ...((rt as any).harness ? { harness: (rt as any).harness as string } : {}),
        ...((rt as any).model ? { model: (rt as any).model as string } : {}),
        ...((rt as any).effort ? { effort: (rt as any).effort as string } : {}),
      };
    });
  }

  /**
   * One actor as this board knows them, plus every card they have touched here.
   *
   * There is deliberately no "current card": nothing in flock limits an actor to one claim
   * (claimCard's CAS is per card, and `cards.assignee` has no unique index), so an actor can
   * hold several at once and the view lists them all.
   *
   * Membership is the union of two sources, because neither alone is the whole truth: the
   * event log says what they did (claimed, created, commented, closed) and never forgets,
   * while `assignee` says what they hold right now — including a card handed to them by
   * someone else, which leaves no event of theirs at all.
   */
  actorProfile(boardRef: string, name: string): ActorProfile {
    const b = this.board(boardRef);
    const member = this.boardActors(b.id).find((m) => m.name === name);
    const cached = this.listActors().find((a) => a.name === name);
    // seq, not created_at, orders the touches: several writes can share a millisecond, and
    // seq is the only total order the events table has (the same rule boardActors relies on).
    const rows = this.db
      .query(
        `SELECT card_num AS num, type, MAX(seq) AS seq, created_at AS last FROM events
         WHERE board_id = ? AND actor = ? AND card_num IS NOT NULL GROUP BY card_num, type`,
      )
      .all(b.id, name) as { num: number; type: string; seq: number; last: string }[];

    const roles = new Map<number, Set<ActorCardRole>>();
    const touched = new Map<number, { seq: number; at: string }>();
    for (const r of rows) {
      const role = ROLE_OF_EVENT[r.type as EventType];
      if (role) (roles.get(r.num) ?? roles.set(r.num, new Set()).get(r.num)!).add(role);
      const prev = touched.get(r.num);
      if (!prev || prev.seq < r.seq) touched.set(r.num, { seq: r.seq, at: r.last });
    }

    const cards: ActorCard[] = [];
    for (const c of this.listCards(b.id)) {
      const held = c.assignee === name;
      const set = roles.get(c.num) ?? new Set<ActorCardRole>();
      if (held) set.add("holding");
      if (set.size === 0 && !touched.has(c.num)) continue;
      cards.push({
        ...c,
        roles: ACTOR_CARD_ROLES.filter((r) => set.has(r)),
        lastTouchedAt: touched.get(c.num)?.at ?? c.updatedAt,
      });
    }
    if (cards.length === 0 && !member && !cached) throw new FlockError(`No actor "${name}" on board "${b.slug}"`, "not_found");
    // Newest touch first: what they are doing now is what the view opens on. A card they only
    // hold has no event of theirs to order by, so it sorts on the card's own last change.
    const order = (n: number) => touched.get(n)?.seq ?? -1;
    cards.sort((x, y) => {
      const d = order(y.num) - order(x.num);
      if (d !== 0) return d;
      return x.lastTouchedAt === y.lastTouchedAt ? y.num - x.num : x.lastTouchedAt < y.lastTouchedAt ? 1 : -1;
    });

    const rt = member ?? cached ?? {};
    return {
      name,
      kind: member?.kind ?? cached?.kind ?? "agent",
      lastSeen: member?.lastSeen ?? null,
      events: member?.events ?? 0,
      ...((rt as any).harness ? { harness: (rt as any).harness as string } : {}),
      ...((rt as any).model ? { model: (rt as any).model as string } : {}),
      ...((rt as any).effort ? { effort: (rt as any).effort as string } : {}),
      cards,
    };
  }

  // ---------- events ----------

  private emit(actor: Actor, boardId: string, type: EventType, cardNum: number | null, data: Record<string, unknown> = {}) {
    this.db
      .query(
        "INSERT INTO events(board_id, actor, actor_kind, type, card_num, data, created_at, harness, model, effort, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        boardId,
        actor.name,
        actor.kind,
        type,
        cardNum,
        JSON.stringify(data),
        now(),
        actor.harness ?? null,
        actor.model ?? null,
        actor.effort ?? null,
        actor.session ?? null,
      );
  }

  private rowToEvent(r: EventRow): Event {
    return {
      seq: r.seq,
      boardId: r.board_id,
      actor: r.actor,
      actorKind: r.actor_kind as Actor["kind"],
      type: r.type as EventType,
      cardNum: r.card_num,
      data: JSON.parse(r.data),
      createdAt: r.created_at,
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      ...(r.session ? { session: r.session } : {}),
    };
  }

  /**
   * Events after `since` (exclusive). Omit boardId for all boards.
   * With `tail`, ignores `since` and instead returns the last `limit` events
   * (by seq) in ascending order — useful for seeding a UI with "the most
   * recent N events for this board" rather than a window from a cursor.
   */
  events(opts: { boardId?: string; since?: number; limit?: number; tail?: boolean } = {}): Event[] {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 500;
    if (opts.tail) {
      const rows = (opts.boardId
        ? this.db.query("SELECT * FROM events WHERE board_id = ? ORDER BY seq DESC LIMIT ?").all(opts.boardId, limit)
        : this.db.query("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)) as EventRow[];
      return rows.reverse().map((r) => this.rowToEvent(r));
    }
    const rows = (opts.boardId
      ? this.db.query("SELECT * FROM events WHERE board_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(opts.boardId, since, limit)
      : this.db.query("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit)) as EventRow[];
    return rows.map((r) => this.rowToEvent(r));
  }

  lastSeq(boardId?: string): number {
    const row = (boardId
      ? this.db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE board_id = ?").get(boardId)
      : this.db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get()) as { s: number };
    return row.s;
  }

  /** Poll until at least one event arrives after `since`, or the timeout passes. */
  async waitForEvents(opts: { boardId?: string; since: number; timeoutMs?: number; intervalMs?: number }): Promise<Event[]> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const interval = opts.intervalMs ?? 500;
    for (;;) {
      const got = this.events({ boardId: opts.boardId, since: opts.since });
      if (got.length > 0 || Date.now() >= deadline) return got;
      await Bun.sleep(interval);
    }
  }

  // ---------- boards ----------

  private rowToBoard(r: BoardRow): Board {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      body: r.body,
      project: r.project,
      status: r.status as Board["status"],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listBoards(opts: { includeArchived?: boolean; project?: string } = {}): Board[] {
    const rows = (opts.includeArchived
      ? this.db.query("SELECT * FROM boards ORDER BY updated_at DESC").all()
      : this.db.query("SELECT * FROM boards WHERE status = 'active' ORDER BY updated_at DESC").all()) as BoardRow[];
    let boards = rows.map((r) => this.rowToBoard(r));
    if (opts.project) {
      const p = normalizeProject(opts.project);
      boards = boards.filter((b) => b.project === p);
    }
    return boards;
  }

  /** Every board with the state, counts and recent activity the index needs, sorted by compareBoardSummaries. */
  boardSummaries(opts: { includeArchived?: boolean } = {}): BoardSummary[] {
    const boards = this.listBoards(opts);
    if (boards.length === 0) return [];

    const countRows = this.db.query("SELECT board_id, status, COUNT(*) AS n FROM cards GROUP BY board_id, status").all() as {
      board_id: string;
      status: CardStatus;
      n: number;
    }[];
    const countsByBoard = new Map<string, Record<CardStatus, number>>();
    for (const row of countRows) {
      let counts = countsByBoard.get(row.board_id);
      if (!counts) {
        counts = Object.fromEntries(CARD_STATUSES.map((s) => [s, 0])) as Record<CardStatus, number>;
        countsByBoard.set(row.board_id, counts);
      }
      counts[row.status] = row.n;
    }

    const lastEventRows = this.db
      .query("SELECT * FROM events WHERE seq IN (SELECT MAX(seq) FROM events GROUP BY board_id)")
      .all() as EventRow[];
    const lastEventByBoard = new Map(lastEventRows.map((r) => [r.board_id, this.rowToEvent(r)]));

    // What each board is working on right now: one query for every doing card, grouped and
    // capped in JS. The index's "now" line cannot be derived from lastEvent (which only names
    // a card when the last write touched one) or from team (which has no card).
    const doingRows = this.db
      .query("SELECT board_id, num, title, assignee FROM cards WHERE status = 'doing' ORDER BY updated_at DESC, num DESC")
      .all() as { board_id: string; num: number; title: string; assignee: string | null }[];
    const doingByBoard = new Map<string, DoingCard[]>();
    for (const r of doingRows) {
      const list = doingByBoard.get(r.board_id) ?? [];
      if (list.length < 3) list.push({ num: r.num, title: r.title, assignee: r.assignee });
      doingByBoard.set(r.board_id, list);
    }

    const summaries = boards.map((b) => {
      const counts = countsByBoard.get(b.id) ?? (Object.fromEntries(CARD_STATUSES.map((s) => [s, 0])) as Record<CardStatus, number>);
      const total = CARD_STATUSES.reduce((n, s) => n + counts[s], 0);
      const open = counts.todo + counts.doing + counts["awaiting-human"];
      const lastEvent = lastEventByBoard.get(b.id) ?? null;
      const lastActivityAt = lastEvent ? lastEvent.createdAt : b.updatedAt;
      const team = this.boardActors(b.id).slice(0, 5);
      const state = boardStateOf(counts, b.status);
      const doing = doingByBoard.get(b.id) ?? [];
      const summary: BoardSummary = { ...b, state, counts, open, total, lastEvent, lastActivityAt, team, doing };
      return summary;
    });

    return summaries.sort(compareBoardSummaries);
  }

  /**
   * The board scoped to `dir` or its nearest ancestor. A worktree at /repos/x/feat and a
   * checkout at /repos/x each get their own board; a subdirectory resolves to the closest one.
   */
  boardForDir(dir: string, opts: { includeArchived?: boolean } = {}): Board | null {
    const target = normalizeProject(dir);
    const candidates = this.listBoards(opts).filter((b) => b.project && (target === b.project || target.startsWith(b.project + "/")));
    candidates.sort((a, b) => b.project!.length - a.project!.length);
    return candidates[0] ?? null;
  }

  /** Look up by id, slug, or unique title prefix. */
  findBoard(ref: string): Board | null {
    const r = (this.db.query("SELECT * FROM boards WHERE id = ? OR slug = ?").get(ref, ref) as BoardRow | null)
      ?? (this.db.query("SELECT * FROM boards WHERE slug = ?").get(slugify(ref)) as BoardRow | null);
    return r ? this.rowToBoard(r) : null;
  }

  board(ref: string): Board {
    const b = this.findBoard(ref);
    if (!b) throw new FlockError(`No board matches "${ref}"`, "not_found");
    return b;
  }

  createBoard(actor: Actor, input: { title: string; slug?: string; body?: string; project?: string | null }): Board {
    this.touchActor(actor);
    const project = input.project ? normalizeProject(input.project) : null;
    if (project) {
      const existing = this.listBoards({ includeArchived: true, project }).find((b) => b.status === "active");
      if (existing) throw new FlockError(`${project} already has a board: "${existing.title}" (${existing.slug}). One board per project directory; archive it first or pass no project.`, "conflict");
    }
    const id = shortId();
    let slug = input.slug ? slugify(input.slug) : slugify(input.title);
    if (this.findBoard(slug)) {
      let n = 2;
      while (this.findBoard(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    const ts = now();
    this.db
      .query("INSERT INTO boards(id, slug, title, body, project, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
      .run(id, slug, input.title, input.body ?? "", project, ts, ts);
    this.emit(actor, id, "board.created", null, { title: input.title, slug, project });
    return this.board(id);
  }

  updateBoard(actor: Actor, ref: string, patch: { title?: string; body?: string; status?: Board["status"]; slug?: string; project?: string | null }): Board {
    const b = this.board(ref);
    this.touchActor(actor);
    const next = {
      title: patch.title ?? b.title,
      body: patch.body ?? b.body,
      status: patch.status ?? b.status,
      slug: patch.slug ? slugify(patch.slug) : b.slug,
      project: patch.project === undefined ? b.project : patch.project ? normalizeProject(patch.project) : null,
    };
    if (next.project && next.status === "active") {
      const clash = this.listBoards({ project: next.project }).find((o) => o.id !== b.id);
      if (clash) throw new FlockError(`${next.project} already has an active board: "${clash.title}" (${clash.slug})`, "conflict");
    }
    this.db
      .query("UPDATE boards SET title = ?, body = ?, status = ?, slug = ?, project = ?, updated_at = ? WHERE id = ?")
      .run(next.title, next.body, next.status, next.slug, next.project, now(), b.id);
    this.emit(actor, b.id, "board.updated", null, { fields: Object.keys(patch) });
    return this.board(b.id);
  }

  /**
   * Hard delete: the board row and every row scoped to it, in one transaction. Archiving
   * (`updateBoard` with status "archived") is the reversible option; this one is not.
   *
   * Every child table is deleted explicitly rather than leaning on ON DELETE CASCADE, so the
   * result does not depend on `PRAGMA foreign_keys` being on in whatever connection opened the
   * file. `events` needs it regardless: its `board_id` carries no foreign key at all.
   *
   * No event is written. `events.board_id` is NOT NULL, so there is no board-less row to record
   * this in, and every event that could have named this board is being deleted with it.
   */
  deleteBoard(actor: Actor, ref: string): { slug: string; cards: number } {
    const b = this.board(ref);
    this.touchActor(actor);
    const cards = (this.db.query("SELECT COUNT(*) AS n FROM cards WHERE board_id = ?").get(b.id) as { n: number }).n;
    this.db.transaction(() => {
      this.db.query("DELETE FROM comment_reactions WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM reactions WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM comments WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)").run(b.id);
      this.db.query("DELETE FROM card_blockers WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)").run(b.id);
      this.db.query("DELETE FROM card_blockers WHERE blocker_id IN (SELECT id FROM cards WHERE board_id = ?)").run(b.id);
      this.db.query("DELETE FROM cards WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM attachments WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM messages WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM decisions WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM events WHERE board_id = ?").run(b.id);
      this.db.query("DELETE FROM boards WHERE id = ?").run(b.id);
    })();
    return { slug: b.slug, cards };
  }

  private touchBoard(boardId: string) {
    this.db.query("UPDATE boards SET updated_at = ? WHERE id = ?").run(now(), boardId);
  }

  // ---------- cards ----------

  private blockersOf(cardId: string): { num: number; open: boolean }[] {
    return (this.db
      .query(
        `SELECT c.num AS num, c.status AS status FROM card_blockers cb JOIN cards c ON c.id = cb.blocker_id WHERE cb.card_id = ? ORDER BY c.num`,
      )
      .all(cardId) as { num: number; status: CardStatus }[]).map((r) => ({ num: r.num, open: !CLOSED_STATUSES.includes(r.status) }));
  }

  /** The `question`-kind comment `askHuman` posted for this card's current question, with its
   *  reactions — so `rowToCard` can hand the UI everything it needs to react to (and thereby
   *  answer, card 76) the pending ask without a second fetch. Null once there is no question. */
  private pendingQuestionComment(cardId: string): { num: number; reactions: Reaction[] } | null {
    const row = this.db
      .query("SELECT id, num FROM comments WHERE card_id = ? AND kind = 'question' ORDER BY num DESC LIMIT 1")
      .get(cardId) as { id: string; num: number } | null;
    if (!row) return null;
    return { num: row.num, reactions: this.reactionsForComments([row.id]).get(row.id) ?? [] };
  }

  private rowToCard(r: CardRow): Card {
    const blockers = this.blockersOf(r.id);
    const pendingQuestion = r.question !== null ? this.pendingQuestionComment(r.id) : null;
    return {
      id: r.id,
      boardId: r.board_id,
      num: r.num,
      title: r.title,
      body: r.body,
      status: r.status,
      assignee: r.assignee,
      labels: JSON.parse(r.labels),
      question: r.question,
      questionBy: r.question_by,
      questionCommentNum: pendingQuestion?.num ?? null,
      questionReactions: pendingQuestion?.reactions ?? [],
      position: r.position,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
      blockedBy: blockers.map((b) => b.num),
      blocked: blockers.some((b) => b.open),
      heldAt: r.held_at,
      heldBy: r.held_by,
      holdReason: r.hold_reason,
      held: r.held_at !== null,
    };
  }

  private cardRow(boardId: string, num: number): CardRow | null {
    return this.db.query("SELECT * FROM cards WHERE board_id = ? AND num = ?").get(boardId, num) as CardRow | null;
  }

  static parseCardRef(ref: string | number): number {
    const n = typeof ref === "number" ? ref : Number.parseInt(String(ref).replace(/^#/, ""), 10);
    if (!Number.isInteger(n) || n <= 0) throw new FlockError(`"${ref}" is not a card number`, "invalid");
    return n;
  }

  card(boardRef: string, ref: string | number): Card {
    const b = this.board(boardRef);
    const num = Flock.parseCardRef(ref);
    const r = this.cardRow(b.id, num);
    if (!r) throw new FlockError(`No card #${num} on board "${b.slug}"`, "not_found");
    return this.rowToCard(r);
  }

  listCards(boardRef: string, filter: CardFilter = {}): Card[] {
    const b = this.board(boardRef);
    const rows = this.db.query("SELECT * FROM cards WHERE board_id = ? ORDER BY position, num").all(b.id) as CardRow[];
    let cards = rows.map((r) => this.rowToCard(r));
    if (filter.status && (!Array.isArray(filter.status) || filter.status.length)) {
      const set = new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
      cards = cards.filter((c) => set.has(c.status));
    }
    if (filter.open) cards = cards.filter((c) => !CLOSED_STATUSES.includes(c.status));
    if (filter.assignee) cards = cards.filter((c) => c.assignee === filter.assignee);
    if (filter.label) cards = cards.filter((c) => c.labels.includes(filter.label!));
    if (filter.frontier) cards = cards.filter((c) => c.status === "todo" && !c.assignee && !c.blocked && !c.held);
    if (filter.held !== undefined) cards = cards.filter((c) => c.held === filter.held);
    return cards;
  }

  createCard(actor: Actor, boardRef: string, input: NewCard): Card {
    const b = this.board(boardRef);
    this.touchActor(actor);
    const status = input.status ?? "todo";
    if (!CARD_STATUSES.includes(status)) throw new FlockError(`Unknown status "${status}"`, "invalid");
    const id = shortId();
    const ts = now();
    const card = this.db.transaction(() => {
      const { n } = this.db.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM cards WHERE board_id = ?").get(b.id) as { n: number };
      const { p } = this.db.query("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM cards WHERE board_id = ?").get(b.id) as { p: number };
      this.db
        .query(
          `INSERT INTO cards(id, board_id, num, title, body, status, assignee, labels, position, created_by, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, b.id, n, input.title, input.body ?? "", status, input.assignee ?? null,
          JSON.stringify(uniq(input.labels ?? [])), p, actor.name, ts, ts,
          CLOSED_STATUSES.includes(status) ? ts : null,
        );
      for (const blockerNum of input.blockedBy ?? []) this.addBlockerRaw(b.id, id, n, blockerNum);
      this.touchBoard(b.id);
      this.emit(actor, b.id, "card.created", n, { title: input.title, labels: input.labels ?? [], blockedBy: input.blockedBy ?? [] });
      return this.rowToCard(this.cardRow(b.id, n)!);
    })();
    return card;
  }

  updateCard(actor: Actor, boardRef: string, ref: string | number, patch: CardPatch): Card {
    const c = this.card(boardRef, ref);
    this.touchActor(actor);
    let labels = c.labels;
    if (patch.addLabels) labels = uniq([...labels, ...patch.addLabels]);
    if (patch.removeLabels) labels = labels.filter((l) => !patch.removeLabels!.includes(l));
    this.db
      .query("UPDATE cards SET title = ?, body = ?, labels = ?, position = ?, updated_at = ? WHERE id = ?")
      .run(patch.title ?? c.title, patch.body ?? c.body, JSON.stringify(labels), patch.position ?? c.position, now(), c.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.updated", c.num, { fields: Object.keys(patch) });
    return this.card(c.boardId, c.num);
  }

  /**
   * Check or uncheck the `index`th markdown task-list item of a card body, counting
   * from 0 in document order and ignoring items inside fenced code blocks. Rewrites
   * only that line, so the rest of the body is untouched. Pass `checked` to set an
   * explicit state; omit it to flip whatever the item currently is.
   */
  toggleCardTask(actor: Actor, boardRef: string, ref: string | number, index: number, checked?: boolean): Card {
    const c = this.card(boardRef, ref);
    if (!Number.isInteger(index) || index < 0) throw new FlockError(`"${index}" is not a task index`, "invalid");
    const items = taskItems(c.body);
    const item = items[index];
    if (!item) {
      throw new FlockError(
        items.length === 0
          ? `#${c.num} has no task-list items`
          : `#${c.num} has ${items.length} task-list item${items.length === 1 ? "" : "s"}; no item ${index}`,
        "not_found",
      );
    }
    const body = setTaskChecked(c.body, index, checked ?? !item.checked)!;
    if (body === c.body) return c;
    return this.updateCard(actor, boardRef, c.num, { body });
  }

  /**
   * Compare-and-swap claim. Succeeds only if the card is open, unclaimed (or already
   * claimed by this actor), and unblocked unless `force`. Throws a 409 otherwise.
   */
  claimCard(actor: Actor, boardRef: string, ref: string | number, opts: { force?: boolean } = {}): Card {
    const c = this.card(boardRef, ref);
    this.touchActor(actor);
    if (CLOSED_STATUSES.includes(c.status)) throw new FlockError(`#${c.num} is ${c.status}`, "conflict");
    if (c.held) throw new FlockError(holdConflictMessage(c), "conflict");
    if (c.blocked && !opts.force) {
      throw new FlockError(`#${c.num} is blocked by #${c.blockedBy.join(", #")}; pass force to claim anyway`, "conflict");
    }
    const res = this.db
      .query(
        `UPDATE cards SET assignee = ?, status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END, updated_at = ?
         WHERE id = ? AND (assignee IS NULL OR assignee = ?) AND status NOT IN ('done', 'wontfix')`,
      )
      .run(actor.name, now(), c.id, actor.name);
    if (res.changes === 0) {
      const fresh = this.card(c.boardId, c.num);
      throw new FlockError(`#${c.num} is already claimed by ${fresh.assignee ?? "someone else"}`, "conflict");
    }
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.claimed", c.num, { title: c.title });
    return this.card(c.boardId, c.num);
  }

  releaseCard(actor: Actor, boardRef: string, ref: string | number): Card {
    const c = this.card(boardRef, ref);
    this.touchActor(actor);
    this.db
      .query("UPDATE cards SET assignee = NULL, status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END, updated_at = ? WHERE id = ?")
      .run(now(), c.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.released", c.num, { previous: c.assignee });
    return this.card(c.boardId, c.num);
  }

  assignCard(actor: Actor, boardRef: string, ref: string | number, assignee: string | null): Card {
    const c = this.card(boardRef, ref);
    // Assigning a held card to yourself reproduces claim's effect one step away; gate it the
    // same way. Assigning it to someone else, or clearing the assignee, is unaffected.
    if (c.held && assignee === actor.name) throw new FlockError(holdConflictMessage(c), "conflict");
    this.touchActor(actor);
    this.db.query("UPDATE cards SET assignee = ?, updated_at = ? WHERE id = ?").run(assignee, now(), c.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, assignee ? "card.claimed" : "card.released", c.num, { assignee, by: actor.name });
    return this.card(c.boardId, c.num);
  }

  /**
   * Move a card to a new status. Reopening a card — done/wontfix back to todo/doing —
   * must carry a non-empty `opts.reason`: it lands as a comment on the card, in the same
   * transaction as the move, so `comment.posted` and `card.moved` both land together.
   */
  moveCard(actor: Actor, boardRef: string, ref: string | number, status: CardStatus, opts: { reason?: string; attachments?: string[] } = {}): Card {
    if (!CARD_STATUSES.includes(status)) throw new FlockError(`Unknown status "${status}". One of: ${CARD_STATUSES.join(", ")}`, "invalid");
    const c = this.card(boardRef, ref);
    const reopening = CLOSED_STATUSES.includes(c.status) && (status === "todo" || status === "doing");
    const reason = opts.reason?.trim();
    if (reopening && !reason) {
      throw new FlockError(`Reopening #${c.num} needs a reason: what's not done, or why it's coming back`, "invalid");
    }
    const attachmentIds = opts.attachments ?? [];
    // Validated up front, before anything is written, same as addComment.
    if (reason) this.assertBindable(c.boardId, attachmentIds, "comment");
    this.touchActor(actor);
    const closed = CLOSED_STATUSES.includes(status);
    const ts = now();
    let commentId: string | null = null;
    let commentNum: number | null = null;
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE cards SET status = ?, closed_at = ?,
             question = CASE WHEN ? = 'awaiting-human' THEN question ELSE NULL END,
             question_by = CASE WHEN ? = 'awaiting-human' THEN question_by ELSE NULL END,
             held_at = CASE WHEN ? THEN NULL ELSE held_at END,
             held_by = CASE WHEN ? THEN NULL ELSE held_by END,
             hold_reason = CASE WHEN ? THEN NULL ELSE hold_reason END,
             updated_at = ? WHERE id = ?`,
        )
        .run(status, closed ? ts : null, status, status, closed ? 1 : 0, closed ? 1 : 0, closed ? 1 : 0, ts, c.id);
      if (reason) {
        commentId = shortId();
        commentNum = this.nextCommentNum(c.id);
        this.db
          .query("INSERT INTO comments(id, card_id, num, author, author_kind, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(commentId, c.id, commentNum, actor.name, actor.kind, "comment", reason, ts);
        this.bindAttachments(c.boardId, "comment_id", commentId, attachmentIds);
      }
      // Closing a card also lifts any hold on it: a closed card is not on the frontier, so a
      // hold gates nothing further, and it would otherwise be impossible to hold it again
      // later without the stale metadata (and holdCard already refuses closed cards). Emit
      // card.unheld first so an activity feed reads "unheld, then closed" in event order.
      if (closed && c.held) {
        this.emit(actor, c.boardId, "card.unheld", c.num, { title: c.title, reason: c.holdReason, heldSince: c.heldAt, heldBy: c.heldBy });
      }
      this.emit(actor, c.boardId, closed ? "card.closed" : "card.moved", c.num, { from: c.status, to: status });
      if (reason) {
        const attachments = commentId ? (this.attachmentsForOwners("comment_id", [commentId]).get(commentId) ?? []) : [];
        this.emit(actor, c.boardId, "comment.posted", c.num, {
          kind: "comment",
          num: commentNum,
          ref: commentNum === null ? null : commentRef(c.num, commentNum),
          body: reason,
          attachments: attachmentIds.length,
          attachmentList: attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })),
        });
      }
    })();
    this.touchBoard(c.boardId);
    return this.card(c.boardId, c.num);
  }

  /** Close a card with an optional resolution comment. */
  closeCard(actor: Actor, boardRef: string, ref: string | number, opts: { resolution?: string; status?: "done" | "wontfix" } = {}): Card {
    const c = this.card(boardRef, ref);
    if (opts.resolution) this.addComment(actor, c.boardId, c.num, opts.resolution, "resolution");
    return this.moveCard(actor, c.boardId, c.num, opts.status ?? "done");
  }

  private addBlockerRaw(boardId: string, cardId: string, cardNum: number, blockerNum: number) {
    if (blockerNum === cardNum) throw new FlockError(`#${cardNum} cannot block itself`, "invalid");
    const blocker = this.cardRow(boardId, blockerNum);
    if (!blocker) throw new FlockError(`No card #${blockerNum} to block on`, "not_found");
    this.db.query("INSERT OR IGNORE INTO card_blockers(card_id, blocker_id) VALUES (?, ?)").run(cardId, blocker.id);
  }

  addBlocker(actor: Actor, boardRef: string, ref: string | number, blockerRef: string | number): Card {
    const c = this.card(boardRef, ref);
    const blockerNum = Flock.parseCardRef(blockerRef);
    this.touchActor(actor);
    this.addBlockerRaw(c.boardId, c.id, c.num, blockerNum);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.blocked", c.num, { by: blockerNum });
    return this.card(c.boardId, c.num);
  }

  removeBlocker(actor: Actor, boardRef: string, ref: string | number, blockerRef: string | number): Card {
    const c = this.card(boardRef, ref);
    const blocker = this.card(c.boardId, blockerRef);
    this.touchActor(actor);
    this.db.query("DELETE FROM card_blockers WHERE card_id = ? AND blocker_id = ?").run(c.id, blocker.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.unblocked", c.num, { by: blocker.num });
    return this.card(c.boardId, c.num);
  }

  // ---------- hold ----------

  /**
   * Park a card: a human gate on claiming. Orthogonal to blockers — a blocker is a
   * card-to-card dependency that resolves when the blocker closes, a hold resolves only
   * when someone calls `unholdCard`. Holding an already-held card re-stamps it (that is
   * how a reason is changed) and emits a second `card.held`.
   */
  holdCard(actor: Actor, boardRef: string, ref: string | number, opts: { reason?: string } = {}): Card {
    const c = this.card(boardRef, ref);
    if (CLOSED_STATUSES.includes(c.status)) throw new FlockError(`#${c.num} is ${c.status}; there is nothing to hold`, "conflict");
    this.touchActor(actor);
    const reason = opts.reason?.trim() || null;
    const ts = now();
    this.db.query("UPDATE cards SET held_at = ?, held_by = ?, hold_reason = ?, updated_at = ? WHERE id = ?")
      .run(ts, actor.name, reason, ts, c.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.held", c.num, { title: c.title, reason, heldAt: ts });
    return this.card(c.boardId, c.num);
  }

  /** Lift a hold. A no-op on a card that is not held: no write, no event, no error. */
  unholdCard(actor: Actor, boardRef: string, ref: string | number): Card {
    const c = this.card(boardRef, ref);
    if (!c.held) return c;
    this.touchActor(actor);
    this.db.query("UPDATE cards SET held_at = NULL, held_by = NULL, hold_reason = NULL, updated_at = ? WHERE id = ?")
      .run(now(), c.id);
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.unheld", c.num, { title: c.title, reason: c.holdReason, heldSince: c.heldAt, heldBy: c.heldBy });
    return this.card(c.boardId, c.num);
  }

  /** Cards that this card blocks. */
  dependents(boardRef: string, ref: string | number): Card[] {
    const c = this.card(boardRef, ref);
    const rows = this.db
      .query("SELECT c.* FROM card_blockers cb JOIN cards c ON c.id = cb.card_id WHERE cb.blocker_id = ? ORDER BY c.num")
      .all(c.id) as CardRow[];
    return rows.map((r) => this.rowToCard(r));
  }

  // ---------- human in the loop ----------

  /** An agent needs a human: park the card and record the question. */
  askHuman(actor: Actor, boardRef: string, ref: string | number, question: string): Card {
    const c = this.card(boardRef, ref);
    if (CLOSED_STATUSES.includes(c.status)) throw new FlockError(`#${c.num} is ${c.status}`, "conflict");
    this.touchActor(actor);
    this.db
      .query("UPDATE cards SET status = 'awaiting-human', question = ?, question_by = ?, updated_at = ? WHERE id = ?")
      .run(question, actor.name, now(), c.id);
    this.addComment(actor, c.boardId, c.num, question, "question");
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.asked", c.num, { question, title: c.title });
    return this.card(c.boardId, c.num);
  }

  /** A human answers: record the reply and hand the card back to whoever held it. */
  answerHuman(actor: Actor, boardRef: string, ref: string | number, answer: string): Card {
    const c = this.card(boardRef, ref);
    if (c.status !== "awaiting-human") throw new FlockError(`#${c.num} is not awaiting a human (status: ${c.status})`, "conflict");
    this.touchActor(actor);
    const next: CardStatus = c.assignee ? "doing" : "todo";
    this.db
      .query("UPDATE cards SET status = ?, question = NULL, question_by = NULL, updated_at = ? WHERE id = ?")
      .run(next, now(), c.id);
    this.addComment(actor, c.boardId, c.num, answer, "answer");
    this.touchBoard(c.boardId);
    this.emit(actor, c.boardId, "card.answered", c.num, { answer, askedBy: c.questionBy, title: c.title });
    return this.card(c.boardId, c.num);
  }

  /** Every card across all boards that is waiting on a human. */
  needsHuman(): (Card & { boardSlug: string; boardTitle: string })[] {
    const rows = this.db
      .query(
        `SELECT c.*, b.slug AS board_slug, b.title AS board_title FROM cards c JOIN boards b ON b.id = c.board_id
         WHERE c.status = 'awaiting-human' AND c.held_at IS NULL AND b.status = 'active' ORDER BY c.updated_at`,
      )
      .all() as (CardRow & { board_slug: string; board_title: string })[];
    return rows.map((r) => ({ ...this.rowToCard(r), boardSlug: r.board_slug, boardTitle: r.board_title }));
  }

  // ---------- comments ----------

  private rowToComment(r: CommentRow, cardNum: number, attachments: Attachment[] = [], reactions: Reaction[] = []): Comment {
    return {
      id: r.id,
      cardId: r.card_id,
      num: r.num,
      cardNum,
      author: r.author,
      authorKind: r.author_kind as Actor["kind"],
      kind: r.kind as CommentKind,
      body: r.body,
      createdAt: r.created_at,
      attachments,
      reactions,
    };
  }

  comments(boardRef: string, ref: string | number): Comment[] {
    const c = this.card(boardRef, ref);
    const rows = this.db.query("SELECT * FROM comments WHERE card_id = ? ORDER BY created_at, rowid").all(c.id) as CommentRow[];
    const ids = rows.map((r) => r.id);
    const byComment = this.attachmentsForOwners("comment_id", ids);
    const reactionsByComment = this.reactionsForComments(ids);
    return rows.map((r) => this.rowToComment(r, c.num, byComment.get(r.id) ?? [], reactionsByComment.get(r.id) ?? []));
  }

  /**
   * Post a comment on a card. `opts.attachments` are ids from `attach()`, bound here in order —
   * the same mechanism a channel message uses (#46), so an image reads the same either side.
   * A comment with an image needs no text.
   */
  addComment(actor: Actor, boardRef: string, ref: string | number, body: string, kind: CommentKind = "comment", opts?: { attachments?: string[]; level?: string }): Comment {
    const c = this.card(boardRef, ref);
    const ids = opts?.attachments ?? [];
    if (!body.trim() && ids.length === 0) throw new FlockError("a comment needs a body or an attachment");
    // Validated up front, alongside the attachment ids, so a bad `level` fails clean too.
    const level = assertDeclarableLevel(opts?.level);
    // Validate every id up front so a bad reference fails clean, before anything is written.
    this.assertBindable(c.boardId, ids, "comment");
    this.touchActor(actor);
    const id = shortId();
    const ts = now();
    const num = this.db.transaction(() => {
      const n = this.nextCommentNum(c.id);
      this.db
        .query("INSERT INTO comments(id, card_id, num, author, author_kind, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, c.id, n, actor.name, actor.kind, kind, body, ts);
      this.bindAttachments(c.boardId, "comment_id", id, ids);
      return n;
    })();
    this.db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(ts, c.id);
    this.touchBoard(c.boardId);
    const attachments = this.attachmentsForOwners("comment_id", [id]).get(id) ?? [];
    if (kind === "comment" || kind === "resolution") {
      this.emit(actor, c.boardId, "comment.posted", c.num, {
        kind,
        num,
        ref: commentRef(c.num, num),
        body,
        attachments: ids.length,
        attachmentList: attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })),
        ...(level ? { level } : {}),
      });
    }
    return this.rowToComment(this.db.query("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow, c.num, attachments);
  }

  // ---------- attachments ----------

  private rowToAttachment(r: AttachmentRow): Attachment {
    return {
      id: r.id,
      boardId: r.board_id,
      messageId: r.message_id,
      commentId: r.comment_id,
      author: r.author,
      authorKind: r.author_kind as Actor["kind"],
      mime: r.mime,
      name: r.name,
      size: r.size,
      sha256: r.sha256,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
    };
  }

  /**
   * Batched, ordered lookup of the attachments belonging to a set of owners. An owner is a
   * message or a card comment — the same table and the same shape either way (#46), which is
   * why this takes the owning column rather than existing twice. Never selects `bytes`.
   */
  private attachmentsForOwners(column: "message_id" | "comment_id", ownerIds: string[]): Map<string, Attachment[]> {
    const map = new Map<string, Attachment[]>();
    if (ownerIds.length === 0) return map;
    const placeholders = ownerIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT id, board_id, message_id, comment_id, author, author_kind, mime, name, size, sha256, width, height, position, created_at
         FROM attachments WHERE ${column} IN (${placeholders}) ORDER BY position, rowid`,
      )
      .all(...ownerIds) as (AttachmentRow & { position: number })[];
    for (const r of rows) {
      const owner = (column === "message_id" ? r.message_id : r.comment_id)!;
      const list = map.get(owner) ?? [];
      list.push(this.rowToAttachment(r));
      map.set(owner, list);
    }
    return map;
  }

  /**
   * Bind a set of already-uploaded attachment ids to the message or comment that has just been
   * written, sweeping stale orphans on the way. Runs inside the caller's transaction so a
   * failed bind rolls the whole post back. Ids are validated by `assertBindable` first.
   */
  private bindAttachments(boardId: string, column: "message_id" | "comment_id", ownerId: string, ids: string[]) {
    const cutoff = new Date(Date.now() - ORPHAN_TTL_MS).toISOString();
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .query(`DELETE FROM attachments WHERE board_id = ? AND message_id IS NULL AND comment_id IS NULL AND created_at < ? AND id NOT IN (${placeholders})`)
        .run(boardId, cutoff, ...ids);
    } else {
      this.db.query("DELETE FROM attachments WHERE board_id = ? AND message_id IS NULL AND comment_id IS NULL AND created_at < ?").run(boardId, cutoff);
    }
    ids.forEach((attId, i) => {
      const result = this.db
        .query(`UPDATE attachments SET ${column} = ?, position = ? WHERE id = ? AND board_id = ? AND message_id IS NULL AND comment_id IS NULL`)
        .run(ownerId, i, attId, boardId);
      if (result.changes !== 1) throw new FlockError(`attachment ${attId} could not be bound`, "conflict");
    });
  }

  /** Every id exists on this board and is still unbound, checked before anything is written. */
  private assertBindable(boardId: string, ids: string[], what: "message" | "comment") {
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new FlockError(`a ${what} can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
    if (new Set(ids).size !== ids.length) throw new FlockError("duplicate attachment id");
    for (const attId of ids) {
      const row = this.db.query("SELECT board_id, message_id, comment_id FROM attachments WHERE id = ?").get(attId) as
        | { board_id: string; message_id: string | null; comment_id: string | null }
        | null;
      if (!row || row.board_id !== boardId) throw new FlockError(`No attachment "${attId}"`, "not_found");
      if (row.message_id) throw new FlockError(`attachment ${attId} is already attached to a message`, "conflict");
      if (row.comment_id) throw new FlockError(`attachment ${attId} is already attached to a comment`, "conflict");
    }
  }

  /** Uploads an image, unbound to any message until a `say` references its id. Returns metadata only. */
  attach(actor: Actor, boardRef: string, input: { mime: string; bytes: Uint8Array; name?: string | null; width?: number | null; height?: number | null }): Attachment {
    const b = this.board(boardRef);
    this.touchActor(actor);
    if (input.bytes.byteLength === 0) throw new FlockError("attachment is empty");
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new FlockError(`attachment is ${input.bytes.byteLength} bytes; the limit is 5 MiB`, "invalid", 413);
    }
    const mime = normalizeMime(input.mime);
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(mime)) {
      throw new FlockError(`unsupported type ${mime}; allowed: png, jpeg, gif, webp`);
    }
    const sniffed = sniffImageMime(input.bytes);
    if (!sniffed || sniffed !== mime) throw new FlockError(`bytes are not a valid ${mime}`);
    const id = shortId();
    const ts = now();
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const width = coercePositiveInt(input.width);
    const height = coercePositiveInt(input.height);
    const name = sanitizeAttachmentName(input.name);
    this.db
      .query(
        `INSERT INTO attachments(id, board_id, message_id, comment_id, author, author_kind, mime, name, bytes, size, sha256, width, height, position, created_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(id, b.id, actor.name, actor.kind, mime, name, input.bytes, input.bytes.byteLength, sha256, width, height, ts);
    return { id, boardId: b.id, messageId: null, commentId: null, author: actor.name, authorKind: actor.kind, mime, name, size: input.bytes.byteLength, sha256, width, height, createdAt: ts };
  }

  /** Metadata plus bytes, for serving. Not found if missing, or if it belongs to another board. */
  attachment(boardRef: string, id: string): { meta: Attachment; bytes: Uint8Array } {
    const b = this.board(boardRef);
    const row = this.db
      .query("SELECT id, board_id, message_id, comment_id, author, author_kind, mime, name, bytes, size, sha256, width, height, created_at FROM attachments WHERE id = ?")
      .get(id) as (AttachmentRow & { bytes: Uint8Array }) | null;
    if (!row || row.board_id !== b.id) throw new FlockError(`No attachment "${id}"`, "not_found");
    return { meta: this.rowToAttachment(row), bytes: row.bytes };
  }

  /** Metadata only, never bytes. */
  attachmentMeta(boardRef: string, id: string): Attachment {
    const b = this.board(boardRef);
    const row = this.db
      .query("SELECT id, board_id, message_id, comment_id, author, author_kind, mime, name, size, sha256, width, height, created_at FROM attachments WHERE id = ?")
      .get(id) as AttachmentRow | null;
    if (!row || row.board_id !== b.id) throw new FlockError(`No attachment "${id}"`, "not_found");
    return this.rowToAttachment(row);
  }

  // ---------- channel ----------

  messages(boardRef: string, opts: { limit?: number } = {}): Message[] {
    const b = this.board(boardRef);
    const rows = this.db
      .query("SELECT * FROM (SELECT rowid AS rid, * FROM messages WHERE board_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid")
      .all(b.id, opts.limit ?? 200) as MessageRow[];
    const ids = rows.map((r) => r.id);
    const attachmentsByMessage = this.attachmentsForOwners("message_id", ids);
    const reactionsByMessage = this.reactionsForMessages(ids);
    return rows.map((r) => this.rowToMessage(r, attachmentsByMessage.get(r.id) ?? [], reactionsByMessage.get(r.id) ?? []));
  }

  private rowToMessage(r: MessageRow, attachments: Attachment[], reactions: Reaction[]): Message {
    return {
      id: r.id,
      boardId: r.board_id,
      num: r.num,
      author: r.author,
      authorKind: r.author_kind as Actor["kind"],
      body: r.body,
      createdAt: r.created_at,
      attachments,
      reactions,
    };
  }

  say(actor: Actor, boardRef: string, body: string, opts?: { attachments?: string[]; level?: string }): Message {
    const b = this.board(boardRef);
    const ids = opts?.attachments ?? [];
    if (!body.trim() && ids.length === 0) throw new FlockError("a message needs a body or an attachment");
    // Validated up front, alongside the attachment ids, so a bad `level` fails clean too.
    const level = assertDeclarableLevel(opts?.level);
    // Validate every id up front so a bad reference fails clean, before anything is written.
    this.assertBindable(b.id, ids, "message");
    this.touchActor(actor);
    const id = shortId();
    const ts = now();
    const num = this.db.transaction(() => {
      const { n } = this.db.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM messages WHERE board_id = ?").get(b.id) as { n: number };
      this.db
        .query("INSERT INTO messages(id, board_id, num, author, author_kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, b.id, n, actor.name, actor.kind, body, ts);
      this.bindAttachments(b.id, "message_id", id, ids);
      return n;
    })();
    this.touchBoard(b.id);
    const attachments = this.attachmentsForOwners("message_id", [id]).get(id) ?? [];
    this.emit(actor, b.id, "message.posted", null, {
      num,
      ref: messageRef(num),
      body,
      attachments: ids.length,
      attachmentList: attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })),
      ...(level ? { level } : {}),
    });
    return { id, boardId: b.id, num, author: actor.name, authorKind: actor.kind, body, createdAt: ts, attachments, reactions: [] };
  }

  // ---------- reactions ----------

  /**
   * One message by its per-board `num` — the only public way to address a message (ADR 0018).
   * Not found is `not_found`, so the CLI exits 2 the same way a missing card does.
   */
  private messageRow(boardId: string, boardSlug: string, num: number): MessageRow {
    const n = Math.trunc(Number(num));
    const row = Number.isFinite(n)
      ? (this.db.query("SELECT * FROM messages WHERE board_id = ? AND num = ?").get(boardId, n) as MessageRow | null)
      : null;
    if (!row) throw new FlockError(`No message ${messageRef(num)} on board "${boardSlug}"`, "not_found");
    return row;
  }

  /** Aggregated reactions per message id, most-used emoji first, ties broken by first use. */
  private reactionsForMessages(messageIds: string[]): Map<string, Reaction[]> {
    const out = new Map<string, Reaction[]>();
    if (!messageIds.length) return out;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT message_id, emoji, actor, created_at FROM reactions WHERE message_id IN (${placeholders}) ORDER BY created_at, rowid`)
      .all(...messageIds) as { message_id: string; emoji: string; actor: string; created_at: string }[];
    for (const r of rows) {
      const list = out.get(r.message_id) ?? [];
      if (!out.has(r.message_id)) out.set(r.message_id, list);
      const existing = list.find((x) => x.emoji === r.emoji);
      if (existing) {
        existing.actors.push(r.actor);
        existing.count = existing.actors.length;
      } else {
        list.push({ emoji: r.emoji, count: 1, actors: [r.actor] });
      }
    }
    // Stable: rows already arrive oldest-first, so equal counts keep first-use order.
    for (const list of out.values()) list.sort((a, b) => b.count - a.count);
    return out;
  }

  private readMessage(row: MessageRow): Message {
    return this.rowToMessage(
      row,
      this.attachmentsForOwners("message_id", [row.id]).get(row.id) ?? [],
      this.reactionsForMessages([row.id]).get(row.id) ?? [],
    );
  }

  /**
   * Add `emoji` to message `num` as `actor`. Idempotent: reacting twice with the same emoji is a
   * no-op that emits nothing and returns `changed: false`, never an error. One row per
   * (message, actor, emoji), so an actor may hold several different emoji on one message.
   */
  react(actor: Actor, boardRef: string, num: number, emoji: string): ReactionResult {
    const b = this.board(boardRef);
    const e = normalizeEmoji(emoji);
    const row = this.messageRow(b.id, b.slug, num);
    this.touchActor(actor);
    const already = this.db
      .query("SELECT 1 AS x FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?")
      .get(row.id, actor.name, e) as { x: number } | null;
    if (already) return { message: this.readMessage(row), changed: false };
    this.db
      .query("INSERT INTO reactions(board_id, message_id, actor, actor_kind, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(b.id, row.id, actor.name, actor.kind, e, now());
    this.touchBoard(b.id);
    const message = this.readMessage(row);
    this.emit(actor, b.id, "message.reacted", null, reactionEventData(e, message));
    return { message, changed: true };
  }

  /** Remove `actor`'s `emoji` from message `num`. Idempotent the same way `react` is. */
  unreact(actor: Actor, boardRef: string, num: number, emoji: string): ReactionResult {
    const b = this.board(boardRef);
    const e = normalizeEmoji(emoji);
    const row = this.messageRow(b.id, b.slug, num);
    this.touchActor(actor);
    const { changes } = this.db
      .query("DELETE FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?")
      .run(row.id, actor.name, e);
    if (!changes) return { message: this.readMessage(row), changed: false };
    this.touchBoard(b.id);
    const message = this.readMessage(row);
    this.emit(actor, b.id, "message.unreacted", null, reactionEventData(e, message));
    return { message, changed: true };
  }

  // ---------- comment reactions ----------

  /** The next per-card comment number. Called inside the insert transaction, like card nums. */
  private nextCommentNum(cardId: string): number {
    return (this.db.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM comments WHERE card_id = ?").get(cardId) as { n: number }).n;
  }

  /**
   * One comment by its per-card `num` — the only public way to address a comment (ADR 0019).
   * Not found is `not_found`, so the CLI exits 2 the same way a missing card or message does.
   */
  private commentRow(cardId: string, cardNum: number, boardSlug: string, num: number): CommentRow {
    const n = Math.trunc(Number(num));
    const row = Number.isFinite(n)
      ? (this.db.query("SELECT * FROM comments WHERE card_id = ? AND num = ?").get(cardId, n) as CommentRow | null)
      : null;
    if (!row) throw new FlockError(`No comment ${commentRef(cardNum, num)} on board "${boardSlug}"`, "not_found");
    return row;
  }

  /** Aggregated reactions per comment id, most-used emoji first, ties broken by first use. */
  private reactionsForComments(commentIds: string[]): Map<string, Reaction[]> {
    const out = new Map<string, Reaction[]>();
    if (!commentIds.length) return out;
    const placeholders = commentIds.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT comment_id, emoji, actor, created_at FROM comment_reactions WHERE comment_id IN (${placeholders}) ORDER BY created_at, rowid`)
      .all(...commentIds) as { comment_id: string; emoji: string; actor: string; created_at: string }[];
    for (const r of rows) {
      const list = out.get(r.comment_id) ?? [];
      if (!out.has(r.comment_id)) out.set(r.comment_id, list);
      const existing = list.find((x) => x.emoji === r.emoji);
      if (existing) {
        existing.actors.push(r.actor);
        existing.count = existing.actors.length;
      } else {
        list.push({ emoji: r.emoji, count: 1, actors: [r.actor] });
      }
    }
    // Stable: rows already arrive oldest-first, so equal counts keep first-use order.
    for (const list of out.values()) list.sort((a, b) => b.count - a.count);
    return out;
  }

  private readComment(row: CommentRow, cardNum: number): Comment {
    return this.rowToComment(
      row,
      cardNum,
      this.attachmentsForOwners("comment_id", [row.id]).get(row.id) ?? [],
      this.reactionsForComments([row.id]).get(row.id) ?? [],
    );
  }

  /**
   * Add `emoji` to comment `num` on card `ref` as `actor`. The message twin of `react`, with the
   * card in front because a comment is addressed through its card. Idempotent: reacting twice
   * with the same emoji is a no-op that emits nothing and returns `changed: false`, never an
   * error. One row per (comment, actor, emoji), so an actor may hold several emoji on one comment.
   */
  reactToComment(actor: Actor, boardRef: string, ref: string | number, num: number, emoji: string): CommentReactionResult {
    const b = this.board(boardRef);
    const e = normalizeEmoji(emoji);
    const c = this.card(b.id, ref);
    const row = this.commentRow(c.id, c.num, b.slug, num);
    this.touchActor(actor);
    const already = this.db
      .query("SELECT 1 AS x FROM comment_reactions WHERE comment_id = ? AND actor = ? AND emoji = ?")
      .get(row.id, actor.name, e) as { x: number } | null;
    if (already) return { comment: this.readComment(row, c.num), changed: false };
    this.db
      .query("INSERT INTO comment_reactions(board_id, comment_id, actor, actor_kind, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(b.id, row.id, actor.name, actor.kind, e, now());
    this.touchBoard(b.id);
    const comment = this.readComment(row, c.num);
    this.emit(actor, b.id, "comment.reacted", c.num, commentReactionEventData(e, comment));
    const answeredCard = this.answerViaReactionIfPending(actor, b.id, c, row, e);
    return { comment, changed: true, ...(answeredCard ? { answeredCard } : {}) };
  }

  /**
   * A human reacting to the card's still-pending question answers it, the same way typing the
   * answer would (card 76): the emoji itself becomes the answer text, and `card.answered`
   * carries `viaReaction: true` alongside it so listeners (the conductor skill's approve/reject
   * table) can treat it exactly like a typed 👍/👎. An agent's reaction never answers — only a
   * human's word counts as approval. And it only fires for the *pending* question: the highest
   * `question`-kind comment on the card while it is still `awaiting-human`. Reacting to an
   * older, already-resolved question (or to any other comment kind) is an ordinary reaction;
   * unreacting is never routed here, so removing a reaction never un-answers.
   */
  private answerViaReactionIfPending(actor: Actor, boardId: string, c: Card, row: CommentRow, emoji: string): Card | undefined {
    if (actor.kind !== "human" || c.status !== "awaiting-human" || row.kind !== "question") return undefined;
    const latest = this.db.query("SELECT COALESCE(MAX(num), 0) AS n FROM comments WHERE card_id = ? AND kind = 'question'").get(c.id) as { n: number };
    if (row.num !== latest.n) return undefined;
    const next: CardStatus = c.assignee ? "doing" : "todo";
    this.db
      .query("UPDATE cards SET status = ?, question = NULL, question_by = NULL, updated_at = ? WHERE id = ?")
      .run(next, now(), c.id);
    this.addComment(actor, boardId, c.num, emoji, "answer");
    this.touchBoard(boardId);
    this.emit(actor, boardId, "card.answered", c.num, { answer: emoji, askedBy: c.questionBy, title: c.title, viaReaction: true });
    return this.card(boardId, c.num);
  }

  /** Remove `actor`'s `emoji` from comment `num` on card `ref`. Idempotent the same way `reactToComment` is. */
  unreactFromComment(actor: Actor, boardRef: string, ref: string | number, num: number, emoji: string): CommentReactionResult {
    const b = this.board(boardRef);
    const e = normalizeEmoji(emoji);
    const c = this.card(b.id, ref);
    const row = this.commentRow(c.id, c.num, b.slug, num);
    this.touchActor(actor);
    const { changes } = this.db
      .query("DELETE FROM comment_reactions WHERE comment_id = ? AND actor = ? AND emoji = ?")
      .run(row.id, actor.name, e);
    if (!changes) return { comment: this.readComment(row, c.num), changed: false };
    this.touchBoard(b.id);
    const comment = this.readComment(row, c.num);
    this.emit(actor, b.id, "comment.unreacted", c.num, commentReactionEventData(e, comment));
    return { comment, changed: true };
  }

  // ---------- decisions ----------

  private rowToDecision(r: DecisionRow): Decision {
    return {
      id: r.id, boardId: r.board_id, num: r.num, cardNum: r.card_num, gist: r.gist, author: r.author, createdAt: r.created_at,
      archivedAt: r.archived_at, archivedBy: r.archived_by, archiveReason: r.archive_reason, supersededBy: r.superseded_by,
    };
  }

  private decisionRow(boardId: string, num: number): DecisionRow | null {
    return this.db.query("SELECT * FROM decisions WHERE board_id = ? AND num = ?").get(boardId, num) as DecisionRow | null;
  }

  /**
   * Resolve a selector to rows, in `num` order. Explicit `nums`: any missing entry throws
   * `not_found` naming it, so an archive/restore call fails clean rather than partially. A
   * filter selector (`card`/`author`/`before`) matching nothing simply returns `[]` — see ADR
   * 0016; there is nothing to name as missing when the caller never named a number.
   *
   * A selector naming no field at all is `invalid`, never "every decision on the board": the
   * filter branch's only other clause is `board_id`, so falling through would turn an empty
   * `{}` or `{ nums: [] }` — which HTTP clients can send — into a board-wide archive.
   */
  private resolveDecisionSelector(boardId: string, boardSlug: string, sel: DecisionSelector): DecisionRow[] {
    if (sel.nums !== undefined) {
      if (sel.nums.length === 0) return [];
      const byNum = new Map<number, DecisionRow>();
      for (const n of sel.nums) {
        const row = this.decisionRow(boardId, n);
        if (!row) throw new FlockError(`No decision d${n} on board "${boardSlug}"`, "not_found");
        byNum.set(n, row);
      }
      return [...byNum.values()].sort((a, b) => a.num - b.num);
    }
    if (sel.card === undefined && sel.author === undefined && sel.before === undefined) {
      throw new FlockError("A decision selector is required: nums, card, author or before", "invalid");
    }
    const clauses = ["board_id = ?"];
    const params: (string | number)[] = [boardId];
    if (sel.card !== undefined) { clauses.push("card_num = ?"); params.push(sel.card); }
    if (sel.author !== undefined) { clauses.push("author = ?"); params.push(sel.author); }
    if (sel.before !== undefined) { clauses.push("created_at < ?"); params.push(sel.before); }
    return this.db.query(`SELECT * FROM decisions WHERE ${clauses.join(" AND ")} ORDER BY num`).all(...params) as DecisionRow[];
  }

  /** Standing decisions by default; `archived: true` for only archived, `"all"` for every row. */
  decisions(boardRef: string, opts: { archived?: boolean | "all"; card?: number; author?: string } = {}): Decision[] {
    const b = this.board(boardRef);
    const clauses = ["board_id = ?"];
    const params: (string | number)[] = [b.id];
    if (opts.archived === true) clauses.push("archived_at IS NOT NULL");
    else if (opts.archived !== "all") clauses.push("archived_at IS NULL");
    if (opts.card !== undefined) { clauses.push("card_num = ?"); params.push(opts.card); }
    if (opts.author !== undefined) { clauses.push("author = ?"); params.push(opts.author); }
    const rows = this.db.query(`SELECT * FROM decisions WHERE ${clauses.join(" AND ")} ORDER BY num`).all(...params) as DecisionRow[];
    return rows.map((r) => this.rowToDecision(r));
  }

  /**
   * Record a decision. `opts.supersedes` archives that decision in the same transaction and
   * points it at the new one — a forwarding address, not a chain (ADR 0016). Superseding an
   * unknown num is `not_found`; superseding an already-archived one is `conflict`, since only
   * a standing decision can be superseded.
   */
  decide(actor: Actor, boardRef: string, gist: string, cardRef?: string | number | null, opts: { supersedes?: number } = {}): Decision {
    const b = this.board(boardRef);
    this.touchActor(actor);
    const cardNum = cardRef == null ? null : this.card(b.id, cardRef).num;
    const id = shortId();
    const ts = now();
    return this.db.transaction(() => {
      let superseded: DecisionRow | null = null;
      if (opts.supersedes !== undefined) {
        superseded = this.decisionRow(b.id, opts.supersedes);
        if (!superseded) throw new FlockError(`No decision d${opts.supersedes} on board "${b.slug}"`, "not_found");
        if (superseded.archived_at) {
          throw new FlockError(`d${opts.supersedes} is already archived; supersede the standing decision`, "conflict");
        }
      }
      const { n } = this.db.query("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM decisions WHERE board_id = ?").get(b.id) as { n: number };
      this.db
        .query("INSERT INTO decisions(id, board_id, card_num, gist, author, created_at, num) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, b.id, cardNum, gist, actor.name, ts, n);
      this.emit(actor, b.id, "decision.recorded", cardNum, opts.supersedes !== undefined ? { num: n, gist, supersedes: opts.supersedes } : { num: n, gist });
      if (superseded) {
        this.db
          .query("UPDATE decisions SET archived_at = ?, archived_by = ?, superseded_by = ? WHERE id = ?")
          .run(ts, actor.name, n, superseded.id);
        this.emit(actor, b.id, "decision.archived", superseded.card_num, { num: superseded.num, gist: superseded.gist, supersededBy: n });
      }
      this.touchBoard(b.id);
      return {
        id, boardId: b.id, num: n, cardNum, gist, author: actor.name, createdAt: ts,
        archivedAt: null, archivedBy: null, archiveReason: null, supersededBy: null,
      };
    })();
  }

  /**
   * Archive every decision the selector resolves to. Already-archived rows are skipped
   * silently — no write, no event — so re-archiving is a no-op, mirroring `unholdCard` on a
   * card that isn't held. Returns the rows actually changed, in `num` order.
   */
  archiveDecisions(actor: Actor, boardRef: string, sel: DecisionSelector, opts: { reason?: string } = {}): Decision[] {
    const b = this.board(boardRef);
    this.touchActor(actor);
    const rows = this.resolveDecisionSelector(b.id, b.slug, sel);
    const reason = opts.reason?.trim() || null;
    const ts = now();
    return this.db.transaction(() => {
      const changed: Decision[] = [];
      for (const row of rows) {
        if (row.archived_at) continue;
        this.db
          .query("UPDATE decisions SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ?")
          .run(ts, actor.name, reason, row.id);
        this.emit(actor, b.id, "decision.archived", row.card_num, reason ? { num: row.num, gist: row.gist, reason } : { num: row.num, gist: row.gist });
        changed.push(this.rowToDecision({ ...row, archived_at: ts, archived_by: actor.name, archive_reason: reason }));
      }
      if (changed.length) this.touchBoard(b.id);
      return changed;
    })();
  }

  /**
   * Restore every decision the selector resolves to: clears the archive metadata and the
   * supersede pointer, so a restored decision stands on its own again. Standing rows are
   * skipped silently. Returns the rows actually changed, in `num` order.
   */
  restoreDecisions(actor: Actor, boardRef: string, sel: DecisionSelector): Decision[] {
    const b = this.board(boardRef);
    this.touchActor(actor);
    const rows = this.resolveDecisionSelector(b.id, b.slug, sel);
    return this.db.transaction(() => {
      const changed: Decision[] = [];
      for (const row of rows) {
        if (!row.archived_at) continue;
        this.db
          .query("UPDATE decisions SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, superseded_by = NULL WHERE id = ?")
          .run(row.id);
        this.emit(actor, b.id, "decision.restored", row.card_num, { num: row.num, gist: row.gist });
        changed.push(this.rowToDecision({ ...row, archived_at: null, archived_by: null, archive_reason: null, superseded_by: null }));
      }
      if (changed.length) this.touchBoard(b.id);
      return changed;
    })();
  }

  // ---------- push ----------

  private rowToPushSubscription(r: PushSubscriptionRow): PushSubscriptionRecord {
    return {
      id: r.id,
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
      actor: r.actor,
      actorKind: r.actor_kind as ActorKind,
      boardId: r.board_id,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  }

  /**
   * Register or re-register a device. Upsert keyed on `endpoint`: a browser that re-subscribes
   * with the same endpoint rebinds the keys, actor, board scope and user agent, and keeps its
   * original `created_at`. Emits no event: a device registering is plumbing, not board history.
   */
  subscribePush(actor: Actor, input: PushSubscriptionInput): PushSubscriptionRecord {
    if (!input.endpoint || typeof input.endpoint !== "string") throw new FlockError("A subscription needs an endpoint", "invalid");
    if (!input.keys?.p256dh || !input.keys?.auth) throw new FlockError("A subscription needs keys.p256dh and keys.auth", "invalid");
    const id = shortId();
    const at = now();
    this.db
      .query(
        `INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, actor, actor_kind, board_id, user_agent, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           actor = excluded.actor,
           actor_kind = excluded.actor_kind,
           board_id = excluded.board_id,
           user_agent = excluded.user_agent`,
      )
      .run(id, input.endpoint, input.keys.p256dh, input.keys.auth, actor.name, actor.kind, input.boardId ?? null, input.userAgent ?? null, at);
    const row = this.db.query("SELECT * FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint) as PushSubscriptionRow;
    return this.rowToPushSubscription(row);
  }

  /** Remove one device. Returns false when the endpoint was not registered. Idempotent. Emits no event. */
  unsubscribePush(endpoint: string): boolean {
    const result = this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    return result.changes > 0;
  }

  /**
   * Subscriptions, newest first.
   * `boardId` returns the board's own subscriptions *plus* every global (board_id IS NULL) one —
   * that is the set a board event has to notify.
   * `actor` filters to one person, for the web app's "on for this device" readback.
   */
  pushSubscriptions(opts: { boardId?: string; actor?: string } = {}): PushSubscriptionRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.boardId !== undefined) {
      clauses.push("(board_id IS NULL OR board_id = ?)");
      params.push(opts.boardId);
    }
    if (opts.actor !== undefined) {
      clauses.push("actor = ?");
      params.push(opts.actor);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM push_subscriptions ${where} ORDER BY created_at DESC`).all(...params) as PushSubscriptionRow[];
    return rows.map((r) => this.rowToPushSubscription(r));
  }

  /** Stamp `last_used_at` after a successful send. Silent no-op on an unknown endpoint. */
  touchPushSubscription(endpoint: string): void {
    this.db.query("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?").run(now(), endpoint);
  }

  /**
   * Take or renew the single-writer lease on push delivery for this database (ADR 0023).
   *
   * Several `flock serve` processes routinely share `~/.flock/flock.db`, and each one runs its own
   * push pump over the same events table. Whoever holds this lease delivers; everyone else stays
   * quiet, so one event is one notification per device however many servers are up.
   *
   * The claim is a single upserting statement, so it is atomic under SQLite's write lock: the
   * `WHERE` only lets a writer through when it already owns the lease (a renewal) or when the
   * incumbent's lease has expired (a takeover after a crash or a `kill -9`). Returns whether the
   * caller holds it afterwards. `at` and `ttlMs` are epoch/duration milliseconds on the caller's
   * clock, which is the pump's injected clock.
   */
  acquirePushLease(input: { owner: string; ttlMs: number; at: number; pid?: number }): boolean {
    const owner = input.owner?.trim();
    if (!owner) throw new FlockError("A push lease needs an owner", "invalid");
    if (!Number.isFinite(input.at)) throw new FlockError("A push lease needs a finite `at`", "invalid");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_PUSH_LEASE_TTL_MS) {
      throw new FlockError(`A push lease ttl must be between 1 and ${MAX_PUSH_LEASE_TTL_MS} ms`, "invalid");
    }
    this.db
      .query(
        `INSERT INTO push_lease(id, owner, pid, acquired_at, expires_at)
         VALUES ('singleton', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner,
           pid = excluded.pid,
           acquired_at = CASE WHEN push_lease.owner = excluded.owner THEN push_lease.acquired_at ELSE excluded.acquired_at END,
           expires_at = excluded.expires_at
         WHERE push_lease.owner = excluded.owner OR push_lease.expires_at <= ?`,
      )
      .run(owner, input.pid ?? null, now(), Math.floor(input.at + input.ttlMs), Math.floor(input.at));
    return this.pushLeaseOwner() === owner;
  }

  /** Who holds the push lease right now, expiry ignored, or null when nobody ever has. */
  pushLeaseOwner(): string | null {
    const row = this.db.query("SELECT owner FROM push_lease WHERE id = 'singleton'").get() as { owner: string } | null;
    return row?.owner ?? null;
  }

  /**
   * Give the lease up, so the next process to tick takes over immediately instead of waiting out
   * the ttl. A no-op unless `owner` is the current holder: a process that already lost the lease
   * must never evict whoever took it. Called from the pump's shutdown path.
   */
  releasePushLease(owner: string): boolean {
    const result = this.db.query("DELETE FROM push_lease WHERE id = 'singleton' AND owner = ?").run(owner);
    return result.changes > 0;
  }

  // ---------- notification settings (ADR 0024) ----------

  private rowToNotifySettingsFields(r: NotifySettingsRow): NotifySettingsFields {
    return {
      needsMe: boolFromCol(r.needs_me),
      review: boolFromCol(r.review),
      info: boolFromCol(r.info),
      settled: boolFromCol(r.settled),
      settledAfterMs: r.settled_after_ms,
    };
  }

  /**
   * The raw stored override for one (actor, board) row, `null` fields meaning "inherit". `null`
   * overall when nothing has ever been written there. `boardId` `''` reads that actor's global
   * row; it never denotes a real board.
   */
  notifySettings(actor: string, boardId: string): NotifySettingsFields | null {
    const row = this.db.query("SELECT * FROM notify_settings WHERE actor = ? AND board_id = ?").get(actor, boardId) as NotifySettingsRow | null;
    return row ? this.rowToNotifySettingsFields(row) : null;
  }

  /**
   * Concrete settings for an actor on a board: the board's own row, else the global (`''`) row,
   * else `DEFAULT_NOTIFY_SETTINGS`, per field. `boardId` `''` resolves the global row against
   * just the default, since there is no more specific row to prefer.
   */
  resolveNotifySettings(actor: string, boardId: string): NotifySettings {
    const global = this.notifySettings(actor, "");
    const board = boardId === "" ? null : this.notifySettings(actor, boardId);
    return resolveNotifySettingsFields(global, board);
  }

  /**
   * Validates and upserts a per-actor override (`boardId` `''` = global). Only the fields present
   * in `patch` change; a field set to `null` explicitly clears back to "inherit", while an absent
   * field keeps whatever is already stored. `boardId` must name a real board unless it is `''`.
   * `settledAfterMs` is clamped, never rejected, per the ADR.
   */
  putNotifySettings(actor: Actor, boardId: string, patch: Partial<NotifySettingsFields>): NotifySettingsFields {
    if (boardId !== "") this.board(boardId); // throws not_found on a bad board id
    this.touchActor(actor);
    const current = this.notifySettings(actor.name, boardId) ?? { needsMe: null, review: null, info: null, settled: null, settledAfterMs: null };
    const next: NotifySettingsFields = {
      needsMe: "needsMe" in patch ? patch.needsMe ?? null : current.needsMe,
      review: "review" in patch ? patch.review ?? null : current.review,
      info: "info" in patch ? patch.info ?? null : current.info,
      settled: "settled" in patch ? patch.settled ?? null : current.settled,
      settledAfterMs: "settledAfterMs" in patch ? clampedOrNull(patch.settledAfterMs) : current.settledAfterMs,
    };
    this.db
      .query(
        `INSERT INTO notify_settings(actor, board_id, needs_me, review, info, settled, settled_after_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(actor, board_id) DO UPDATE SET
           needs_me = excluded.needs_me, review = excluded.review, info = excluded.info,
           settled = excluded.settled, settled_after_ms = excluded.settled_after_ms, updated_at = excluded.updated_at`,
      )
      .run(actor.name, boardId, colFromBool(next.needsMe), colFromBool(next.review), colFromBool(next.info), colFromBool(next.settled), next.settledAfterMs, now());
    return next;
  }

  // ---------- telemetry (ADR 0026) ----------

  /**
   * Upsert one harness session reading. Core does no filesystem work and never resolves a
   * transcript itself — this is the write path a reader (`packages/harness`) or the telemetry
   * hook calls after doing that work elsewhere. No event is emitted: a refresh is not something
   * that happened on the board (ADR 0026 §2).
   */
  recordSessionReading(reading: SessionReading): void {
    upsertSessionReading(this.db, reading);
  }

  /** Every harness session that worked one card. See ADR 0026 §1: a group-by over `events`. */
  sessionsForCard(boardRef: string, cardNum: number): HarnessSessionTelemetry[] {
    const b = this.board(boardRef);
    return querySessionsForCard(this.db, b.id, cardNum);
  }

  /** Every harness session one actor ran on one board. Same shape as `sessionsForCard`. */
  sessionsForActor(boardRef: string, actorName: string): HarnessSessionTelemetry[] {
    const b = this.board(boardRef);
    return querySessionsForActor(this.db, b.id, actorName);
  }

  /** flock's own claim-to-close duration for a card. Never needs a harness. */
  cardDuration(boardRef: string, cardNum: number): CardDuration {
    const b = this.board(boardRef);
    return queryCardDuration(this.db, b.id, cardNum);
  }

  // ---------- aggregate ----------

  /** Everything a session needs to orient on a board in one read. */
  snapshot(boardRef: string) {
    const board = this.board(boardRef);
    const cards = this.listCards(board.id);
    const archivedDecisionCount = (
      this.db.query("SELECT COUNT(*) AS n FROM decisions WHERE board_id = ? AND archived_at IS NOT NULL").get(board.id) as { n: number }
    ).n;
    return {
      board,
      cards,
      decisions: this.decisions(board.id),
      archivedDecisionCount,
      messages: this.messages(board.id, { limit: 50 }),
      lastSeq: this.lastSeq(board.id),
      team: this.boardActors(board.id),
      counts: Object.fromEntries(CARD_STATUSES.map((s) => [s, cards.filter((c) => c.status === s).length])) as Record<CardStatus, number>,
      frontier: cards.filter((c) => c.status === "todo" && !c.assignee && !c.blocked && !c.held).map((c) => c.num),
      held: cards.filter((c) => c.held).map((c) => c.num),
    };
  }
}

export const BOARD_STATE_RANK: Record<BoardState, number> = {
  awaiting: 0,
  working: 1,
  idle: 2,
  complete: 3,
  archived: 4,
};

export function boardStateOf(counts: Record<CardStatus, number>, status: Board["status"]): BoardState {
  if (status === "archived") return "archived";
  if (counts["awaiting-human"] > 0) return "awaiting";
  if (counts.doing > 0) return "working";
  const total = CARD_STATUSES.reduce((n, s) => n + counts[s], 0);
  if (total === 0 || counts.todo > 0) return "idle";
  return "complete";
}

export function compareBoardSummaries(a: BoardSummary, b: BoardSummary): number {
  const rankDiff = BOARD_STATE_RANK[a.state] - BOARD_STATE_RANK[b.state];
  if (rankDiff !== 0) return rankDiff;
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) return titleDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Absolute, no trailing slash, so equality and ancestor checks are exact. */
export function normalizeProject(dir: string): string {
  const abs = resolve(dir);
  return abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Coerce to a positive integer, or null when absent/invalid. */
function coercePositiveInt(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Math.trunc(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
