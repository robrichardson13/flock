import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock, type Actor } from "@flock/core";
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
