import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ATTACHMENT_MIMES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, ORPHAN_TTL_MS, normalizeMime, sanitizeAttachmentName, sniffImageMime } from "./attachments.ts";
import { openDatabase } from "./db.ts";
import { setTaskChecked, taskItems } from "./tasks.ts";
import {
  ACTOR_CARD_ROLES,
  CARD_STATUSES,
  CLOSED_STATUSES,
  FlockError,
  type Actor,
  type ActorCard,
  type ActorCardRole,
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
  type DoingCard,
  type Event,
  type EventType,
  type Message,
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
};
type CommentRow = { id: string; card_id: string; author: string; author_kind: string; kind: string; body: string; created_at: string };
type MessageRow = { id: string; board_id: string; author: string; author_kind: string; body: string; created_at: string };
type AttachmentRow = {
  id: string; board_id: string; message_id: string | null; comment_id: string | null; author: string; author_kind: string;
  mime: string; name: string | null; size: number; sha256: string; width: number | null; height: number | null; created_at: string;
};
type DecisionRow = { id: string; board_id: string; card_num: number | null; gist: string; author: string; created_at: string };
type EventRow = {
  seq: number; board_id: string; actor: string; actor_kind: string; type: string; card_num: number | null; data: string; created_at: string;
  harness: string | null; model: string | null; effort: string | null;
};

export interface CardFilter {
  status?: CardStatus | CardStatus[];
  assignee?: string;
  label?: string;
  /** Only open, unblocked, unclaimed cards. */
  frontier?: boolean;
  open?: boolean;
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

  constructor(pathOrDb: string | Database) {
    this.db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  }

  close() {
    this.db.close();
  }

  // ---------- actors ----------

  touchActor(actor: Actor) {
    // Only overwrite a runtime column when the incoming value is non-null, so a later
    // runtime-less write does not erase a known model/harness/effort.
    this.db
      .query(
        `INSERT INTO actors(name, kind, last_seen, harness, model, effort) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind,
           last_seen = excluded.last_seen,
           harness = COALESCE(excluded.harness, actors.harness),
           model = COALESCE(excluded.model, actors.model),
           effort = COALESCE(excluded.effort, actors.effort)`,
      )
      .run(actor.name, actor.kind, now(), actor.harness ?? null, actor.model ?? null, actor.effort ?? null);
  }

  listActors(): { name: string; kind: Actor["kind"]; lastSeen: string; harness?: string; model?: string; effort?: string }[] {
    return (this.db.query("SELECT name, kind, last_seen, harness, model, effort FROM actors ORDER BY last_seen DESC").all() as any[]).map((r) => ({
      name: r.name,
      kind: r.kind,
      lastSeen: r.last_seen,
      ...(r.harness ? { harness: r.harness } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
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
        "INSERT INTO events(board_id, actor, actor_kind, type, card_num, data, created_at, harness, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(boardId, actor.name, actor.kind, type, cardNum, JSON.stringify(data), now(), actor.harness ?? null, actor.model ?? null, actor.effort ?? null);
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

  private rowToCard(r: CardRow): Card {
    const blockers = this.blockersOf(r.id);
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
      position: r.position,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
      blockedBy: blockers.map((b) => b.num),
      blocked: blockers.some((b) => b.open),
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
    if (filter.frontier) cards = cards.filter((c) => c.status === "todo" && !c.assignee && !c.blocked);
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
    this.db.transaction(() => {
      this.db
        .query("UPDATE cards SET status = ?, closed_at = ?, question = CASE WHEN ? = 'awaiting-human' THEN question ELSE NULL END, question_by = CASE WHEN ? = 'awaiting-human' THEN question_by ELSE NULL END, updated_at = ? WHERE id = ?")
        .run(status, closed ? ts : null, status, status, ts, c.id);
      if (reason) {
        commentId = shortId();
        this.db
          .query("INSERT INTO comments(id, card_id, author, author_kind, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(commentId, c.id, actor.name, actor.kind, "comment", reason, ts);
        this.bindAttachments(c.boardId, "comment_id", commentId, attachmentIds);
      }
      this.emit(actor, c.boardId, closed ? "card.closed" : "card.moved", c.num, { from: c.status, to: status });
      if (reason) {
        const attachments = commentId ? (this.attachmentsForOwners("comment_id", [commentId]).get(commentId) ?? []) : [];
        this.emit(actor, c.boardId, "comment.posted", c.num, {
          kind: "comment",
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
         WHERE c.status = 'awaiting-human' AND b.status = 'active' ORDER BY c.updated_at`,
      )
      .all() as (CardRow & { board_slug: string; board_title: string })[];
    return rows.map((r) => ({ ...this.rowToCard(r), boardSlug: r.board_slug, boardTitle: r.board_title }));
  }

  // ---------- comments ----------

  private rowToComment(r: CommentRow, attachments: Attachment[] = []): Comment {
    return { id: r.id, cardId: r.card_id, author: r.author, authorKind: r.author_kind as Actor["kind"], kind: r.kind as CommentKind, body: r.body, createdAt: r.created_at, attachments };
  }

  comments(boardRef: string, ref: string | number): Comment[] {
    const c = this.card(boardRef, ref);
    const rows = this.db.query("SELECT * FROM comments WHERE card_id = ? ORDER BY created_at, rowid").all(c.id) as CommentRow[];
    const byComment = this.attachmentsForOwners("comment_id", rows.map((r) => r.id));
    return rows.map((r) => this.rowToComment(r, byComment.get(r.id) ?? []));
  }

  /**
   * Post a comment on a card. `opts.attachments` are ids from `attach()`, bound here in order —
   * the same mechanism a channel message uses (#46), so an image reads the same either side.
   * A comment with an image needs no text.
   */
  addComment(actor: Actor, boardRef: string, ref: string | number, body: string, kind: CommentKind = "comment", opts?: { attachments?: string[] }): Comment {
    const c = this.card(boardRef, ref);
    const ids = opts?.attachments ?? [];
    if (!body.trim() && ids.length === 0) throw new FlockError("a comment needs a body or an attachment");
    // Validate every id up front so a bad reference fails clean, before anything is written.
    this.assertBindable(c.boardId, ids, "comment");
    this.touchActor(actor);
    const id = shortId();
    const ts = now();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO comments(id, card_id, author, author_kind, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, c.id, actor.name, actor.kind, kind, body, ts);
      this.bindAttachments(c.boardId, "comment_id", id, ids);
    })();
    this.db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(ts, c.id);
    this.touchBoard(c.boardId);
    const attachments = this.attachmentsForOwners("comment_id", [id]).get(id) ?? [];
    if (kind === "comment" || kind === "resolution") {
      this.emit(actor, c.boardId, "comment.posted", c.num, {
        kind,
        body,
        attachments: ids.length,
        attachmentList: attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })),
      });
    }
    return this.rowToComment(this.db.query("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow, attachments);
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
    const attachmentsByMessage = this.attachmentsForOwners("message_id", rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      boardId: r.board_id,
      author: r.author,
      authorKind: r.author_kind as Actor["kind"],
      body: r.body,
      createdAt: r.created_at,
      attachments: attachmentsByMessage.get(r.id) ?? [],
    }));
  }

  say(actor: Actor, boardRef: string, body: string, opts?: { attachments?: string[] }): Message {
    const b = this.board(boardRef);
    const ids = opts?.attachments ?? [];
    if (!body.trim() && ids.length === 0) throw new FlockError("a message needs a body or an attachment");
    // Validate every id up front so a bad reference fails clean, before anything is written.
    this.assertBindable(b.id, ids, "message");
    this.touchActor(actor);
    const id = shortId();
    const ts = now();
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO messages(id, board_id, author, author_kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, b.id, actor.name, actor.kind, body, ts);
      this.bindAttachments(b.id, "message_id", id, ids);
    })();
    this.touchBoard(b.id);
    const attachments = this.attachmentsForOwners("message_id", [id]).get(id) ?? [];
    this.emit(actor, b.id, "message.posted", null, {
      body,
      attachments: ids.length,
      attachmentList: attachments.map((a) => ({ id: a.id, mime: a.mime, name: a.name, size: a.size })),
    });
    return { id, boardId: b.id, author: actor.name, authorKind: actor.kind, body, createdAt: ts, attachments };
  }

  // ---------- decisions ----------

  decisions(boardRef: string): Decision[] {
    const b = this.board(boardRef);
    const rows = this.db.query("SELECT * FROM decisions WHERE board_id = ? ORDER BY created_at, rowid").all(b.id) as DecisionRow[];
    return rows.map((r) => ({ id: r.id, boardId: r.board_id, cardNum: r.card_num, gist: r.gist, author: r.author, createdAt: r.created_at }));
  }

  decide(actor: Actor, boardRef: string, gist: string, cardRef?: string | number | null): Decision {
    const b = this.board(boardRef);
    this.touchActor(actor);
    const cardNum = cardRef == null ? null : this.card(b.id, cardRef).num;
    const id = shortId();
    const ts = now();
    this.db
      .query("INSERT INTO decisions(id, board_id, card_num, gist, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, b.id, cardNum, gist, actor.name, ts);
    this.touchBoard(b.id);
    this.emit(actor, b.id, "decision.recorded", cardNum, { gist });
    return { id, boardId: b.id, cardNum, gist, author: actor.name, createdAt: ts };
  }

  // ---------- aggregate ----------

  /** Everything a session needs to orient on a board in one read. */
  snapshot(boardRef: string) {
    const board = this.board(boardRef);
    const cards = this.listCards(board.id);
    return {
      board,
      cards,
      decisions: this.decisions(board.id),
      messages: this.messages(board.id, { limit: 50 }),
      lastSeq: this.lastSeq(board.id),
      team: this.boardActors(board.id),
      counts: Object.fromEntries(CARD_STATUSES.map((s) => [s, cards.filter((c) => c.status === s).length])) as Record<CardStatus, number>,
      frontier: cards.filter((c) => c.status === "todo" && !c.assignee && !c.blocked).map((c) => c.num),
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
