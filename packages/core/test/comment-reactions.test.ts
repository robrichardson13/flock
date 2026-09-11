import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Flock,
  FlockError,
  commentGist,
  commentRef,
  exportBoard,
  importBoard,
  parseCommentRef,
  type Actor,
} from "../src/index.ts";
import { SCHEMA_VERSION, openDatabase } from "../src/db.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

/** A board with one card, and a helper that posts a comment on it. */
function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Comment reactions" });
  const card = f.createCard(ada, board.id, { title: "Parse markdown" });
  return { f, board, card };
}

describe("comment numbering", () => {
  test("comments get a per-card sequence, and a ref spelled <card>.<n>", () => {
    const { f, board, card } = fresh();
    const one = f.addComment(ada, board.id, card.num, "first");
    const two = f.addComment(scout, board.id, card.num, "second");
    expect(one.num).toBe(1);
    expect(two.num).toBe(2);
    expect(one.cardNum).toBe(card.num);
    expect(commentRef(card.num, two.num)).toBe(`${card.num}.2`);
    expect(f.comments(board.id, card.num).map((c) => c.num)).toEqual([1, 2]);
  });

  test("numbering is per card, not per board", () => {
    const { f, board, card } = fresh();
    const other = f.createCard(ada, board.id, { title: "Other" });
    f.addComment(ada, board.id, card.num, "a");
    f.addComment(ada, board.id, card.num, "b");
    expect(f.addComment(ada, board.id, other.num, "a").num).toBe(1);
  });

  test("every kind of comment is numbered, so every one is reactable", () => {
    const { f, board, card } = fresh();
    f.askHuman(scout, board.id, card.num, "which parser?");
    f.answerHuman(ada, board.id, card.num, "the one we have");
    f.closeCard(scout, board.id, card.num, { resolution: "done" });
    expect(f.comments(board.id, card.num).map((c) => [c.kind, c.num])).toEqual([
      ["question", 1],
      ["answer", 2],
      ["resolution", 3],
    ]);
  });

  test("a move's reason comment takes the next number too", () => {
    const { f, board, card } = fresh();
    f.addComment(ada, board.id, card.num, "first");
    f.moveCard(scout, board.id, card.num, "doing", { reason: "picking this up" });
    const posted = f.events({ boardId: board.id }).filter((e) => e.type === "comment.posted");
    expect(posted.at(-1)!.data.num).toBe(2);
    expect(posted.at(-1)!.data.ref).toBe(`${card.num}.2`);
  });

  test("comment.posted carries the num and the ref", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "hello");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "comment.posted")!;
    expect(e.data.num).toBe(c.num);
    expect(e.data.ref).toBe(`${card.num}.1`);
  });

  test("commentRef and parseCommentRef are inverses, and reject what is not a comment ref", () => {
    expect(commentRef(4, 2)).toBe("4.2");
    expect(parseCommentRef("4.2")).toEqual({ cardNum: 4, num: 2 });
    expect(parseCommentRef(" #4.2 ")).toEqual({ cardNum: 4, num: 2 });
    for (const bad of ["4", "m4", "4.", ".2", "4.2.1", "0.1", "4.0", "", "nope"]) {
      expect(parseCommentRef(bad)).toBeNull();
    }
  });
});

describe("reactToComment / unreactFromComment", () => {
  test("adds a reaction, aggregated for display and carried on the card's thread", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    const { comment, changed } = f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    expect(changed).toBe(true);
    expect(comment.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
    expect(f.comments(board.id, card.num)[0].reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
  });

  test("reacting twice with the same emoji is idempotent, not an error", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    const second = f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    expect(second.changed).toBe(false);
    expect(second.comment.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "comment.reacted")).toHaveLength(1);
  });

  test("several actors and several emoji on one comment", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    f.reactToComment(builder, board.id, card.num, c.num, "👀");
    f.reactToComment(builder, board.id, card.num, c.num, "🎉");
    f.reactToComment(ada, board.id, card.num, c.num, "🎉");
    const [first, second] = f.comments(board.id, card.num)[0].reactions;
    // Most-used first; ties keep first-use order.
    expect(first).toEqual({ emoji: "🎉", count: 3, actors: ["scout", "builder", "ada"] });
    expect(second).toEqual({ emoji: "👀", count: 1, actors: ["builder"] });
  });

  test("unreact removes only that actor's emoji, and is idempotent", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    f.reactToComment(builder, board.id, card.num, c.num, "🎉");
    const gone = f.unreactFromComment(scout, board.id, card.num, c.num, "🎉");
    expect(gone.changed).toBe(true);
    expect(gone.comment.reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["builder"] }]);
    const again = f.unreactFromComment(scout, board.id, card.num, c.num, "🎉");
    expect(again.changed).toBe(false);
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "comment.unreacted")).toHaveLength(1);
  });

  test("removing the last reaction leaves an empty list, not a zero-count row", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    expect(f.unreactFromComment(scout, board.id, card.num, c.num, "🎉").comment.reactions).toEqual([]);
  });

  test("an unknown comment or card is not_found, so the CLI exits 2", () => {
    const { f, board, card } = fresh();
    f.addComment(ada, board.id, card.num, "only one");
    try {
      f.reactToComment(scout, board.id, card.num, 99, "🎉");
      expect.unreachable();
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
      expect((e as FlockError).status).toBe(404);
      expect((e as FlockError).message).toContain(`${card.num}.99`);
    }
    expect(() => f.unreactFromComment(scout, board.id, card.num, 99, "🎉")).toThrow(FlockError);
    expect(() => f.reactToComment(scout, board.id, 404, 1, "🎉")).toThrow(FlockError);
  });

  test("an empty, whitespace-carrying or overlong emoji is invalid", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    for (const bad of ["", "   ", "a b", "🎉 🎉", "nice work everyone!"]) {
      expect(() => f.reactToComment(scout, board.id, card.num, c.num, bad)).toThrow(FlockError);
    }
    // Surrounding whitespace is trimmed rather than rejected.
    expect(f.reactToComment(scout, board.id, card.num, c.num, " 🎉 ").comment.reactions[0].emoji).toBe("🎉");
  });

  test("a ZWJ sequence survives as one emoji", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "family");
    const emoji = "👩‍👩‍👧‍👦";
    expect(f.reactToComment(scout, board.id, card.num, c.num, emoji).comment.reactions[0]).toEqual({
      emoji,
      count: 1,
      actors: ["scout"],
    });
  });

  test("reactions are scoped to their own comment, and to their own card", () => {
    const { f, board, card } = fresh();
    const one = f.addComment(ada, board.id, card.num, "first");
    const two = f.addComment(ada, board.id, card.num, "second");
    const other = f.createCard(ada, board.id, { title: "Other" });
    f.addComment(ada, board.id, other.num, "elsewhere");
    f.reactToComment(scout, board.id, card.num, two.num, "🎉");
    const thread = f.comments(board.id, card.num);
    expect(thread.find((c) => c.num === one.num)!.reactions).toEqual([]);
    expect(thread.find((c) => c.num === two.num)!.reactions).toHaveLength(1);
    // Card #2's comment carries num 1 as well, and must not pick up card #1's reactions.
    expect(f.comments(board.id, other.num)[0].reactions).toEqual([]);
  });

  test("a comment reaction and a message reaction do not see each other", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    const m = f.say(ada, board.id, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    expect(f.messages(board.id).find((x) => x.num === m.num)!.reactions).toEqual([]);
    f.react(builder, board.id, m.num, "👀");
    expect(f.comments(board.id, card.num)[0].reactions).toEqual([{ emoji: "🎉", count: 1, actors: ["scout"] }]);
  });

  test("deleting the board takes its comment reactions with it", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "bye");
    f.reactToComment(scout, board.id, card.num, c.num, "👋");
    f.deleteBoard(ada, board.id);
    expect((f.db.query("SELECT COUNT(*) AS n FROM comment_reactions").get() as { n: number }).n).toBe(0);
  });
});

describe("comment reaction events", () => {
  test("comment.reacted carries everything a listener needs without a second lookup", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "please review the parser");
    f.reactToComment(scout, board.id, card.num, c.num, "👀");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "comment.reacted")!;
    expect(e.actor).toBe("scout");
    expect(e.actorKind).toBe("agent");
    expect(e.cardNum).toBe(card.num);
    expect(e.data).toEqual({
      emoji: "👀",
      card: card.num,
      num: c.num,
      ref: `${card.num}.1`,
      commentAuthor: "ada",
      commentAuthorKind: "human",
      gist: "please review the parser",
      count: 1,
    });
  });

  test("comment.unreacted reports the count that is left", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    f.reactToComment(builder, board.id, card.num, c.num, "🎉");
    f.unreactFromComment(builder, board.id, card.num, c.num, "🎉");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "comment.unreacted")!;
    expect(e.actor).toBe("builder");
    expect(e.data.emoji).toBe("🎉");
    expect(e.data.count).toBe(1);
    expect(e.data.commentAuthor).toBe("ada");
  });

  test("the event carries the reacting agent's runtime like every other event", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "ship it");
    f.reactToComment({ ...scout, harness: "claude-code@2.1.0", model: "opus", effort: "high" }, board.id, card.num, c.num, "🎉");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "comment.reacted")!;
    expect(e.model).toBe("opus");
    expect(e.harness).toBe("claude-code@2.1.0");
    expect(e.effort).toBe("high");
  });

  test("the gist collapses whitespace, truncates, and stands in for an image-only comment", () => {
    expect(commentGist({ body: "  two\n   lines  ", attachments: [] })).toBe("two lines");
    const long = commentGist({ body: "x".repeat(400), attachments: [] });
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(commentGist({ body: "", attachments: [{}, {}] as never })).toBe("(2 images)");
    expect(commentGist({ body: "", attachments: [{}] as never })).toBe("(image)");
    expect(commentGist({ body: "", attachments: [] })).toBe("");
  });
});

describe("markdown export/import", () => {
  test("does not carry comments, so there is nothing for their reactions to round-trip", () => {
    const { f, board, card } = fresh();
    const c = f.addComment(ada, board.id, card.num, "a comment nobody exports");
    f.reactToComment(scout, board.id, card.num, c.num, "🎉");
    const md = exportBoard(f, board.id);
    expect(md).not.toContain("a comment nobody exports");
    expect(md).not.toContain("🎉");
    const imported = importBoard(f, ada, md, { slug: "comment-reactions-copy" });
    expect(f.comments(imported.id, card.num)).toEqual([]);
  });
});

describe("migration", () => {
  test("a v5 database gains comment nums in reading order and the comment_reactions table", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-comment-reactions-"));
    const path = join(dir, "flock.db");
    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE cards (
          id TEXT PRIMARY KEY, board_id TEXT NOT NULL, num INTEGER NOT NULL, title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', assignee TEXT, labels TEXT NOT NULL DEFAULT '',
          question TEXT, question_by TEXT, position REAL NOT NULL DEFAULT 0, created_by TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
        );
        CREATE TABLE comments (
          id TEXT PRIMARY KEY, card_id TEXT NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'comment', body TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO boards VALUES ('b1', 'old', 'Old', '', NULL, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO cards VALUES ('c1', 'b1', 1, 'A card', '', 'todo', NULL, '[]', NULL, NULL, 1, 'ada', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
        INSERT INTO comments VALUES ('k_b', 'c1', 'ada', 'human', 'comment', 'second', '2026-01-02T00:00:00.000Z');
        INSERT INTO comments VALUES ('k_a', 'c1', 'ada', 'human', 'comment', 'first', '2026-01-01T00:00:00.000Z');
      `);
      legacy.exec("PRAGMA user_version = 5;");
      legacy.close();

      const db = openDatabase(path);
      const nums = db.query("SELECT id, num FROM comments ORDER BY num").all() as { id: string; num: number }[];
      expect(nums).toEqual([{ id: "k_a", num: 1 }, { id: "k_b", num: 2 }]);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='comment_reactions'").get()).toBeTruthy();
      db.close();

      // A comment posted after the migration continues the backfilled sequence.
      const f = new Flock(path);
      expect(f.addComment(ada, "old", 1, "third").num).toBe(3);
      f.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
