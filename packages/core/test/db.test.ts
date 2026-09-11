import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SchemaBehindError, SchemaVersionError, copyDatabase, openDatabase, readStamp, schemaStamp } from "../src/db.ts";
import { Flock } from "../src/flock.ts";

/** A fresh on-disk db path in a throwaway directory, since ":memory:" can't be reopened. */
function freshPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "flock-db-test-"));
  return { dir, path: join(dir, "flock.db") };
}

describe("openDatabase / schema_version", () => {
  test("a database with no stamp is adopted and stamped to SCHEMA_VERSION", () => {
    const { dir, path } = freshPath();
    try {
      const db = openDatabase(path);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database already at the current stamp opens cleanly", () => {
    const { dir, path } = freshPath();
    try {
      openDatabase(path).close();
      const db = openDatabase(path); // second open: already stamped at SCHEMA_VERSION
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database stamped with a future schema version is rejected without writing anything", () => {
    const { dir, path } = freshPath();
    try {
      // Simulate a newer binary having already migrated this database.
      const future = new Database(path, { create: true });
      future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
      future.close();

      expect(() => openDatabase(path)).toThrow(SchemaVersionError);

      // Nothing was written: no tables from SCHEMA were created, and the stamp is untouched.
      const check = new Database(path, { create: true });
      const tables = check
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      expect(tables.length).toBe(0);
      expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opening a v1 database adds the hold columns and re-stamps user_version to the current version", () => {
    const { dir, path } = freshPath();
    try {
      // Simulate a v1 database: a cards table with no hold_* columns, stamped at v1.
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE cards (
          id TEXT PRIMARY KEY, board_id TEXT NOT NULL, num INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo', assignee TEXT, labels TEXT NOT NULL DEFAULT '[]', question TEXT, question_by TEXT,
          position INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          closed_at TEXT, UNIQUE(board_id, num)
        );
      `);
      legacy.exec("PRAGMA user_version = 1;");
      legacy.close();

      const db = openDatabase(path);
      const cols = new Set((db.query("PRAGMA table_info(cards)").all() as { name: string }[]).map((c) => c.name));
      expect(cols.has("held_at")).toBe(true);
      expect(cols.has("held_by")).toBe(true);
      expect(cols.has("hold_reason")).toBe(true);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v3 database opens, gains push_subscriptions, and is re-stamped to the current version", () => {
    const { dir, path } = freshPath();
    try {
      // Simulate a v3 database: no push_subscriptions table yet.
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      legacy.exec("PRAGMA user_version = 3;");
      legacy.close();

      const db = openDatabase(path);
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      expect(tables.has("push_subscriptions")).toBe(true);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v6 database gains events.session, actors.session, and the harness_sessions table (ADR 0022)", () => {
    const { dir, path } = freshPath();
    try {
      // Simulate a v6 database: events/actors carry harness/model/effort but no session column,
      // and harness_sessions does not exist yet.
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, actor TEXT NOT NULL, actor_kind TEXT NOT NULL,
          type TEXT NOT NULL, card_num INTEGER, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
          harness TEXT, model TEXT, effort TEXT
        );
        CREATE TABLE actors (
          name TEXT PRIMARY KEY, kind TEXT NOT NULL, last_seen TEXT NOT NULL, harness TEXT, model TEXT, effort TEXT
        );
      `);
      legacy.exec("PRAGMA user_version = 6;");
      legacy.close();

      const db = openDatabase(path);
      const eventCols = new Set((db.query("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name));
      const actorCols = new Set((db.query("PRAGMA table_info(actors)").all() as { name: string }[]).map((c) => c.name));
      expect(eventCols.has("session")).toBe(true);
      expect(actorCols.has("session")).toBe(true);

      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      expect(tables.has("harness_sessions")).toBe(true);
      const sessionCols = new Set((db.query("PRAGMA table_info(harness_sessions)").all() as { name: string }[]).map((c) => c.name));
      for (const col of ["key", "harness", "session_id", "model", "cost_usd", "tool_calls", "liveness", "observed_at", "updated_at"]) {
        expect(sessionCols.has(col)).toBe(true);
      }

      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the error names both versions and tells the user to upgrade", () => {
    const { dir, path } = freshPath();
    try {
      const future = new Database(path, { create: true });
      future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`);
      future.close();

      try {
        openDatabase(path);
        throw new Error("expected openDatabase to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaVersionError);
        const e = err as SchemaVersionError;
        expect(e.dbVersion).toBe(SCHEMA_VERSION + 5);
        expect(e.binaryVersion).toBe(SCHEMA_VERSION);
        expect(e.message).toContain(String(SCHEMA_VERSION + 5));
        expect(e.message).toContain(String(SCHEMA_VERSION));
        expect(e.message.toLowerCase()).toContain("upgrade");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openDatabase policy (ADR 0021)", () => {
  test("migrate: false refuses an older stamp without writing anything", () => {
    const { dir, path } = freshPath();
    try {
      const old = new Database(path, { create: true });
      old.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
      old.close();

      expect(() => openDatabase(path, { migrate: false })).toThrow(SchemaBehindError);

      const check = new Database(path, { create: true });
      const tables = check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.length).toBe(0);
      expect(readStamp(check)).toBe(SCHEMA_VERSION - 1);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrate: false opens a database already at the current stamp", () => {
    const { dir, path } = freshPath();
    try {
      openDatabase(path).close();
      const db = openDatabase(path, { migrate: false });
      expect(readStamp(db)).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allowNewer opens a newer stamp, leaves it alone, and Flock reports the skew", () => {
    const { dir, path } = freshPath();
    try {
      openDatabase(path).close();
      const bump = new Database(path);
      bump.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
      bump.close();

      const f = new Flock(path, { allowNewer: true });
      expect(f.schemaSkew).toEqual({ dbVersion: SCHEMA_VERSION + 1, binaryVersion: SCHEMA_VERSION });
      // Reads and writes still work: the tables this build knows are all there.
      const b = f.createBoard({ name: "t", kind: "human" }, { title: "T", project: dir });
      expect(f.board(b.slug)?.title).toBe("T");
      expect(readStamp(f.db)).toBe(SCHEMA_VERSION + 1);
      f.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Flock at the current stamp reports no skew", () => {
    const f = new Flock(":memory:");
    expect(f.schemaSkew).toBeUndefined();
    f.close();
  });

  test("schemaStamp reads the stamp without creating or migrating, and reports 0 for a missing file", () => {
    const { dir, path } = freshPath();
    try {
      expect(schemaStamp(path)).toBe(0);
      expect(existsSync(path)).toBe(false);
      openDatabase(path).close();
      expect(schemaStamp(path)).toBe(SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copyDatabase seeds a consistent copy that a newer build can then migrate on its own", () => {
    const { dir, path } = freshPath();
    const dest = join(dir, "worktree", ".flock", "flock.db");
    try {
      const f = new Flock(path);
      f.createBoard({ name: "t", kind: "human" }, { title: "Shared", project: dir });
      f.close(); // rows may still sit in the -wal; VACUUM INTO must see them
      copyDatabase(path, dest);
      const g = new Flock(dest);
      expect(g.listBoards().map((b) => b.title)).toEqual(["Shared"]);
      g.close();
      expect(() => copyDatabase(path, dest)).toThrow(/Refusing to overwrite/);
      // The source is untouched.
      expect(schemaStamp(path)).toBe(SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copyDatabase of a missing source creates only the directory", () => {
    const { dir } = freshPath();
    const dest = join(dir, ".flock", "flock.db");
    try {
      copyDatabase(join(dir, "nope.db"), dest);
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(join(dir, ".flock"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
