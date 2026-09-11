import { describe, expect, test } from "bun:test";
import {
  notificationFor,
  notifyTargets,
  summarize,
  type NotifyContext,
  type PushSubscriptionRecord,
} from "../src/index.ts";
import type { Event } from "../src/index.ts";

const ctx: NotifyContext = { boardSlug: "flock", boardTitle: "flock" };

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
