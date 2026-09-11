import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { FlockError } from "./types.ts";

/**
 * The schema version this binary knows how to open, stamped into `PRAGMA user_version` (see ADR
 * 0012). SQLite defaults every database to `user_version = 0`, which doubles as "no stamp yet" —
 * every database that predates this guard is adopted at 0 rather than rejected. Bump this
 * whenever `SCHEMA` or `migrate()` below changes, and only ever add columns/tables/indexes:
 * migrations must stay additive so a newer binary can always read an older database.
 */
export const SCHEMA_VERSION = 4;

/**
 * Thrown by `openDatabase` when the database's stamped `user_version` is higher than this
 * binary's `SCHEMA_VERSION` — an older binary opening a database a newer binary already
 * migrated. Thrown before `SCHEMA` or `migrate()` run, so nothing is written. The CLI and server
 * both construct `Flock` at startup and let this surface as a normal `FlockError`: one line on
 * stderr, exit 1.
 */
export class SchemaVersionError extends FlockError {
  constructor(
    public readonly dbVersion: number,
    public readonly binaryVersion: number,
  ) {
    super(
      `This flock binary supports schema v${binaryVersion}, but the database is stamped v${dbVersion} (newer). Upgrade flock.`,
      "invalid",
    );
    this.name = "SchemaVersionError";
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  project TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  num INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  question_by TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  held_at TEXT,
  held_by TEXT,
  hold_reason TEXT,
  UNIQUE(board_id, num)
);
CREATE TABLE IF NOT EXISTS card_blockers (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  blocker_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, blocker_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_num INTEGER,
  gist TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  num INTEGER,
  archived_at TEXT,
  archived_by TEXT,
  archive_reason TEXT,
  superseded_by INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  type TEXT NOT NULL,
  card_num INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  effort TEXT
);
CREATE INDEX IF NOT EXISTS events_board_seq ON events(board_id, seq);
CREATE TABLE IF NOT EXISTS actors (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  effort TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS attachments_orphans ON attachments(board_id, message_id, created_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'human',
  board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS push_subs_actor ON push_subscriptions(actor);
CREATE INDEX IF NOT EXISTS push_subs_board ON push_subscriptions(board_id);
`;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  // Checked before SCHEMA or migrate() touch anything: a binary older than the database's stamp
  // must fail without writing a byte. `user_version` defaults to 0, which is indistinguishable
  // from "never stamped" — that's intentional, see SCHEMA_VERSION above.
  const dbVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (dbVersion > SCHEMA_VERSION) {
    db.close();
    throw new SchemaVersionError(dbVersion, SCHEMA_VERSION);
  }

  db.exec(SCHEMA);
  migrate(db);
  if (dbVersion !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Additive migrations for databases created by older versions. */
function migrate(db: Database) {
  const cols = new Set((db.query("PRAGMA table_info(boards)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("project")) db.exec("ALTER TABLE boards ADD COLUMN project TEXT");

  const eventCols = new Set((db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name));
  if (!eventCols.has("harness")) db.exec("ALTER TABLE events ADD COLUMN harness TEXT");
  if (!eventCols.has("model")) db.exec("ALTER TABLE events ADD COLUMN model TEXT");
  if (!eventCols.has("effort")) db.exec("ALTER TABLE events ADD COLUMN effort TEXT");

  const actorCols = new Set((db.query("PRAGMA table_info(actors)").all() as { name: string }[]).map((c) => c.name));
  if (!actorCols.has("harness")) db.exec("ALTER TABLE actors ADD COLUMN harness TEXT");
  if (!actorCols.has("model")) db.exec("ALTER TABLE actors ADD COLUMN model TEXT");
  if (!actorCols.has("effort")) db.exec("ALTER TABLE actors ADD COLUMN effort TEXT");

  // An attachment belongs to a message or to a card comment (#46); older databases only knew
  // about messages. SQLite cannot add a column with a foreign-key clause via ALTER TABLE, so the
  // back-filled column is a plain reference and orphan cleanup relies on the explicit delete in
  // `Flock` rather than ON DELETE CASCADE for these rows.
  const attachmentCols = new Set((db.query("PRAGMA table_info(attachments)").all() as { name: string }[]).map((c) => c.name));
  if (!attachmentCols.has("comment_id")) db.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT");
  // Indexed here rather than in SCHEMA: SCHEMA runs before the ALTER above, so on an older
  // database the column does not exist yet at that point.
  db.exec("CREATE INDEX IF NOT EXISTS attachments_comment ON attachments(comment_id)");

  // Hold (#18): a human gate on claiming, orthogonal to blockers. `held_at` is the flag;
  // the other two are metadata written and cleared with it.
  const cardCols = new Set((db.query("PRAGMA table_info(cards)").all() as { name: string }[]).map((c) => c.name));
  if (!cardCols.has("held_at")) db.exec("ALTER TABLE cards ADD COLUMN held_at TEXT");
  if (!cardCols.has("held_by")) db.exec("ALTER TABLE cards ADD COLUMN held_by TEXT");
  if (!cardCols.has("hold_reason")) db.exec("ALTER TABLE cards ADD COLUMN hold_reason TEXT");

  // Archive + supersede (ADR 0016): a per-board `num` so a decision can be addressed at all
  // (CLAUDE.md forbids exposing internal ids), plus archive metadata and a one-hop forwarding
  // pointer. Additive; `num` is backfilled below in the order `decisions()` already lists in.
  const decisionCols = new Set((db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name));
  if (!decisionCols.has("num")) db.exec("ALTER TABLE decisions ADD COLUMN num INTEGER");
  if (!decisionCols.has("archived_at")) db.exec("ALTER TABLE decisions ADD COLUMN archived_at TEXT");
  if (!decisionCols.has("archived_by")) db.exec("ALTER TABLE decisions ADD COLUMN archived_by TEXT");
  if (!decisionCols.has("archive_reason")) db.exec("ALTER TABLE decisions ADD COLUMN archive_reason TEXT");
  if (!decisionCols.has("superseded_by")) db.exec("ALTER TABLE decisions ADD COLUMN superseded_by INTEGER");
  db.exec(`
    UPDATE decisions SET num = (
      SELECT COUNT(*) FROM decisions d2
      WHERE d2.board_id = decisions.board_id
        AND (d2.created_at, d2.rowid) <= (decisions.created_at, decisions.rowid)
    ) WHERE num IS NULL
  `);
  // Indexed here rather than in SCHEMA: on a database migrated from v2, `num` does not exist
  // until the ALTER above runs, which happens after SCHEMA.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS decisions_board_num ON decisions(board_id, num)");
  db.exec("CREATE INDEX IF NOT EXISTS decisions_board_standing ON decisions(board_id, archived_at)");
}

export const DB_DIRNAME = ".flock";
export const DB_FILENAME = "flock.db";

/** Walk up from `from` looking for a .flock/ directory. */
export function findProjectDb(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, DB_DIRNAME, DB_FILENAME);
    if (existsSync(join(dir, DB_DIRNAME))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function globalDbPath(): string {
  return join(homedir(), DB_DIRNAME, DB_FILENAME);
}

/**
 * Resolution order: --db flag, FLOCK_DB env, a .flock/ directory walking up from cwd (opt-in
 * isolation via `flock init --local`), else the global ~/.flock/flock.db. The global file is the
 * default so one server shows every project; boards carry a `project` directory for scoping.
 */
export function resolveDbPath(explicit?: string): { path: string; source: "flag" | "env" | "project" | "global" } {
  if (explicit) return { path: resolve(explicit), source: "flag" };
  if (process.env.FLOCK_DB) return { path: resolve(process.env.FLOCK_DB), source: "env" };
  const project = findProjectDb();
  if (project) return { path: project, source: "project" };
  return { path: globalDbPath(), source: "global" };
}
