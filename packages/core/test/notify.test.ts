import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  mergedNotification,
  notificationClass,
  notificationFor,
  notifyTargets,
  recipientsOf,
  summarize,
  levelFor,
  deliversAt,
  assertDeclarableLevel,
  resolveNotifySettingsFields,
  clampSettledThreshold,
  DEFAULT_NOTIFY_SETTINGS,
  SETTLED_THRESHOLD_MIN_MS,
  SETTLED_THRESHOLD_MAX_MS,
  openDatabase,
  SCHEMA_VERSION,
  Flock,
  FlockError,
  type NotificationPayload,
  type NotifyContext,
  type NotifyTarget,
  type PushSubscriptionRecord,
  type NotifySettingsFields,
  type Actor,
} from "../src/index.ts";
import type { Event } from "../src/index.ts";

const ctx: NotifyContext = { boardSlug: "flock", boardTitle: "flock" };
const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

function ev(partial: Partial<Event>): Event {
  return {
    seq: 1,
    boardId: "b1",
    actor: "ada",
    actorKind: "human",
    type: "message.posted",
    cardNum: null,
    data: {},
    createdAt: "2026-09-11T00:00:00.000Z",
    ...partial,
  };
}

function sub(partial: Partial<PushSubscriptionRecord>): PushSubscriptionRecord {
  return {
    id: "s1",
    endpoint: "https://push.example/s1",
    keys: { p256dh: "p", auth: "a" },
    actor: "scout",
    actorKind: "agent",
    boardId: null,
    userAgent: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    lastUsedAt: null,
    ...partial,
  };
}

describe("summarize", () => {
  test("collapses whitespace and takes the first non-empty line", () => {
    expect(summarize("  hello   world  \nsecond line")).toBe("hello world");
  });

  test("skips leading blank lines", () => {
    expect(summarize("\n\n  first real line\nmore")).toBe("first real line");
  });

  test("truncates with a trailing ellipsis past the max", () => {
    const text = "a".repeat(200);
    const out = summarize(text, 140);
    expect(out.length).toBe(141);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("a".repeat(140))).toBe(true);
  });

  test("text at or under the max is untouched", () => {
    const text = "short message";
    expect(summarize(text)).toBe(text);
  });
});

describe("notificationFor", () => {
  test("message.posted: title is the board title, body is '<actor>: <summary>', url and tag are the channel route", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "Hello there\nmore" }, seq: 7 });
    const n = notificationFor(e, ctx);
    expect(n).toEqual({
      title: "flock",
      body: "ada: Hello there",
      url: "#/b/flock/channel",
      tag: "#/b/flock/channel",
      seq: 7,
      renotify: true,
    });
  });

  test("message.posted with empty body and an attachment: 'sent an image'", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "", attachments: 1 } });
    const n = notificationFor(e, ctx);
    expect(n?.body).toBe("ada sent an image");
  });

  test("message.posted body longer than 140 chars is truncated", () => {
    const long = "x".repeat(200);
    const e = ev({ type: "message.posted", actor: "ada", data: { body: long } });
    const n = notificationFor(e, ctx);
    expect(n?.body.length).toBeLessThan(150);
    expect(n?.body.endsWith("…")).toBe(true);
  });

  test("message.posted body takes only the first line of a multi-line message", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "first\nsecond\nthird" } });
    const n = notificationFor(e, ctx);
    expect(n?.body).toBe("ada: first");
  });

  test("card.asked: title names the card, body is '<actor>: <question>', url and tag point at the card", () => {
    const e = ev({ type: "card.asked", actor: "scout", cardNum: 12, data: { question: "Which library?" }, seq: 3 });
    const n = notificationFor(e, ctx);
    expect(n).toEqual({
      title: "#12 needs you",
      body: "scout: Which library?",
      url: "#/b/flock/c/12",
      tag: "#/b/flock/c/12",
      seq: 3,
      renotify: true,
    });
  });

  test("card.moved to awaiting-human: title names the card, body is the card title", () => {
    const e = ev({ type: "card.moved", actor: "scout", cardNum: 4, data: { to: "awaiting-human" }, seq: 9 });
    const n = notificationFor(e, { ...ctx, cardTitle: "Fix the thing" });
    expect(n).toEqual({
      title: "#4 is waiting on you",
      body: "Fix the thing",
      url: "#/b/flock/c/4",
      tag: "#/b/flock/c/4",
      seq: 9,
      renotify: true,
    });
  });

  test("card.moved to any other status returns null", () => {
    const e = ev({ type: "card.moved", actor: "scout", cardNum: 4, data: { to: "doing" } });
    expect(notificationFor(e, ctx)).toBeNull();
  });

  test("every other event type returns null", () => {
    const types = [
      "board.created",
      "board.updated",
      "card.created",
      "card.updated",
      "card.claimed",
      "card.released",
      "card.closed",
      "card.blocked",
      "card.unblocked",
      "card.held",
      "card.unheld",
      "card.answered",
      "comment.posted",
      "decision.recorded",
      "decision.archived",
      "decision.restored",
      // Reactions are deliberately low-signal: a 👍 on a message is not worth a push (ADR 0018).
      "message.reacted",
      "message.unreacted",
      // The same for a 👍 on a card comment (ADR 0019).
      "comment.reacted",
      "comment.unreacted",
    ] as const;
    for (const type of types) {
      expect(notificationFor(ev({ type }), ctx)).toBeNull();
    }
  });
});

describe("notifyTargets", () => {
  test("never notifies the actor who caused the event", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "hi" } });
    const subs = [sub({ actor: "ada" }), sub({ id: "s2", endpoint: "e2", actor: "scout" })];
    const targets = notifyTargets(e, ctx, subs);
    expect(targets.map((t) => t.subscription.actor)).toEqual(["scout"]);
  });

  test("a subscription with a different actor is still notified even when the author is also subscribed", () => {
    const e = ev({ type: "card.asked", actor: "scout", cardNum: 1, data: { question: "q" } });
    const subs = [sub({ actor: "scout" }), sub({ id: "s2", endpoint: "e2", actor: "ada" })];
    const targets = notifyTargets(e, ctx, subs);
    expect(targets.length).toBe(1);
    expect(targets[0].subscription.actor).toBe("ada");
  });

  test("board scope: a global subscription (boardId null) matches every board", () => {
    const e = ev({ type: "message.posted", actor: "ada", boardId: "board-x", data: { body: "hi" } });
    const subs = [sub({ actor: "scout", boardId: null })];
    expect(notifyTargets(e, ctx, subs).length).toBe(1);
  });

  test("board scope: a board-scoped subscription only matches its own board", () => {
    const e = ev({ type: "message.posted", actor: "ada", boardId: "board-x", data: { body: "hi" } });
    const matching = sub({ actor: "scout", boardId: "board-x" });
    const other = sub({ id: "s2", endpoint: "e2", actor: "builder", boardId: "board-y" });
    const targets = notifyTargets(e, ctx, [matching, other]);
    expect(targets.map((t) => t.subscription.actor)).toEqual(["scout"]);
  });

  test("no subscriptions produces no targets", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "hi" } });
    expect(notifyTargets(e, ctx, [])).toEqual([]);
  });

  test("an event that deserves no notification produces no targets regardless of subscriptions", () => {
    const e = ev({ type: "card.created", actor: "ada" });
    const subs = [sub({ actor: "scout" })];
    expect(notifyTargets(e, ctx, subs)).toEqual([]);
  });

  test("the same payload object is shared across every target for one event", () => {
    const e = ev({ type: "message.posted", actor: "ada", data: { body: "hi" } });
    const subs = [sub({ actor: "scout" }), sub({ id: "s2", endpoint: "e2", actor: "builder" })];
    const targets = notifyTargets(e, ctx, subs);
    expect(targets.length).toBe(2);
    expect(targets[0].payload).toBe(targets[1].payload);
  });
});

describe("notificationClass", () => {
  test("card.asked and card.moved->awaiting-human are urgent", () => {
    expect(notificationClass(ev({ type: "card.asked", data: { question: "q" } }))).toBe("urgent");
    expect(notificationClass(ev({ type: "card.moved", data: { to: "awaiting-human" } }))).toBe("urgent");
  });

  test("message.posted is chatter", () => {
    expect(notificationClass(ev({ type: "message.posted", data: { body: "hi" } }))).toBe("chatter");
  });

  test("card.moved to another status, and every other event type, is null", () => {
    expect(notificationClass(ev({ type: "card.moved", data: { to: "doing" } }))).toBeNull();
    expect(notificationClass(ev({ type: "card.created" }))).toBeNull();
    expect(notificationClass(ev({ type: "comment.posted" }))).toBeNull();
  });
});

describe("mergedNotification", () => {
  const latest: NotificationPayload = {
    title: "flock",
    body: "ada: latest message",
    url: "#/b/flock/channel",
    tag: "#/b/flock/channel",
    seq: 42,
    renotify: true,
  };

  test("title is '<count> new in <board>', body/url/tag/seq come from latest", () => {
    const merged = mergedNotification(latest, 3, true);
    expect(merged).toEqual({
      title: "3 new in flock",
      body: "ada: latest message",
      url: "#/b/flock/channel",
      tag: "#/b/flock/channel",
      seq: 42,
      renotify: true,
    });
  });

  test("renotify is passed through explicitly", () => {
    expect(mergedNotification(latest, 5, false).renotify).toBe(false);
    expect(mergedNotification(latest, 5, true).renotify).toBe(true);
  });
});

describe("recipientsOf", () => {
  function target(actor: string): NotifyTarget {
    return { subscription: sub({ actor, id: `s-${actor}-${Math.random()}` }), payload: {} as NotificationPayload };
  }

  test("distinct actor names, in first-seen order", () => {
    const targets = [target("scout"), target("builder"), target("scout"), target("ada")];
    expect(recipientsOf(targets)).toEqual(["scout", "builder", "ada"]);
  });

  test("empty targets produces an empty list", () => {
    expect(recipientsOf([])).toEqual([]);
  });
});

describe("levelFor (ADR 0024 precedence)", () => {
  test("card.asked is always needs-me, even with a level in data", () => {
    const e = ev({ type: "card.asked", data: { question: "q", level: "info" } });
    expect(levelFor(e, ctx)).toBe("needs-me");
  });

  test("card.moved -> awaiting-human is always needs-me, even with a level in data", () => {
    const e = ev({ type: "card.moved", data: { to: "awaiting-human", level: "info" } });
    expect(levelFor(e, ctx)).toBe("needs-me");
  });

  test("card.moved to any other status is not a level-bearing event", () => {
    const e = ev({ type: "card.moved", data: { to: "doing" } });
    expect(levelFor(e, ctx)).toBeNull();
  });

  test("every event type outside the four level-bearing ones returns null", () => {
    const types = ["card.created", "card.claimed", "card.closed", "decision.recorded", "message.reacted"] as const;
    for (const type of types) expect(levelFor(ev({ type }), ctx)).toBeNull();
  });

  test("an author's declared review/info wins over any heuristic", () => {
    const withImage = ev({ type: "comment.posted", data: { body: "here", attachments: 1, level: "info" } });
    expect(levelFor(withImage, ctx)).toBe("info");
    const withPr = ev({ type: "message.posted", data: { body: "see github.com/o/r/pull/9", level: "review" } });
    expect(levelFor(withPr, ctx)).toBe("review");
  });

  test("an invalid or needs-me declaration in data is ignored, falling through to heuristics/default", () => {
    const e = ev({ type: "message.posted", data: { body: "plain", level: "needs-me" } });
    expect(levelFor(e, ctx)).toBe("info");
    const garbage = ev({ type: "message.posted", data: { body: "plain", level: "urgent!" } });
    expect(levelFor(garbage, ctx)).toBe("info");
  });

  test("a comment.posted with an image attachment is review", () => {
    const e = ev({ type: "comment.posted", data: { body: "", attachments: 1 } });
    expect(levelFor(e, ctx)).toBe("review");
  });

  test("a message.posted with an image attachment is not review by that rule alone (heuristic is comment-only)", () => {
    const e = ev({ type: "message.posted", data: { body: "", attachments: 1 } });
    expect(levelFor(e, ctx)).toBe("info");
  });

  test("a message.posted or comment.posted body with a GitHub PR URL is review", () => {
    const say = ev({ type: "message.posted", data: { body: "up: https://github.com/robrichardson13/flock/pull/42" } });
    expect(levelFor(say, ctx)).toBe("review");
    const comment = ev({ type: "comment.posted", data: { body: "see github.com/o/r/pull/1" } });
    expect(levelFor(comment, ctx)).toBe("review");
  });

  test("plain text with no attachment, no PR URL, and no declared level defaults to info", () => {
    const e = ev({ type: "message.posted", data: { body: "starting card 41" } });
    expect(levelFor(e, ctx)).toBe("info");
  });
});

describe("deliversAt", () => {
  test("each level reads its own independent toggle", () => {
    const settings = { needsMe: true, review: false, info: true, settled: false, settledAfterMs: 1200_000 };
    expect(deliversAt("needs-me", settings)).toBe(true);
    expect(deliversAt("review", settings)).toBe(false);
    expect(deliversAt("info", settings)).toBe(true);
  });
});

describe("assertDeclarableLevel", () => {
  test("undefined passes through as undefined", () => {
    expect(assertDeclarableLevel(undefined)).toBeUndefined();
  });

  test("review and info are accepted", () => {
    expect(assertDeclarableLevel("review")).toBe("review");
    expect(assertDeclarableLevel("info")).toBe("info");
  });

  test("needs-me is refused, pointing at flock ask", () => {
    expect(() => assertDeclarableLevel("needs-me")).toThrow(FlockError);
    expect(() => assertDeclarableLevel("needs-me")).toThrow(/flock ask/);
  });

  test("an unrecognised value is refused", () => {
    expect(() => assertDeclarableLevel("urgent")).toThrow(FlockError);
  });
});

describe("clampSettledThreshold", () => {
  test("clamps below the minimum up to 5 minutes", () => {
    expect(clampSettledThreshold(1000)).toBe(SETTLED_THRESHOLD_MIN_MS);
  });

  test("clamps above the maximum down to 24 hours", () => {
    expect(clampSettledThreshold(SETTLED_THRESHOLD_MAX_MS * 10)).toBe(SETTLED_THRESHOLD_MAX_MS);
  });

  test("passes an in-range value through untouched", () => {
    expect(clampSettledThreshold(20 * 60_000)).toBe(20 * 60_000);
  });
});

describe("resolveNotifySettingsFields (pure merge)", () => {
  const none: NotifySettingsFields = { needsMe: null, review: null, info: null, settled: null, settledAfterMs: null };

  test("no rows at all resolves to the built-in default", () => {
    expect(resolveNotifySettingsFields(null, null)).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });

  test("a global row's non-null fields override the default", () => {
    const global: NotifySettingsFields = { ...none, info: true, settled: true };
    const resolved = resolveNotifySettingsFields(global, null);
    expect(resolved.info).toBe(true);
    expect(resolved.settled).toBe(true);
    expect(resolved.needsMe).toBe(DEFAULT_NOTIFY_SETTINGS.needsMe);
  });

  test("a board row's non-null field wins over the global row's value for that field", () => {
    const global: NotifySettingsFields = { ...none, info: true };
    const board: NotifySettingsFields = { ...none, info: false };
    expect(resolveNotifySettingsFields(global, board).info).toBe(false);
  });

  test("a board row with a null field inherits from the global row, not the default", () => {
    const global: NotifySettingsFields = { ...none, review: false };
    const board: NotifySettingsFields = { ...none, review: null };
    expect(resolveNotifySettingsFields(global, board).review).toBe(false);
  });

  test("a board row with every field null is indistinguishable from no override", () => {
    const global: NotifySettingsFields = { ...none, info: true };
    expect(resolveNotifySettingsFields(global, none)).toEqual(resolveNotifySettingsFields(global, null));
  });
});

describe("Flock notify settings accessors", () => {
  function fresh() {
    const f = new Flock(":memory:");
    const board = f.createBoard(ada, { title: "Notify test" });
    return { f, board };
  }

  test("an actor with no rows resolves to the default everywhere", () => {
    const { f, board } = fresh();
    expect(f.resolveNotifySettings("ada", board.id)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(f.resolveNotifySettings("ada", "")).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });

  test("putNotifySettings on the global row ('') is visible on every board that has no override", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, "", { info: true });
    expect(f.resolveNotifySettings("ada", board.id).info).toBe(true);
    expect(f.resolveNotifySettings("ada", "").info).toBe(true);
  });

  test("a per-board override wins over the global row", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, "", { review: true });
    f.putNotifySettings(ada, board.id, { review: false });
    expect(f.resolveNotifySettings("ada", board.id).review).toBe(false);
    expect(f.resolveNotifySettings("ada", "").review).toBe(true);
  });

  test("writing a subset of fields leaves the others exactly as stored", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, board.id, { info: true, settled: true });
    f.putNotifySettings(ada, board.id, { info: false });
    const row = f.notifySettings("ada", board.id);
    expect(row?.info).toBe(false);
    expect(row?.settled).toBe(true);
  });

  test("writing a field to null explicitly clears it back to inherit", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, board.id, { info: true });
    f.putNotifySettings(ada, board.id, { info: null });
    expect(f.notifySettings("ada", board.id)?.info).toBeNull();
    expect(f.resolveNotifySettings("ada", board.id).info).toBe(DEFAULT_NOTIFY_SETTINGS.info);
  });

  test("settledAfterMs is clamped into range on write", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, board.id, { settledAfterMs: 1000 });
    expect(f.notifySettings("ada", board.id)?.settledAfterMs).toBe(SETTLED_THRESHOLD_MIN_MS);
    f.putNotifySettings(ada, board.id, { settledAfterMs: SETTLED_THRESHOLD_MAX_MS * 100 });
    expect(f.notifySettings("ada", board.id)?.settledAfterMs).toBe(SETTLED_THRESHOLD_MAX_MS);
  });

  test("settings are per actor: two actors on the same board never see each other's overrides", () => {
    const { f, board } = fresh();
    f.putNotifySettings(ada, board.id, { info: true });
    expect(f.resolveNotifySettings("scout", board.id).info).toBe(DEFAULT_NOTIFY_SETTINGS.info);
  });

  test("putNotifySettings on an unknown board id throws not_found", () => {
    const { f } = fresh();
    expect(() => f.putNotifySettings(ada, "no-such-board", { info: true })).toThrow(FlockError);
  });

  test("notifySettings returns null when nothing has ever been written for that (actor, board)", () => {
    const { f, board } = fresh();
    expect(f.notifySettings("ada", board.id)).toBeNull();
  });
});

describe("say/comment: declaring a level (ADR 0024)", () => {
  function fresh() {
    const f = new Flock(":memory:");
    const board = f.createBoard(ada, { title: "Level test" });
    return { f, board };
  }

  test("say with no level declared emits no level key", () => {
    const { f, board } = fresh();
    f.say(scout, board.id, "hello");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.posted")!;
    expect(e.data.level).toBeUndefined();
  });

  test("say --level review stores level: review on the event", () => {
    const { f, board } = fresh();
    f.say(scout, board.id, "the PR is up", { level: "review" });
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.posted")!;
    expect(e.data.level).toBe("review");
  });

  test("say --level info stores level: info on the event", () => {
    const { f, board } = fresh();
    f.say(scout, board.id, "status update", { level: "info" });
    const e = f.events({ boardId: board.id }).find((x) => x.type === "message.posted")!;
    expect(e.data.level).toBe("info");
  });

  test("say --level needs-me is refused, and no event is written", () => {
    const { f, board } = fresh();
    expect(() => f.say(scout, board.id, "hi", { level: "needs-me" })).toThrow(FlockError);
    expect(f.events({ boardId: board.id }).some((x) => x.type === "message.posted")).toBe(false);
  });

  test("comment --level review stores level on the comment.posted event", () => {
    const { f, board } = fresh();
    const c = f.createCard(scout, board.id, { title: "A" });
    f.addComment(scout, board.id, c.num, "screenshots attached", "comment", { level: "review" });
    const e = f.events({ boardId: board.id }).find((x) => x.type === "comment.posted")!;
    expect(e.data.level).toBe("review");
  });

  test("comment --level needs-me is refused, and no comment is written", () => {
    const { f, board } = fresh();
    const c = f.createCard(scout, board.id, { title: "A" });
    expect(() => f.addComment(scout, board.id, c.num, "urgent", "comment", { level: "needs-me" })).toThrow(FlockError);
    expect(f.comments(board.id, c.num)).toHaveLength(0);
  });

  test("flock ask (askHuman) needs no declared level: card.asked has no level field and levelFor still resolves it to needs-me", () => {
    const { f, board } = fresh();
    const c = f.createCard(scout, board.id, { title: "A" });
    f.askHuman(scout, board.id, c.num, "which way?");
    const e = f.events({ boardId: board.id }).find((x) => x.type === "card.asked")!;
    expect(e.data.level).toBeUndefined();
    expect(levelFor(e, ctx)).toBe("needs-me");
  });
});

describe("notify_settings migration from a v7 fixture", () => {
  function freshPath(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "flock-notify-migrate-"));
    return { dir, path: join(dir, "flock.db") };
  }

  test("opening a v7 database gains notify_settings and is re-stamped to SCHEMA_VERSION 8", () => {
    const { dir, path } = freshPath();
    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      legacy.exec("PRAGMA user_version = 7;");
      legacy.close();

      const db = openDatabase(path);
      expect(SCHEMA_VERSION).toBe(8);
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      expect(tables.has("notify_settings")).toBe(true);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a migrated database has no notify_settings rows: absence of a row is the default, nothing is backfilled", () => {
    const { dir, path } = freshPath();
    try {
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE boards (
          id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          project TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      legacy.exec("PRAGMA user_version = 7;");
      legacy.close();

      const db = openDatabase(path);
      const { n } = db.query("SELECT COUNT(*) AS n FROM notify_settings").get() as { n: number };
      expect(n).toBe(0);
      db.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
