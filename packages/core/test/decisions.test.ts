import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock, FlockError, exportBoard, importBoard, openDatabase, parseBoard, type Actor } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Decisions board" });
  return { f, board };
}

function freshPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "flock-decisions-test-"));
  return { dir, path: join(dir, "flock.db") };
}

describe("migration: num backfill", () => {
  test("a v2 database gets num backfilled in created_at, rowid order, and the migration is idempotent", () => {
    const { dir, path } = freshPath();
    try {
      // Simulate a v2 database: decisions with no num/archive columns, stamped at v2.
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY, board_id TEXT NOT NULL, card_num INTEGER, gist TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `);
      legacy.exec(
        "INSERT INTO boards(id, slug, title, body, status, created_at, updated_at) VALUES ('b1','b1','B1','','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
      );
      legacy.exec(
        `INSERT INTO decisions(id, board_id, card_num, gist, author, created_at) VALUES
         ('d1','b1',NULL,'first','ada','2026-01-01T00:00:01.000Z'),
         ('d2','b1',NULL,'second','ada','2026-01-01T00:00:02.000Z'),
         ('d3','b1',NULL,'third','ada','2026-01-01T00:00:03.000Z')`,
      );
      legacy.exec("PRAGMA user_version = 2;");
      legacy.close();

      const db = openDatabase(path);
      const rows = db.query("SELECT id, num FROM decisions ORDER BY created_at").all() as { id: string; num: number }[];
      expect(rows).toEqual([
        { id: "d1", num: 1 },
        { id: "d2", num: 2 },
        { id: "d3", num: 3 },
      ]);
      const cols = new Set((db.query("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name));
      for (const col of ["num", "archived_at", "archived_by", "archive_reason", "superseded_by"]) expect(cols.has(col)).toBe(true);
      db.close();

      // Re-opening (a second migrate() run) must be a no-op: nums unchanged.
      const reopened = openDatabase(path);
      const again = reopened.query("SELECT id, num FROM decisions ORDER BY created_at").all() as { id: string; num: number }[];
      expect(again).toEqual(rows);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decide", () => {
  test("allocates a per-board num starting at 1", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "first rule");
    const d2 = f.decide(ada, board.id, "second rule");
    expect(d1.num).toBe(1);
    expect(d2.num).toBe(2);
  });

  test("with supersedes, archives the old decision and points it at the new one in one transaction", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "old rule");
    const d2 = f.decide(ada, board.id, "new rule", null, { supersedes: d1.num });
    expect(d2.num).toBe(2);

    const standing = f.decisions(board.id);
    expect(standing.map((d) => d.num)).toEqual([2]);

    const archived = f.decisions(board.id, { archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ num: 1, archivedBy: "ada", supersededBy: 2 });
    expect(archived[0].archivedAt).not.toBeNull();
  });

  test("superseding an unknown num is not_found", () => {
    const { f, board } = fresh();
    expect(() => f.decide(ada, board.id, "new rule", null, { supersedes: 99 })).toThrow(FlockError);
    try {
      f.decide(ada, board.id, "new rule", null, { supersedes: 99 });
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
    }
  });

  test("superseding an already-archived decision is a conflict", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "old rule");
    f.archiveDecisions(ada, board.id, { nums: [d1.num] });
    expect(() => f.decide(ada, board.id, "new rule", null, { supersedes: d1.num })).toThrow(FlockError);
    try {
      f.decide(ada, board.id, "new rule", null, { supersedes: d1.num });
    } catch (e) {
      expect((e as FlockError).code).toBe("conflict");
    }
  });

  test("emits decision.recorded, then decision.archived when superseding", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "old rule");
    f.decide(ada, board.id, "new rule", null, { supersedes: d1.num });
    const types = f.events({ boardId: board.id }).map((e) => e.type);
    expect(types).toEqual(["board.created", "decision.recorded", "decision.recorded", "decision.archived"]);
  });
});

describe("listing", () => {
  test("default listing hides archived decisions", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "keep");
    const d2 = f.decide(ada, board.id, "drop");
    f.archiveDecisions(ada, board.id, { nums: [d2.num] });
    expect(f.decisions(board.id).map((d) => d.num)).toEqual([d1.num]);
  });

  test("archived: true lists only archived, 'all' lists every row, in num order", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "a");
    const d2 = f.decide(ada, board.id, "b");
    f.archiveDecisions(ada, board.id, { nums: [d1.num] });
    expect(f.decisions(board.id, { archived: true }).map((d) => d.num)).toEqual([d1.num]);
    expect(f.decisions(board.id, { archived: "all" }).map((d) => d.num)).toEqual([d1.num, d2.num]);
  });
});

describe("archiveDecisions / restoreDecisions", () => {
  test("archive by explicit num", () => {
    const { f, board } = fresh();
    const d = f.decide(ada, board.id, "rule");
    const archived = f.archiveDecisions(ada, board.id, { nums: [d.num] });
    expect(archived).toHaveLength(1);
    expect(archived[0].archivedAt).not.toBeNull();
    expect(f.decisions(board.id)).toHaveLength(0);
  });

  test("archive by selector: card", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Card" });
    f.decide(ada, board.id, "on this card", c.num);
    f.decide(ada, board.id, "not on a card");
    const archived = f.archiveDecisions(ada, board.id, { card: c.num });
    expect(archived.map((d) => d.gist)).toEqual(["on this card"]);
    expect(f.decisions(board.id).map((d) => d.gist)).toEqual(["not on a card"]);
  });

  test("archive by selector: by (author)", () => {
    const { f, board } = fresh();
    f.decide(ada, board.id, "ada's rule");
    f.decide(scout, board.id, "scout's rule");
    const archived = f.archiveDecisions(ada, board.id, { author: "scout" });
    expect(archived.map((d) => d.gist)).toEqual(["scout's rule"]);
  });

  test("archive by selector: before", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "old");
    // Backdate d1 so `before` has something to compare against.
    f.db.query("UPDATE decisions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(d1.id);
    f.decide(ada, board.id, "new");
    const archived = f.archiveDecisions(ada, board.id, { before: "2021-01-01" });
    expect(archived.map((d) => d.gist)).toEqual(["old"]);
  });

  test("a selector matching nothing returns []", () => {
    const { f, board } = fresh();
    f.decide(ada, board.id, "rule");
    expect(f.archiveDecisions(ada, board.id, { author: "nobody" })).toEqual([]);
  });

  test("an empty selector archives nothing — it never means the whole board", () => {
    const { f, board } = fresh();
    for (const g of ["one", "two", "three"]) f.decide(ada, board.id, g);

    // `{ nums: [] }` is "these zero decisions", not "every decision".
    expect(f.archiveDecisions(ada, board.id, { nums: [] })).toEqual([]);
    expect(f.restoreDecisions(ada, board.id, { nums: [] })).toEqual([]);
    expect(f.decisions(board.id)).toHaveLength(3);

    // A selector naming no field at all is a caller bug, not a board-wide archive.
    for (const call of [() => f.archiveDecisions(ada, board.id, {}), () => f.restoreDecisions(ada, board.id, {})]) {
      try {
        call();
        throw new Error("expected an invalid selector to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(FlockError);
        expect((e as FlockError).code).toBe("invalid");
      }
    }
    expect(f.decisions(board.id)).toHaveLength(3);
  });

  test("an explicit num that does not exist throws not_found", () => {
    const { f, board } = fresh();
    expect(() => f.archiveDecisions(ada, board.id, { nums: [42] })).toThrow(FlockError);
    try {
      f.archiveDecisions(ada, board.id, { nums: [42] });
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
    }
  });

  test("re-archiving an already-archived decision is an idempotent no-op: no write, no event", () => {
    const { f, board } = fresh();
    const d = f.decide(ada, board.id, "rule");
    f.archiveDecisions(ada, board.id, { nums: [d.num] }, { reason: "first" });
    const before = f.events({ boardId: board.id }).length;
    const again = f.archiveDecisions(ada, board.id, { nums: [d.num] }, { reason: "second" });
    expect(again).toEqual([]);
    expect(f.events({ boardId: board.id }).length).toBe(before);
    expect(f.decisions(board.id, { archived: true })[0].archiveReason).toBe("first");
  });

  test("restore round-trip clears archivedAt, archivedBy, archiveReason and supersededBy", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "old rule");
    f.decide(ada, board.id, "new rule", null, { supersedes: d1.num });
    const restored = f.restoreDecisions(ada, board.id, { nums: [d1.num] });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ archivedAt: null, archivedBy: null, archiveReason: null, supersededBy: null });
    expect(f.decisions(board.id).map((d) => d.num).sort()).toEqual([1, 2]);
  });

  test("restoring a standing decision is a no-op", () => {
    const { f, board } = fresh();
    const d = f.decide(ada, board.id, "rule");
    expect(f.restoreDecisions(ada, board.id, { nums: [d.num] })).toEqual([]);
  });
});

describe("snapshot", () => {
  test("decisions is standing-only, plus archivedDecisionCount", () => {
    const { f, board } = fresh();
    const d1 = f.decide(ada, board.id, "keep");
    const d2 = f.decide(ada, board.id, "drop");
    f.archiveDecisions(ada, board.id, { nums: [d2.num] });
    const snap = f.snapshot(board.id);
    expect(snap.decisions.map((d) => d.num)).toEqual([d1.num]);
    expect(snap.archivedDecisionCount).toBe(1);
  });
});

describe("markdown round-trip", () => {
  test("keeps archived decisions archived across export/import", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Card" });
    const d1 = f.decide(ada, board.id, "standing rule", c.num);
    const d2 = f.decide(ada, board.id, "retired rule");
    f.archiveDecisions(ada, board.id, { nums: [d2.num] }, { reason: "no longer applies" });

    const md = exportBoard(f, board.id);
    expect(md).toContain("## Decisions so far");
    expect(md).toContain("## Decisions (archived)");
    expect(md).toContain("- retired rule");
    expect(md).toContain(`- #${c.num}: standing rule`);

    const parsed = parseBoard(md);
    expect(parsed.decisions).toEqual([
      { cardNum: c.num, gist: "standing rule", archived: false },
      { cardNum: null, gist: "retired rule", archived: true },
    ]);

    const g = new Flock(":memory:");
    const imported = importBoard(g, ada, md);
    const snap = g.snapshot(imported.id);
    expect(snap.decisions.map((d) => d.gist)).toEqual(["standing rule"]);
    expect(snap.archivedDecisionCount).toBe(1);
    expect(g.decisions(imported.id, { archived: true })[0].gist).toBe("retired rule");
    expect(exportBoard(g, imported.id)).toBe(md);
  });
});
