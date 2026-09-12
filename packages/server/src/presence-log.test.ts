import { describe, expect, test } from "bun:test";
import { Flock } from "@flock/core";
import { createApp } from "./index.ts";
import {
  formatPresenceReport,
  formatPushDecision,
  isLoopbackRequest,
  normalizeClientInfo,
  shortDuration,
  shortUserAgent,
} from "./presence-log.ts";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";

describe("shortUserAgent", () => {
  test("names the phone and its iOS version without leaking the raw string", () => {
    expect(shortUserAgent(IPHONE_UA)).toBe("iPhone/18.7/Safari");
  });

  test("Chrome on a Mac, and an unknown agent", () => {
    expect(shortUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36")).toBe("Mac/Chrome");
    expect(shortUserAgent(undefined)).toBe("?");
    expect(shortUserAgent("")).toBe("?");
  });

  test("is bounded at 40 characters", () => {
    expect(shortUserAgent("x".repeat(5000)).length).toBeLessThanOrEqual(40);
  });
});

describe("shortDuration", () => {
  test("milliseconds under a second, seconds above, dash for nothing", () => {
    expect(shortDuration(340)).toBe("340ms");
    expect(shortDuration(1500)).toBe("1.5s");
    expect(shortDuration(null)).toBe("-");
    expect(shortDuration(undefined)).toBe("-");
    expect(shortDuration(Number.NaN)).toBe("-");
  });
});

describe("formatPresenceReport", () => {
  const at = Date.parse("2026-09-12T17:00:00.000Z");

  test("one greppable line carrying the client's own looking inputs", () => {
    const line = formatPresenceReport({
      at,
      client: "9f1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff",
      actor: "robrichardson",
      actorKind: "human",
      board: "flock-2",
      resolved: true,
      looking: true,
      info: {
        build: "1365363-m0abc",
        mode: "standalone",
        visible: true,
        focused: false,
        lastInputAgeMs: 12_000,
        foregroundOnly: true,
        userAgent: IPHONE_UA,
      },
    });
    expect(line).toBe(
      "[presence] 2026-09-12T17:00:00.000Z actor=robrichardson kind=human board=flock-2 looking=true " +
        "mode=standalone build=1365363-m0abc visible=true focused=false input=12.0s fg=true ua=iPhone/18.7/Safari client=9f1c2d3e",
    );
  });

  test("marks a board slug that did not resolve, and dashes every missing field", () => {
    const line = formatPresenceReport({
      at,
      client: "c1",
      actor: "rob",
      actorKind: "human",
      board: "gone-board",
      resolved: false,
      looking: false,
    });
    expect(line).toContain("board=gone-board(unknown)");
    expect(line).toContain("looking=false");
    expect(line).toContain("mode=- build=- visible=- focused=- input=- fg=- ua=?");
  });

  test("Home reports no board", () => {
    const line = formatPresenceReport({ at, client: "c1", actor: "rob", actorKind: "human", board: null, resolved: false, looking: true });
    expect(line).toContain(" board=- ");
  });

  test("an actor name with a space is quoted, so the key=value shape survives", () => {
    const line = formatPresenceReport({ at, client: "c1", actor: "Rob R", actorKind: "human", board: null, resolved: false, looking: true });
    expect(line).toContain('actor="Rob R"');
  });
});

describe("formatPushDecision", () => {
  test("says what the pump believed about presence for the key it looked up", () => {
    expect(
      formatPushDecision({
        seq: 412,
        type: "message.posted",
        notificationClass: "chatter",
        actor: "robrichardson",
        board: "flock-2",
        boardId: "7129s3kt",
        looking: false,
        presenceAgeMs: null,
        presenceClients: 0,
        via: null,
        subscriptions: 1,
        level: "review",
        deliver: true,
        settings: null,
      }),
    ).toBe(
      "[push] decision event=412 type=message.posted class=chatter actor=robrichardson board=flock-2 boardId=7129s3kt looking=false age=- clients=0 level=review deliver=true settings=- subs=1",
    );
  });

  test("a looking recipient carries the age of the freshest beat", () => {
    const line = formatPushDecision({
      seq: 413,
      type: "message.posted",
      notificationClass: "chatter",
      actor: "rob",
      board: "flock-2",
      boardId: "b1",
      looking: true,
      presenceAgeMs: 3_000,
      presenceClients: 2,
      via: "board",
      subscriptions: 1,
      level: "review",
      deliver: true,
      settings: null,
    });
    expect(line).toContain("looking=true(board) age=3.0s clients=2");
  });

  test("a Home client's suppression is labelled, so the log distinguishes the two rules", () => {
    const line = formatPushDecision({
      seq: 415,
      type: "message.posted",
      notificationClass: "chatter",
      actor: "rob",
      board: "flock-2",
      boardId: "b1",
      looking: true,
      presenceAgeMs: 2_000,
      presenceClients: 1,
      via: "home",
      subscriptions: 1,
      level: "review",
      deliver: true,
      settings: null,
    });
    expect(line).toContain("looking=true(home)");
  });

  test("an urgent event says so, since presence never applied to it", () => {
    const line = formatPushDecision({
      seq: 414,
      type: "card.asked",
      notificationClass: "urgent",
      actor: "rob",
      board: "flock-2",
      boardId: "b1",
      looking: true,
      presenceAgeMs: 1_000,
      presenceClients: 1,
      via: "board",
      subscriptions: 1,
      level: null,
      deliver: true,
      settings: null,
    });
    // looking=true and it still goes out: ADR 0021 exempts asks. The class is what says
    // "by design" rather than "suppression failed".
    expect(line).toContain("type=card.asked class=urgent");
    expect(line).toContain("looking=true");
  });
});

describe("isLoopbackRequest", () => {
  test("accepts the loopback families", () => {
    expect(isLoopbackRequest("127.0.0.1")).toBe(true);
    expect(isLoopbackRequest("::1")).toBe(true);
    expect(isLoopbackRequest("[::1]")).toBe(true);
    expect(isLoopbackRequest("::ffff:127.0.0.1")).toBe(true);
  });

  test("refuses anything else, and fails closed on an unknown peer", () => {
    expect(isLoopbackRequest("100.83.205.118")).toBe(false);
    expect(isLoopbackRequest("192.168.1.10")).toBe(false);
    expect(isLoopbackRequest("::ffff:10.0.0.4")).toBe(false);
    expect(isLoopbackRequest(undefined)).toBe(false);
    expect(isLoopbackRequest(null)).toBe(false);
  });

  test("refuses a loopback peer that is forwarding for someone else", () => {
    expect(isLoopbackRequest("127.0.0.1", "100.83.205.118")).toBe(false);
  });
});

describe("normalizeClientInfo", () => {
  test("keeps the known fields and bounds the unbounded ones", () => {
    const info = normalizeClientInfo(
      { build: "x".repeat(500), mode: "standalone", visible: true, focused: false, lastInputAgeMs: 1e12, foregroundOnly: true },
      "u".repeat(5000),
    )!;
    expect(info.build!.length).toBe(64);
    expect(info.mode).toBe("standalone");
    expect(info.lastInputAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(info.userAgent!.length).toBe(256);
  });

  test("drops junk rather than trusting it", () => {
    const info = normalizeClientInfo({ mode: "kiosk", visible: "yes", lastInputAgeMs: Number.NaN, build: 7 }, undefined);
    expect(info).toBeUndefined();
  });

  test("a body with no info block still records the user agent", () => {
    expect(normalizeClientInfo(undefined, IPHONE_UA)).toEqual({ userAgent: IPHONE_UA });
  });
});

function fresh() {
  const flock = new Flock(":memory:");
  const app = createApp({ flock, dbPath: ":memory:", push: false });
  return { flock, app };
}

const loopback = { requestIP: () => ({ address: "127.0.0.1" }) };
const remote = { requestIP: () => ({ address: "100.83.205.118" }) };

describe("GET /api/presence", () => {
  test("is refused when the peer is not loopback", async () => {
    const { app } = fresh();
    const res = await app.request("/api/presence", {}, remote);
    expect(res.status).toBe(403);
  });

  test("is refused when Bun gave us no peer address at all", async () => {
    const { app } = fresh();
    const res = await app.request("/api/presence");
    expect(res.status).toBe(403);
  });

  test("is refused for a loopback peer carrying a forwarding header", async () => {
    const { app } = fresh();
    const res = await app.request("/api/presence", { headers: { "x-forwarded-for": "100.83.205.118" } }, loopback);
    expect(res.status).toBe(403);
  });

  test("dumps the live clients for a loopback peer, with the board slug resolved", async () => {
    const { flock, app } = fresh();
    const board = flock.createBoard({ name: "rob", kind: "human" }, { title: "Flock" });

    const post = await app.request("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "rob", "user-agent": IPHONE_UA },
      body: JSON.stringify({
        client: "c1",
        board: board.slug,
        looking: true,
        info: { build: "abc-1", mode: "standalone", visible: true, focused: false, lastInputAgeMs: 900, foregroundOnly: true },
      }),
    });
    expect(post.status).toBe(204);

    const res = await app.request("/api/presence", {}, loopback);
    expect(res.status).toBe(200);
    const dump = await res.json();
    expect(dump.clients).toHaveLength(1);
    expect(dump.clients[0].actor).toBe("rob");
    expect(dump.clients[0].board).toBe(board.slug);
    expect(dump.clients[0].boardId).toBe(board.id);
    expect(dump.clients[0].info.build).toBe("abc-1");
    expect(dump.clients[0].info.mode).toBe("standalone");
    expect(dump.clients[0].info.userAgent).toBe(IPHONE_UA);
    expect(dump.ttlMs).toBe(45_000);
  });

  test("a leave beat empties the dump", async () => {
    const { flock, app } = fresh();
    const board = flock.createBoard({ name: "rob", kind: "human" }, { title: "Flock" });
    const beat = (looking: boolean) =>
      app.request("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json", "x-flock-actor": "rob" },
        body: JSON.stringify({ client: "c1", board: board.slug, looking }),
      });
    await beat(true);
    await beat(false);
    const dump = await (await app.request("/api/presence", {}, loopback)).json();
    expect(dump.clients).toHaveLength(0);
  });
});
