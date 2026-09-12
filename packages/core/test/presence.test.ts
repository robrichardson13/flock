import { describe, expect, test } from "bun:test";
import { clientIsLooking, IDLE_MS, MAX_PRESENCE_CLIENTS, PRESENCE_TTL_MS, Presence, unresolvedScope } from "../src/index.ts";

describe("Presence", () => {
  test("report looking makes isLooking true for that actor+board only", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);

    expect(presence.isLooking("ada", "board-1", 1000)).toBe(true);
    expect(presence.isLooking("scout", "board-1", 1000)).toBe(false); // other actor
    expect(presence.isLooking("ada", "board-2", 1000)).toBe(false); // other board
  });

  test("Home (boardId: null) matches every board (card 54)", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: null, looking: true }, 1000);

    // Was: a null-board report satisfied no isLooking query at all. Measured on the phone, that
    // meant an app sitting on its own launch route suppressed nothing. See the card 54 block below.
    expect(presence.isLooking("ada", "board-1", 1000)).toBe(true);
    expect(presence.isLooking("ada", "board-2", 1000)).toBe(true);
    expect(presence.isLooking("scout", "board-1", 1000)).toBe(false);
  });

  test("TTL boundary", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);

    expect(presence.isLooking("ada", "board-1", 1000 + PRESENCE_TTL_MS - 1)).toBe(true);
    expect(presence.isLooking("ada", "board-1", 1000 + PRESENCE_TTL_MS)).toBe(false);
  });

  test("looking: false removes immediately", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);
    expect(presence.isLooking("ada", "board-1", 1000)).toBe(true);

    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: false }, 1001);
    expect(presence.isLooking("ada", "board-1", 1001)).toBe(false);
  });

  test("two clients of one actor tracked independently", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);
    presence.report({ client: "c2", actor: "ada", boardId: "board-1", looking: true }, 1000);

    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: false }, 1001);
    expect(presence.isLooking("ada", "board-1", 1001)).toBe(true);

    presence.report({ client: "c2", actor: "ada", boardId: "board-1", looking: false }, 1002);
    expect(presence.isLooking("ada", "board-1", 1002)).toBe(false);
  });

  test("a client re-reporting a different board moves, not duplicates", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);
    presence.report({ client: "c1", actor: "ada", boardId: "board-2", looking: true }, 1001);

    expect(presence.isLooking("ada", "board-1", 1001)).toBe(false);
    expect(presence.isLooking("ada", "board-2", 1001)).toBe(true);
    expect(presence.size(1001)).toBe(1);
  });

  test("size() prunes stale entries", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);
    presence.report({ client: "c2", actor: "scout", boardId: "board-1", looking: true }, 1000);

    expect(presence.size(1000)).toBe(2);
    expect(presence.size(1000 + PRESENCE_TTL_MS)).toBe(0);
  });
});

describe("clientIsLooking", () => {
  const t0 = 1_000_000;
  const desktop = (over: Partial<Parameters<typeof clientIsLooking>[0]> = {}) =>
    clientIsLooking({ visible: true, focused: true, lastInputAt: t0, now: t0 + 1000, foregroundOnly: false, ...over });
  const phone = (over: Partial<Parameters<typeof clientIsLooking>[0]> = {}) =>
    clientIsLooking({ visible: true, focused: true, lastInputAt: t0, now: t0 + 1000, foregroundOnly: true, ...over });

  test("hidden is never looking, on either kind of device", () => {
    expect(desktop({ visible: false })).toBe(false);
    expect(phone({ visible: false })).toBe(false);
  });

  test("desktop still needs focus and input inside IDLE_MS", () => {
    expect(desktop()).toBe(true);
    expect(desktop({ focused: false })).toBe(false);
    expect(desktop({ now: t0 + IDLE_MS - 1 })).toBe(true);
    expect(desktop({ now: t0 + IDLE_MS })).toBe(false);
  });

  test("a foreground-only device is looking whenever it is visible", () => {
    // Card 20: iOS standalone reports no focus and goes minutes between taps while being read.
    expect(phone({ focused: false })).toBe(true);
    expect(phone({ focused: false, now: t0 + IDLE_MS * 10 })).toBe(true);
  });
});

describe("Presence observability (card 54)", () => {
  const t0 = 1_000_000;

  test("lookingDetail carries the freshest report's age and how many clients matched", () => {
    const p = new Presence();
    p.report({ client: "a", actor: "rob", boardId: "b1", looking: true }, t0);
    p.report({ client: "b", actor: "rob", boardId: "b1", looking: true }, t0 + 4_000);

    const hit = p.lookingDetail("rob", "b1", t0 + 5_000);
    expect(hit).toEqual({ looking: true, ageMs: 1_000, clients: 2, via: "board" });

    expect(p.lookingDetail("rob", "b2", t0 + 5_000)).toEqual({ looking: false, ageMs: null, clients: 0, via: null });
    expect(p.lookingDetail("ada", "b1", t0 + 5_000)).toEqual({ looking: false, ageMs: null, clients: 0, via: null });
    // Home is its own key, not a wildcard.
    expect(p.lookingDetail("rob", null, t0 + 5_000).looking).toBe(false);
  });

  test("lookingDetail agrees with isLooking across the TTL boundary", () => {
    const p = new Presence();
    p.report({ client: "a", actor: "rob", boardId: "b1", looking: true }, t0);
    const justInside = t0 + PRESENCE_TTL_MS - 1;
    expect(p.lookingDetail("rob", "b1", justInside).looking).toBe(p.isLooking("rob", "b1", justInside));
    expect(p.lookingDetail("rob", "b1", justInside).ageMs).toBe(PRESENCE_TTL_MS - 1);
    const expired = t0 + PRESENCE_TTL_MS;
    expect(p.lookingDetail("rob", "b1", expired)).toEqual({ looking: false, ageMs: null, clients: 0, via: null });
  });

  test("snapshot dumps live clients freshest first, with their info block", () => {
    const p = new Presence();
    p.report({ client: "old", actor: "rob", boardId: "b1", looking: true, info: { build: "one", mode: "browser" } }, t0);
    p.report({ client: "new", actor: "rob", boardId: null, looking: true, info: { build: "two", mode: "standalone" } }, t0 + 2_000);

    const dump = p.snapshot(t0 + 3_000);
    expect(dump.map((e) => e.client)).toEqual(["new", "old"]);
    expect(dump[0]).toMatchObject({ actor: "rob", boardId: null, ageMs: 1_000, reportedAt: t0 + 2_000 });
    expect(dump[0]!.info).toEqual({ build: "two", mode: "standalone" });
    expect(dump[1]!.ageMs).toBe(3_000);

    // A leave beat removes the client from the dump, not just from isLooking.
    p.report({ client: "new", actor: "rob", boardId: null, looking: false }, t0 + 3_000);
    expect(p.snapshot(t0 + 3_000).map((e) => e.client)).toEqual(["old"]);
    // And an expired client is gone from the dump too.
    expect(p.snapshot(t0 + PRESENCE_TTL_MS)).toEqual([]);
  });

  test("the map is capped, evicting the entry closest to expiry", () => {
    const p = new Presence();
    for (let i = 0; i < MAX_PRESENCE_CLIENTS; i++) {
      p.report({ client: `c${i}`, actor: "rob", boardId: "b1", looking: true }, t0 + i);
    }
    expect(p.size(t0)).toBe(MAX_PRESENCE_CLIENTS);

    p.report({ client: "newcomer", actor: "rob", boardId: "b1", looking: true }, t0 + MAX_PRESENCE_CLIENTS);
    expect(p.size(t0)).toBe(MAX_PRESENCE_CLIENTS);
    const clients = new Set(p.snapshot(t0).map((e) => e.client));
    expect(clients.has("newcomer")).toBe(true);
    expect(clients.has("c0")).toBe(false);

    // Re-reporting an existing client never evicts anyone.
    p.report({ client: "newcomer", actor: "rob", boardId: "b1", looking: true }, t0 + MAX_PRESENCE_CLIENTS + 1);
    expect(p.size(t0)).toBe(MAX_PRESENCE_CLIENTS);
  });
});

/**
 * Card 54, measured on the real phone: an iOS home-screen app launches at `start_url: "/"`, which
 * is Home, and the log showed it beating `board=-` for long stretches while plainly foregrounded.
 * Keyed strictly by board, Home suppressed nothing on any board — so the app buzzed the phone in
 * the user's hand through the whole first stretch of every session.
 */
describe("a client on Home is looking at every board (card 54)", () => {
  const t0 = 1_000_000;

  test("Home suppresses any board, and says so", () => {
    const p = new Presence();
    p.report({ client: "phone", actor: "rob", boardId: null, looking: true }, t0);

    expect(p.isLooking("rob", "b1", t0 + 1_000)).toBe(true);
    expect(p.isLooking("rob", "b2", t0 + 1_000)).toBe(true);
    expect(p.lookingDetail("rob", "b1", t0 + 1_000)).toEqual({ looking: true, ageMs: 1_000, clients: 1, via: "home" });

    // Still only this actor's own presence.
    expect(p.isLooking("ada", "b1", t0 + 1_000)).toBe(false);
    // And still bounded by the TTL: a Home client that stops beating stops suppressing.
    expect(p.isLooking("rob", "b1", t0 + PRESENCE_TTL_MS)).toBe(false);
  });

  test("a client on one board still suppresses only that board", () => {
    const p = new Presence();
    p.report({ client: "phone", actor: "rob", boardId: "b1", looking: true }, t0);
    expect(p.isLooking("rob", "b1", t0)).toBe(true);
    expect(p.isLooking("rob", "b2", t0)).toBe(false);
    expect(p.lookingDetail("rob", "b1", t0).via).toBe("board");
    expect(p.lookingDetail("rob", "b2", t0).via).toBe(null);
  });

  test("a board match is reported over a Home match when both are live", () => {
    const p = new Presence();
    p.report({ client: "home", actor: "rob", boardId: null, looking: true }, t0 + 1_000);
    p.report({ client: "board", actor: "rob", boardId: "b1", looking: true }, t0);
    const detail = p.lookingDetail("rob", "b1", t0 + 2_000);
    expect(detail).toEqual({ looking: true, ageMs: 1_000, clients: 2, via: "board" });
  });

  test("an unresolved board scope is not Home and suppresses nothing", () => {
    // A tab left open on a deleted board must not silence every board it can no longer name.
    const p = new Presence();
    p.report({ client: "stale", actor: "rob", boardId: unresolvedScope("deleted-board"), looking: true }, t0);
    expect(p.isLooking("rob", "b1", t0)).toBe(false);
    expect(p.lookingDetail("rob", "b1", t0)).toEqual({ looking: false, ageMs: null, clients: 0, via: null });
    // It is still in the dump, so the log can show what that client thinks it is on.
    expect(p.snapshot(t0)).toHaveLength(1);
  });

  test("leaving Home stops the suppression at once, not on the TTL", () => {
    const p = new Presence();
    p.report({ client: "phone", actor: "rob", boardId: null, looking: true }, t0);
    p.report({ client: "phone", actor: "rob", boardId: null, looking: false }, t0 + 1_000);
    expect(p.isLooking("rob", "b1", t0 + 1_000)).toBe(false);
  });
});
