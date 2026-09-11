import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SchemaVersionError, openDatabase } from "../src/db.ts";

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
