import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock, FlockError, exportBoard, importBoard, messageGist, messageRef, type Actor } from "../src/index.ts";
import { SCHEMA_VERSION, openDatabase } from "../src/db.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Reactions" });
  return { f, board };
}

describe("message numbering", () => {
  test("messages get a per-board sequence, and a ref spelled m<n>", () => {
    const { f, board } = fresh();
    const one = f.say(ada, board.id, "first");
    const two = f.say(scout, board.id, "second");
    expect(one.num).toBe(1);
    expect(two.num).toBe(2);
    expect(messageRef(two.num)).toBe("m2");
    expect(f.messages(board.id).map((m) => m.num)).toEqual([1, 2]);
  });

  test("numbering is per board, not global", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });
    f.say(ada, board.id, "a");
    f.say(ada, board.id, "b");
    expect(f.say(ada, other.id, "a").num).toBe(1);
  });

  test("message.posted carries the num and the ref", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "hello");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.posted")!;
    expect(e.data.num).toBe(m.num);
    expect(e.data.ref).toBe("m1");
  });
});

describe("react / unreact", () => {
  test("adds a reaction, aggregated for display", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    const { message, changed } = f.react(scout, board.id, m.num, "🎉");
    expect(changed).toBe(true);
    expect(message.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
    expect(f.messages(board.id)[0].reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
  });

  test("reacting twice with the same emoji is idempotent, not an error", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react(scout, board.id, m.num, "🎉");
    const second = f.react(scout, board.id, m.num, "🎉");
    expect(second.changed).toBe(false);
    expect(second.message.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
    // No duplicate event either.
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "message.reacted")).toHaveLength(1);
  });

  test("several actors and several emoji on one message", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react(scout, board.id, m.num, "🎉");
    f.react(builder, board.id, m.num, "👀");
    f.react(builder, board.id, m.num, "🎉");
    f.react(ada, board.id, m.num, "🎉");
    const [first, second] = f.messages(board.id)[0].reactions;
    // Most-used first; ties keep first-use order.
    expect(first).toEqual({ emoji: "🎉", count: 3, actors: ["scout", "builder", "ada"] });
    expect(second).toEqual({ emoji: "👀", count: 1, actors: ["builder"] });
  });

  test("unreact removes only that actor's emoji, and is idempotent", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react(scout, board.id, m.num, "🎉");
    f.react(builder, board.id, m.num, "🎉");
    const gone = f.unreact(scout, board.id, m.num, "🎉");
    expect(gone.changed).toBe(true);
    expect(gone.message.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["builder"] }]);
    const again = f.unreact(scout, board.id, m.num, "🎉");
    expect(again.changed).toBe(false);
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "message.unreacted")).toHaveLength(1);
  });

  test("removing the last reaction leaves an empty list, not a zero-count row", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react(scout, board.id, m.num, "🎉");
    expect(f.unreact(scout, board.id, m.num, "🎉").message.reactions).toEqual([]);
  });

  test("an unknown message is not_found, so the CLI exits 2", () => {
    const { f, board } = fresh();
    f.say(ada, board.id, "only one");
    expect(() => f.react(scout, board.id, 99, "🎉")).toThrow(FlockError);
    try {
      f.react(scout, board.id, 99, "🎉");
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
      expect((e as FlockError).status).toBe(404);
      expect((e as FlockError).message).toContain("m99");
    }
    expect(() => f.unreact(scout, board.id, 99, "🎉")).toThrow(FlockError);
  });

  test("an empty, whitespace-carrying or overlong emoji is invalid", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    for (const bad of ["", "   ", "a b", "🎉 🎉", "nice work everyone!"]) {
      expect(() => f.react(scout, board.id, m.num, bad)).toThrow(FlockError);
    }
    // Surrounding whitespace is trimmed rather than rejected.
    expect(f.react(scout, board.id, m.num, " 🎉 ").message.reactions[0].emoji).toBe("🎉");
  });

  test("a ZWJ sequence survives as one emoji", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "family");
    const emoji = "👩‍👩‍👧‍👦";
    expect(f.react(scout, board.id, m.num, emoji).message.reactions[0]).toEqual({ emoji, count: 1, actors: ["scout"] });
  });

  test("reactions are scoped to their own message", () => {
    const { f, board } = fresh();
    const one = f.say(ada, board.id, "first");
    const two = f.say(ada, board.id, "second");
    f.react(scout, board.id, two.num, "🎉");
    const msgs = f.messages(board.id);
    expect(msgs.find((m) => m.num === one.num)!.reactions).toEqual([]);
    expect(msgs.find((m) => m.num === two.num)!.reactions).toHaveLength(1);
  });

  test("deleting the board takes its reactions with it", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "bye");
    f.react(scout, board.id, m.num, "👋");
    f.deleteBoard(ada, board.id);
    expect((f.db.query("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n).toBe(0);
  });
});

describe("reaction events", () => {
  test("message.reacted carries everything a listener needs without a second lookup", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "please review the parser");
    f.react(scout, board.id, m.num, "👀");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.reacted")!;
    expect(e.actor).toBe("scout");
    expect(e.actorKind).toBe("agent");
    expect(e.cardNum).toBeNull();
    expect(e.data).toEqual({
      emoji: "👀",
      num: m.num,
      ref: "m1",
      messageAuthor: "ada",
      messageAuthorKind: "human",
      gist: "please review the parser",
      count: 1,
    });
  });

  test("message.unreacted reports the count that is left", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react(scout, board.id, m.num, "🎉");
    f.react(builder, board.id, m.num, "🎉");
    f.unreact(builder, board.id, m.num, "🎉");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.unreacted")!;
    expect(e.actor).toBe("builder");
    expect(e.data.emoji).toBe("🎉");
    expect(e.data.count).toBe(1);
    expect(e.data.messageAuthor).toBe("ada");
  });

  test("the event carries the reacting agent's runtime like every other event", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "ship it");
    f.react({ ...scout, harness: "claude-code@2.1.0", model: "opus", effort: "high" }, board.id, m.num, "🎉");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.reacted")!;
    expect(e.model).toBe("opus");
    expect(e.harness).toBe("claude-code@2.1.0");
    expect(e.effort).toBe("high");
  });

  test("the gist collapses whitespace, truncates, and stands in for an image-only message", () => {
    expect(messageGist({ body: "  two\n   lines  ", attachments: [] })).toBe("two lines");
    const long = messageGist({ body: "x".repeat(400), attachments: [] });
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(messageGist({ body: "", attachments: [{}, {}] as never })).toBe("(2 images)");
    expect(messageGist({ body: "", attachments: [{}] as never })).toBe("(image)");
    expect(messageGist({ body: "", attachments: [] })).toBe("");
  });
});

describe("markdown export/import", () => {
  test("does not carry channel messages, so there is nothing for reactions to round-trip", () => {
    const { f, board } = fresh();
    const m = f.say(ada, board.id, "a message nobody exports");
    f.react(scout, board.id, m.num, "🎉");
    const md = exportBoard(f, board.id);
    expect(md).not.toContain("a message nobody exports");
    expect(md).not.toContain("🎉");
    const imported = importBoard(f, ada, md, { slug: "reactions-copy" });
    expect(f.messages(imported.id)).toEqual([]);
  });
});

describe("migration", () => {
  test("a v3 database gains message nums in reading order and the reactions table", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-reactions-"));
    const path = join(dir, "flock.db");
    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, board_id TEXT NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL,
          body TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO boards VALUES ('b1', 'old', 'Old', '', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO messages VALUES ('m_b', 'b1', 'ada', 'human', 'second', '2026-01-02T00:00:00.000Z');
        INSERT INTO messages VALUES ('m_a', 'b1', 'ada', 'human', 'first', '2026-01-01T00:00:00.000Z');
      `);
      legacy.exec("PRAGMA user_version = 3;");
      legacy.close();

      const db = openDatabase(path);
      const nums = db.query("SELECT id, num FROM messages ORDER BY num").all() as { id: string; num: number }[];
      expect(nums).toEqual([{ id: "m_a", num: 1 }, { id: "m_b", num: 2 }]);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='reactions'").get()).toBeTruthy();
      db.close();

      // A message posted after the migration continues the backfilled sequence.
      const f = new Flock(path);
      expect(f.say(ada, "old", "third").num).toBe(3);
      f.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
