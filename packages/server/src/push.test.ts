import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock, Presence, clientIsLooking, IDLE_MS, type Actor } from "@flock/core";
import { loadOrCreateVapidKeys, startPushPump, type PushSend } from "./push.ts";
import { createApp } from "./index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

let savedPublic: string | undefined;
let savedPrivate: string | undefined;
let savedSubject: string | undefined;

beforeEach(() => {
  savedPublic = process.env.FLOCK_VAPID_PUBLIC_KEY;
  savedPrivate = process.env.FLOCK_VAPID_PRIVATE_KEY;
  savedSubject = process.env.FLOCK_VAPID_SUBJECT;
  delete process.env.FLOCK_VAPID_PUBLIC_KEY;
  delete process.env.FLOCK_VAPID_PRIVATE_KEY;
  delete process.env.FLOCK_VAPID_SUBJECT;
});

afterEach(() => {
  if (savedPublic === undefined) delete process.env.FLOCK_VAPID_PUBLIC_KEY;
  else process.env.FLOCK_VAPID_PUBLIC_KEY = savedPublic;
  if (savedPrivate === undefined) delete process.env.FLOCK_VAPID_PRIVATE_KEY;
  else process.env.FLOCK_VAPID_PRIVATE_KEY = savedPrivate;
  if (savedSubject === undefined) delete process.env.FLOCK_VAPID_SUBJECT;
  else process.env.FLOCK_VAPID_SUBJECT = savedSubject;
});

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "flock-vapid-"));
}

describe("loadOrCreateVapidKeys", () => {
  test("generates keys on first use, mode 0600, and defaults the subject", () => {
    const home = tempHome();
    try {
      const keys = loadOrCreateVapidKeys(home);
      expect(keys.publicKey.length).toBeGreaterThan(0);
      expect(keys.privateKey.length).toBeGreaterThan(0);
      expect(keys.subject).toBe("https://github.com/robrichardson13/flock");
      const mode = statSync(join(home, "vapid.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a second call returns the identical keys", () => {
    const home = tempHome();
    try {
      const first = loadOrCreateVapidKeys(home);
      const second = loadOrCreateVapidKeys(home);
      expect(second.publicKey).toBe(first.publicKey);
      expect(second.privateKey).toBe(first.privateKey);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("FLOCK_VAPID_PUBLIC_KEY/_PRIVATE_KEY win over the file and skip disk entirely", () => {
    const home = tempHome();
    try {
      process.env.FLOCK_VAPID_PUBLIC_KEY = "env-public";
      process.env.FLOCK_VAPID_PRIVATE_KEY = "env-private";
      const keys = loadOrCreateVapidKeys(home);
      expect(keys.publicKey).toBe("env-public");
      expect(keys.privateKey).toBe("env-private");
      expect(() => statSync(join(home, "vapid.json"))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("FLOCK_VAPID_SUBJECT overrides the default subject", () => {
    const home = tempHome();
    try {
      process.env.FLOCK_VAPID_SUBJECT = "mailto:ops@example.com";
      const keys = loadOrCreateVapidKeys(home);
      expect(keys.subject).toBe("mailto:ops@example.com");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------- pump ----------

function fixture() {
  const flock = new Flock(":memory:");
  const board = flock.createBoard(ada, { title: "Flock v1" });
  return { flock, board };
}

/** A fake PushSend that records calls and can be told to reject specific endpoints. */
function fakeSend(rejections: Record<string, number> = {}) {
  const calls: Array<{ endpoint: string; payload: string }> = [];
  const send: PushSend = async (sub, payload) => {
    calls.push({ endpoint: sub.endpoint, payload });
    const statusCode = rejections[sub.endpoint];
    if (statusCode !== undefined) {
      const err: any = new Error(`push failed: ${statusCode}`);
      err.statusCode = statusCode;
      err.endpoint = sub.endpoint;
      throw err;
    }
    return { statusCode: 201 };
  };
  return { send, calls };
}

const KEYS = { publicKey: "pub", privateKey: "priv", subject: "https://example.com" };

describe("PushPump.deliver", () => {
  test("a message.posted event reaches every subscriber but the author", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "hello everyone");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      const result = await pump.deliver(event);
      expect(result).toEqual({ sent: 1, pruned: 0 });
      expect(calls.map((c) => c.endpoint)).toEqual(["https://push.example/scout"]);
    } finally {
      pump.stop();
    }
  });

  test("404, 410 and 403 prune the subscription and leave others alone", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/gone-404", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush({ name: "designer", kind: "agent" }, { endpoint: "https://push.example/gone-410", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush({ name: "core-dev", kind: "agent" }, { endpoint: "https://push.example/wrong-key-403", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush({ name: "web-dev", kind: "agent" }, { endpoint: "https://push.example/alive", keys: { p256dh: "p", auth: "a" } });
    const { send } = fakeSend({
      "https://push.example/gone-404": 404,
      "https://push.example/gone-410": 410,
      "https://push.example/wrong-key-403": 403,
    });
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "ping");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      const result = await pump.deliver(event);
      expect(result).toEqual({ sent: 1, pruned: 3 });
      const remaining = flock.pushSubscriptions().map((s) => s.endpoint).sort();
      expect(remaining).toEqual(["https://push.example/alive"]);
    } finally {
      pump.stop();
    }
  });

  test("429 and 413 do not prune", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/rate-limited", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush({ name: "core-dev", kind: "agent" }, { endpoint: "https://push.example/too-big", keys: { p256dh: "p", auth: "a" } });
    const { send } = fakeSend({ "https://push.example/rate-limited": 429, "https://push.example/too-big": 413 });
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "ping");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      const result = await pump.deliver(event);
      expect(result).toEqual({ sent: 0, pruned: 0 });
      expect(flock.pushSubscriptions().length).toBe(2);
    } finally {
      pump.stop();
    }
  });

  test("a rejection with no statusCode does not prune and does not stop the pump", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/flaky", keys: { p256dh: "p", auth: "a" } });
    const send: PushSend = async () => {
      throw new Error("network error");
    };
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "ping");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      const result = await pump.deliver(event);
      expect(result).toEqual({ sent: 0, pruned: 0 });
      expect(flock.pushSubscriptions().length).toBe(1);
    } finally {
      pump.stop();
    }
  });

  test("success stamps lastUsedAt", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "ping");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      await pump.deliver(event);
      const sub = flock.pushSubscriptions({ actor: "scout" })[0]!;
      expect(sub.lastUsedAt).not.toBeNull();
    } finally {
      pump.stop();
    }
  });

  test("the payload is valid JSON and comfortably under 4KB for a maximal message", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.say(ada, board.id, "x".repeat(2000));
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      await pump.deliver(event);
      const payload = calls[0]!.payload;
      expect(() => JSON.parse(payload)).not.toThrow();
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(4096);
    } finally {
      pump.stop();
    }
  });

  test("a card.asked event notifies with the right title, body and url", async () => {
    const { flock, board } = fixture();
    const card = flock.createCard(ada, board.id, { title: "Fix the thing" });
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.askHuman(scout, board.id, card.num, "Which way?");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "card.asked")!;
      await pump.deliver(event);
      const payload = JSON.parse(calls[0]!.payload);
      expect(payload.title).toBe(`#${card.num} needs you`);
      expect(payload.url).toBe(`#/b/${board.slug}/c/${card.num}`);
      expect(payload.tag).toBe(payload.url);
    } finally {
      pump.stop();
    }
  });

  test("card.moved to awaiting-human notifies; other moves do not", async () => {
    const { flock, board } = fixture();
    const card = flock.createCard(ada, board.id, { title: "Fix the thing" });
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      flock.moveCard(ada, board.id, card.num, "doing");
      const movedToDoing = flock.events({ boardId: board.id }).find((e) => e.type === "card.moved" && e.data.to === "doing")!;
      expect((await pump.deliver(movedToDoing)).sent).toBe(0);

      flock.moveCard(ada, board.id, card.num, "awaiting-human");
      const movedToAH = flock.events({ boardId: board.id }).find((e) => e.type === "card.moved" && e.data.to === "awaiting-human")!;
      const result = await pump.deliver(movedToAH);
      expect(result.sent).toBe(1);
      expect(calls).toHaveLength(1);
      const payload = JSON.parse(calls[0]!.payload);
      expect(payload.title).toBe(`#${card.num} is waiting on you`);
    } finally {
      pump.stop();
    }
  });

  test("the pump starts at lastSeq() and does not replay events written before it started", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    flock.say(ada, board.id, "before the pump started");
    const { send, calls } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 20 });
    try {
      flock.say(ada, board.id, "after the pump started");
      await Bun.sleep(200);
      expect(calls.length).toBe(1);
    } finally {
      pump.stop();
    }
  });

  test("a board deleted between the write and the tail is skipped, not thrown", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    flock.say(ada, board.id, "hello");
    const event = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
    flock.deleteBoard(ada, board.id);
    const { send } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      await expect(pump.deliver(event)).resolves.toEqual({ sent: 0, pruned: 0 });
    } finally {
      pump.stop();
    }
  });
});

// ---------- routes ----------

function appWithPush(opts: { flockHome: string; pushSend?: PushSend }) {
  const flock = new Flock(":memory:");
  const app = createApp({ flock, dbPath: ":memory:", flockHome: opts.flockHome, pushSend: opts.pushSend });
  return { flock, app };
}

const scoutHeaders = { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" };

describe("push routes", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("GET /api/push/key returns the enabled public key", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/push/key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.publicKey).toBe("string");
    expect(body.publicKey.length).toBeGreaterThan(0);
  });

  test("POST /api/push/subscriptions returns 201 and never echoes keys", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/push/subscriptions", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ endpoint: "https://push.example/s1", keys: { p256dh: "p", auth: "a" } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.endpoint).toBe("https://push.example/s1");
    expect(body.actor).toBe("scout");
    expect(body.keys).toBeUndefined();
  });

  test("a second subscribe with the same endpoint is an upsert, not a duplicate", async () => {
    const { app, flock } = appWithPush({ flockHome: home });
    const body = { endpoint: "https://push.example/s1", keys: { p256dh: "p", auth: "a" } };
    await app.request("/api/push/subscriptions", { method: "POST", headers: scoutHeaders, body: JSON.stringify(body) });
    await app.request("/api/push/subscriptions", { method: "POST", headers: scoutHeaders, body: JSON.stringify(body) });
    expect(flock.pushSubscriptions().length).toBe(1);
  });

  test("a body missing keys.auth is 400", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/push/subscriptions", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ endpoint: "https://push.example/s1", keys: { p256dh: "p" } }),
    });
    expect(res.status).toBe(400);
  });

  test("DELETE for an unknown endpoint is still 204", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/push/subscriptions", {
      method: "DELETE",
      headers: scoutHeaders,
      body: JSON.stringify({ endpoint: "https://push.example/never-existed" }),
    });
    expect(res.status).toBe(204);
  });

  test("DELETE removes a real subscription", async () => {
    const { app, flock } = appWithPush({ flockHome: home });
    flock.subscribePush({ name: "scout", kind: "agent" }, { endpoint: "https://push.example/s1", keys: { p256dh: "p", auth: "a" } });
    const res = await app.request("/api/push/subscriptions", {
      method: "DELETE",
      headers: scoutHeaders,
      body: JSON.stringify({ endpoint: "https://push.example/s1" }),
    });
    expect(res.status).toBe(204);
    expect(flock.pushSubscriptions().length).toBe(0);
  });

  test("GET /api/push/subscriptions returns only the caller's own, keys omitted", async () => {
    const { app, flock } = appWithPush({ flockHome: home });
    flock.subscribePush({ name: "scout", kind: "agent" }, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush({ name: "ada", kind: "human" }, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    const res = await app.request("/api/push/subscriptions", { headers: scoutHeaders });
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].endpoint).toBe("https://push.example/scout");
    expect(body[0].keys).toBeUndefined();
  });

  test("POST /api/push/test sends to every subscription of the calling actor and reports sent/pruned", async () => {
    const { calls } = fakeSend();
    const { send: rejecting } = fakeSend({ "https://push.example/dead": 410 });
    const { app, flock } = appWithPush({ flockHome: home, pushSend: rejecting });
    flock.subscribePush({ name: "scout", kind: "agent" }, { endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } });
    const res = await app.request("/api/push/test", { method: "POST", headers: scoutHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sent: 0, pruned: 1 });
    expect(flock.pushSubscriptions().length).toBe(0);
  });

  test("push disabled entirely (push: false) still serves a disabled /api/push/key", async () => {
    const flock = new Flock(":memory:");
    const app = createApp({ flock, dbPath: ":memory:", push: false });
    const res = await app.request("/api/push/key");
    const body = await res.json();
    expect(body).toEqual({ enabled: false, reason: "push is disabled" });
  });

  test("FLOCK_NO_PUSH=1 also disables push", async () => {
    process.env.FLOCK_NO_PUSH = "1";
    try {
      const flock = new Flock(":memory:");
      const app = createApp({ flock, dbPath: ":memory:", flockHome: home });
      const res = await app.request("/api/push/key");
      const body = await res.json();
      expect(body.enabled).toBe(false);
    } finally {
      delete process.env.FLOCK_NO_PUSH;
    }
  });
});

// ---------- batching and presence (spec 9, card C) ----------

describe("PushPump batching", () => {
  test("a burst of messages within the window yields one send, then one merged send after flush() at +60s", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000, now: () => t });
    try {
      flock.say(ada, board.id, "one");
      await pump.deliver(flock.events({ boardId: board.id }).findLast((e) => e.type === "message.posted")!);
      expect(calls.length).toBe(1); // leading edge, dispatched at once

      t += 1_000;
      flock.say(ada, board.id, "two");
      await pump.deliver(flock.events({ boardId: board.id }).findLast((e) => e.type === "message.posted")!);

      t += 1_000;
      flock.say(ada, board.id, "three");
      await pump.deliver(flock.events({ boardId: board.id }).findLast((e) => e.type === "message.posted")!);

      // "two" and "three" fold inside the window: still exactly one send.
      expect(calls.length).toBe(1);

      t += 60_000;
      const result = await pump.flush();
      expect(result.sent).toBe(1);
      expect(calls.length).toBe(2);
      const merged = JSON.parse(calls[1]!.payload);
      expect(merged.title).toBe(`3 new in ${board.title}`);
      expect(merged.body).toBe("ada: three");
      expect(merged.renotify).toBe(false);

      // Nothing pending; a second flush at the same or later time is a no-op.
      const again = await pump.flush();
      expect(again).toEqual({ sent: 0, pruned: 0 });
    } finally {
      pump.stop();
    }
  });

  test("stop() drops a pending batch: no send after stop", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000, now: () => t });

    flock.say(ada, board.id, "one");
    await pump.deliver(flock.events({ boardId: board.id }).findLast((e) => e.type === "message.posted")!);
    t += 1_000;
    flock.say(ada, board.id, "two");
    await pump.deliver(flock.events({ boardId: board.id }).findLast((e) => e.type === "message.posted")!);
    expect(calls.length).toBe(1);

    pump.stop();
    t += 60_000;
    const result = await pump.flush();
    expect(result).toEqual({ sent: 0, pruned: 0 });
    expect(calls.length).toBe(1);
  });
});

describe("PushPump presence", () => {
  test("presence suppresses channel messages to the looking actor only, and never suppresses an ask", async () => {
    const { flock, board } = fixture();
    const designer: Actor = { name: "designer", kind: "agent" };
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush(designer, { endpoint: "https://push.example/designer", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    const presence = new Presence();
    let t = 1_000_000;
    presence.report({ client: "c1", actor: "ada", boardId: board.id, looking: true }, t);
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000, now: () => t, presence });
    try {
      flock.say(scout, board.id, "hi everyone");
      const message = flock.events({ boardId: board.id }).find((e) => e.type === "message.posted")!;
      await pump.deliver(message);
      // ada is looking at this board: suppressed, never asked. designer is not: still notified.
      expect(calls.map((c) => c.endpoint)).toEqual(["https://push.example/designer"]);

      const card = flock.createCard(scout, board.id, { title: "Fix the thing" });
      flock.askHuman(scout, board.id, card.num, "Which way?");
      const ask = flock.events({ boardId: board.id }).find((e) => e.type === "card.asked")!;
      const before = calls.length;
      await pump.deliver(ask);
      // The ask reaches ada too, even though she is looking at the board.
      const newEndpoints = calls.slice(before).map((c) => c.endpoint).sort();
      expect(newEndpoints).toEqual(["https://push.example/ada", "https://push.example/designer"].sort());
    } finally {
      pump.stop();
    }
  });
});

describe("PushPump tick", () => {
  test("the interval tick flushes a due batch on its own, with no new event to trigger it", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    // A real, fast interval: the tick itself (not a manual pump.flush()) must notice the window
    // has closed and flush without any further event arriving.
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 20, now: () => t });
    try {
      flock.say(ada, board.id, "one");
      await Bun.sleep(60);
      expect(calls.length).toBe(1); // leading edge, picked up by the tick itself

      flock.say(ada, board.id, "two");
      await Bun.sleep(60);
      expect(calls.length).toBe(1); // folded, window still open

      t += 60_000; // window closes; nothing new is written
      await Bun.sleep(60); // the next tick's own flush() call should notice and send
      expect(calls.length).toBe(2);
      const merged = JSON.parse(calls[1]!.payload);
      expect(merged.title).toBe(`2 new in ${board.title}`);
      expect(merged.renotify).toBe(false);
    } finally {
      pump.stop();
    }
  });
});

describe("PushPump send isolation (S1)", () => {
  test("a throwing send for one actor's dispatch does not stop another actor's ask in the same batch", async () => {
    const { flock, board } = fixture();
    const card = flock.createCard(ada, board.id, { title: "Fix the thing" });
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const calls: string[] = [];
    const send: PushSend = async (sub) => {
      calls.push(sub.endpoint);
      if (sub.endpoint === "https://push.example/ada") throw new Error("network error, no statusCode");
      return { statusCode: 201 };
    };
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      // Both ada and scout should be notified of this ask; ada's endpoint always throws.
      flock.askHuman({ name: "builder", kind: "agent" }, board.id, card.num, "Which way?");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "card.asked")!;
      const result = await pump.deliver(event);
      expect(calls.sort()).toEqual(["https://push.example/ada", "https://push.example/scout"]);
      expect(result.sent).toBe(1); // scout's send succeeded despite ada's throwing first
    } finally {
      pump.stop();
    }
  });

  test("dispatches to two recipients are sent in parallel, not one after another", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    let adaResolve!: () => void;
    const adaGate = new Promise<void>((resolve) => {
      adaResolve = resolve;
    });
    let scoutStarted = false;
    const send: PushSend = async (sub) => {
      if (sub.endpoint === "https://push.example/ada") {
        await adaGate; // held open until the test releases it
        return { statusCode: 201 };
      }
      scoutStarted = true;
      return { statusCode: 201 };
    };
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    try {
      const card = flock.createCard(ada, board.id, { title: "Fix the thing" });
      flock.askHuman({ name: "builder", kind: "agent" }, board.id, card.num, "Which way?");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "card.asked")!;
      const deliverPromise = pump.deliver(event);
      // Give scout's send a turn on the microtask queue while ada's is still gated: if the fan-out
      // were sequential (the old for-await loop), scout's send would never even be called yet.
      await Bun.sleep(10);
      expect(scoutStarted).toBe(true);
      adaResolve();
      await deliverPromise;
    } finally {
      pump.stop();
    }
  });

  test("a DB write that throws for one endpoint does not stop touch/prune bookkeeping for another", async () => {
    const { flock, board } = fixture();
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    flock.subscribePush(scout, { endpoint: "https://push.example/scout", keys: { p256dh: "p", auth: "a" } });
    const { send } = fakeSend();
    const pump = startPushPump({ flock, keys: KEYS, send, intervalMs: 1_000_000 });
    const original = flock.touchPushSubscription.bind(flock);
    flock.touchPushSubscription = ((endpoint: string) => {
      if (endpoint === "https://push.example/ada") throw new Error("SQLITE_BUSY");
      return original(endpoint);
    }) as typeof flock.touchPushSubscription;
    try {
      const card = flock.createCard(ada, board.id, { title: "Fix the thing" });
      flock.askHuman({ name: "builder", kind: "agent" }, board.id, card.num, "Which way?");
      const event = flock.events({ boardId: board.id }).find((e) => e.type === "card.asked")!;
      const result = await pump.deliver(event);
      // Both sends succeeded at the network layer; ada's touch() throws but must not prevent
      // scout's from being counted.
      expect(result.sent).toBe(1);
      const scoutSub = flock.pushSubscriptions({ actor: "scout" })[0]!;
      expect(scoutSub.lastUsedAt).not.toBeNull();
    } finally {
      pump.stop();
    }
  });
});

describe("POST /api/presence end to end through the pump", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("presence reported over HTTP suppresses that actor's channel message through the real pump", async () => {
    const flock = new Flock(":memory:");
    const board = flock.createBoard(ada, { title: "Flock v1" });
    flock.subscribePush(ada, { endpoint: "https://push.example/ada", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    const app = createApp({
      flock,
      dbPath: ":memory:",
      flockHome: home,
      pushSend: send,
      now: () => t,
      pushIntervalMs: 20,
    });

    // ada reports looking at this board over the real route, which shares the app's one Presence
    // with the pump — not a Presence the test builds itself.
    const presRes = await app.request("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "ada", "x-flock-actor-kind": "human" },
      body: JSON.stringify({ client: "c1", board: board.slug, looking: true }),
    });
    expect(presRes.status).toBe(204);

    flock.say(scout, board.id, "hi ada");
    await Bun.sleep(60); // let the pump's own tick pick it up
    expect(calls.length).toBe(0); // suppressed: ada is looking

    // ada stops looking; the next message should reach her.
    const stopRes = await app.request("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "ada", "x-flock-actor-kind": "human" },
      body: JSON.stringify({ client: "c1", board: board.slug, looking: false }),
    });
    expect(stopRes.status).toBe(204);

    flock.say(scout, board.id, "still there?");
    await Bun.sleep(60);
    expect(calls.length).toBe(1);
    expect(calls[0]!.endpoint).toBe("https://push.example/ada");
  });
});

/**
 * Card 20: a phone with the app on screen kept getting pushed. The chain is reproduced here with
 * the real predicate driving the real route into the real pump, so the failure can only come from
 * the definition of "looking" itself.
 */
describe("a foregrounded phone is never pushed channel chatter", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** What iOS reports for a standalone web app in the foreground that has not been tapped for
   *  `idleFor`: visible, `document.hasFocus()` unreliable (no second window to focus), coarse
   *  pointer, no hover. */
  const iosForeground = (now: number, idleFor: number, focused = false) => ({
    visible: true,
    focused,
    lastInputAt: now - idleFor,
    now,
    foregroundOnly: true,
  });

  async function sayAndSettle(app: ReturnType<typeof createApp>, flock: Flock, boardId: string, body: string) {
    flock.say(scout, boardId, body);
    await Bun.sleep(60);
    return app;
  }

  test("unfocused and untapped for well past IDLE_MS, the phone still suppresses the channel push", async () => {
    const flock = new Flock(":memory:");
    const board = flock.createBoard(ada, { title: "Flock v1" });
    flock.subscribePush(ada, { endpoint: "https://push.example/ada-phone", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    const app = createApp({ flock, dbPath: ":memory:", flockHome: home, pushSend: send, now: () => t, pushIntervalMs: 20 });

    // ada opens the board on her phone and taps; the heartbeat reports her present.
    const beat = async (idleFor: number, focused = false) => {
      const looking = clientIsLooking(iosForeground(t, idleFor, focused));
      const res = await app.request("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json", "x-flock-actor": "ada", "x-flock-actor-kind": "human" },
        body: JSON.stringify({ client: "phone", board: board.slug, looking }),
      });
      expect(res.status).toBe(204);
      return looking;
    };

    // The tap itself: focused and fresh, so this beat says "looking" under any rule.
    expect(await beat(2_000, true)).toBe(true);
    await sayAndSettle(app, flock, board.id, "first line");
    expect(calls.length).toBe(0);

    // She reads without tapping for five minutes — well past IDLE_MS — the app never leaving the
    // foreground. Heartbeats keep the presence entry inside PRESENCE_TTL_MS the whole way.
    for (let elapsed = 15_000; elapsed <= IDLE_MS + 120_000; elapsed += 15_000) {
      t += 15_000;
      await beat(elapsed);
    }

    await sayAndSettle(app, flock, board.id, "status line while she is reading it");
    expect(calls.length).toBe(0);
    // ...because every one of those beats reported her present, unfocused and idle though she was.
    expect(clientIsLooking(iosForeground(t, IDLE_MS + 120_000))).toBe(true);
  });

  test("the same sequence on a desktop still goes idle and pushes", async () => {
    const flock = new Flock(":memory:");
    const board = flock.createBoard(ada, { title: "Flock v1" });
    flock.subscribePush(ada, { endpoint: "https://push.example/ada-mac", keys: { p256dh: "p", auth: "a" } });
    const { send, calls } = fakeSend();
    let t = 1_000_000;
    const app = createApp({ flock, dbPath: ":memory:", flockHome: home, pushSend: send, now: () => t, pushIntervalMs: 20 });

    const beat = async (looking: boolean) => {
      await app.request("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json", "x-flock-actor": "ada", "x-flock-actor-kind": "human" },
        body: JSON.stringify({ client: "mac", board: board.slug, looking }),
      });
    };

    const desktop = (idleFor: number) => clientIsLooking({ visible: true, focused: true, lastInputAt: t - idleFor, now: t, foregroundOnly: false });
    expect(desktop(2_000)).toBe(true);
    await beat(desktop(2_000));
    await sayAndSettle(app, flock, board.id, "first line");
    expect(calls.length).toBe(0);

    t += IDLE_MS;
    expect(desktop(IDLE_MS)).toBe(false);
    await beat(desktop(IDLE_MS));
    await sayAndSettle(app, flock, board.id, "she walked away");
    expect(calls.length).toBe(1);
  });
});

describe("POST /api/presence", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a valid report returns 204, even with push disabled", async () => {
    const flock = new Flock(":memory:");
    const app = createApp({ flock, dbPath: ":memory:", push: false });
    const res = await app.request("/api/presence", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ client: "c1", board: null, looking: true }),
    });
    expect(res.status).toBe(204);
  });

  test("a missing client is 400", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/presence", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ board: null, looking: true }),
    });
    expect(res.status).toBe(400);
  });

  test("a non-boolean looking is 400", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/presence", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ client: "c1", board: null, looking: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  test("an unknown board slug is still 204, not 404", async () => {
    const { app } = appWithPush({ flockHome: home });
    const res = await app.request("/api/presence", {
      method: "POST",
      headers: scoutHeaders,
      body: JSON.stringify({ client: "c1", board: "no-such-board", looking: true }),
    });
    expect(res.status).toBe(204);
  });
});
