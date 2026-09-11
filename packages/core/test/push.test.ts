import { describe, expect, test } from "bun:test";
import { Flock, FlockError, type Actor } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Flock v1", body: "## Destination\nShip it." });
  return { f, board };
}

const input = (endpoint: string, extra: Partial<Parameters<Flock["subscribePush"]>[1]> = {}) => ({
  endpoint,
  keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  ...extra,
});

describe("subscribePush", () => {
  test("registers a device attributed to the actor", () => {
    const { f } = fresh();
    const rec = f.subscribePush(ada, input("https://push.example/a"));
    expect(rec.endpoint).toBe("https://push.example/a");
    expect(rec.actor).toBe("ada");
    expect(rec.actorKind).toBe("human");
    expect(rec.keys).toEqual({ p256dh: "p256dh-key", auth: "auth-secret" });
    expect(rec.boardId).toBeNull();
    expect(rec.lastUsedAt).toBeNull();
  });

  test("is an upsert on endpoint: re-subscribing rebinds fields and keeps the original createdAt", async () => {
    const { f, board } = fresh();
    const first = f.subscribePush(ada, input("https://push.example/a"));
    await Bun.sleep(2);
    const second = f.subscribePush(scout, input("https://push.example/a", { keys: { p256dh: "new-p", auth: "new-a" }, boardId: board.id, userAgent: "ua" }));
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.actor).toBe("scout");
    expect(second.actorKind).toBe("agent");
    expect(second.keys).toEqual({ p256dh: "new-p", auth: "new-a" });
    expect(second.boardId).toBe(board.id);
    expect(second.userAgent).toBe("ua");

    const all = f.pushSubscriptions();
    expect(all.length).toBe(1);
  });

  test("throws FlockError on a missing endpoint or key", () => {
    const { f } = fresh();
    expect(() => f.subscribePush(ada, { endpoint: "", keys: { p256dh: "p", auth: "a" } })).toThrow(FlockError);
    expect(() => f.subscribePush(ada, { endpoint: "e", keys: { p256dh: "", auth: "a" } })).toThrow(FlockError);
    expect(() => f.subscribePush(ada, { endpoint: "e", keys: { p256dh: "p", auth: "" } })).toThrow(FlockError);
  });

  test("emits no event", () => {
    const { f, board } = fresh();
    const before = f.lastSeq();
    const beforeCount = f.events({ boardId: board.id }).length;
    f.subscribePush(ada, input("https://push.example/a"));
    expect(f.lastSeq()).toBe(before);
    expect(f.events({ boardId: board.id }).length).toBe(beforeCount);
  });
});

describe("unsubscribePush", () => {
  test("removes a registered device and returns true", () => {
    const { f } = fresh();
    f.subscribePush(ada, input("https://push.example/a"));
    expect(f.unsubscribePush("https://push.example/a")).toBe(true);
    expect(f.pushSubscriptions()).toEqual([]);
  });

  test("returns false for an unknown endpoint, and is idempotent", () => {
    const { f } = fresh();
    expect(f.unsubscribePush("https://push.example/nope")).toBe(false);
    f.subscribePush(ada, input("https://push.example/a"));
    expect(f.unsubscribePush("https://push.example/a")).toBe(true);
    expect(f.unsubscribePush("https://push.example/a")).toBe(false);
  });

  test("emits no event", () => {
    const { f, board } = fresh();
    f.subscribePush(ada, input("https://push.example/a"));
    const before = f.lastSeq();
    const beforeCount = f.events({ boardId: board.id }).length;
    f.unsubscribePush("https://push.example/a");
    expect(f.lastSeq()).toBe(before);
    expect(f.events({ boardId: board.id }).length).toBe(beforeCount);
  });
});

describe("pushSubscriptions", () => {
  test("returns everything, newest first, with no filter", async () => {
    const { f } = fresh();
    f.subscribePush(ada, input("https://push.example/a"));
    await Bun.sleep(2);
    f.subscribePush(scout, input("https://push.example/b"));
    const all = f.pushSubscriptions();
    expect(all.map((s) => s.endpoint)).toEqual(["https://push.example/b", "https://push.example/a"]);
  });

  test("boardId returns that board's scoped subscriptions plus every global one", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other", body: "" });
    f.subscribePush(ada, input("https://push.example/global"));
    f.subscribePush(ada, input("https://push.example/this-board", { boardId: board.id }));
    f.subscribePush(ada, input("https://push.example/other-board", { boardId: other.id }));

    const forThisBoard = f.pushSubscriptions({ boardId: board.id }).map((s) => s.endpoint).sort();
    expect(forThisBoard).toEqual(["https://push.example/global", "https://push.example/this-board"].sort());
  });

  test("actor filters to one person", () => {
    const { f } = fresh();
    f.subscribePush(ada, input("https://push.example/a"));
    f.subscribePush(scout, input("https://push.example/b"));
    expect(f.pushSubscriptions({ actor: "scout" }).map((s) => s.endpoint)).toEqual(["https://push.example/b"]);
  });

  test("deleting a board cascades its board-scoped subscriptions away, leaving global ones", () => {
    const { f, board } = fresh();
    f.subscribePush(ada, input("https://push.example/global"));
    f.subscribePush(ada, input("https://push.example/scoped", { boardId: board.id }));
    f.db.query("DELETE FROM boards WHERE id = ?").run(board.id);
    const remaining = f.pushSubscriptions().map((s) => s.endpoint);
    expect(remaining).toEqual(["https://push.example/global"]);
  });
});

describe("touchPushSubscription", () => {
  test("stamps lastUsedAt after a successful send", () => {
    const { f } = fresh();
    f.subscribePush(ada, input("https://push.example/a"));
    expect(f.pushSubscriptions()[0].lastUsedAt).toBeNull();
    f.touchPushSubscription("https://push.example/a");
    expect(f.pushSubscriptions()[0].lastUsedAt).not.toBeNull();
  });

  test("is a silent no-op on an unknown endpoint", () => {
    const { f } = fresh();
    expect(() => f.touchPushSubscription("https://push.example/nope")).not.toThrow();
  });
});

describe("SCHEMA_VERSION", () => {
  test("push_subscriptions exists on a freshly opened database", () => {
    const { f } = fresh();
    const tables = f.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'").all();
    expect(tables.length).toBe(1);
  });
});
