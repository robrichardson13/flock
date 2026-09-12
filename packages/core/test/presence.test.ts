import { describe, expect, test } from "bun:test";
import { clientIsLooking, IDLE_MS, PRESENCE_TTL_MS, Presence } from "../src/index.ts";

describe("Presence", () => {
  test("report looking makes isLooking true for that actor+board only", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: "board-1", looking: true }, 1000);

    expect(presence.isLooking("ada", "board-1", 1000)).toBe(true);
    expect(presence.isLooking("scout", "board-1", 1000)).toBe(false); // other actor
    expect(presence.isLooking("ada", "board-2", 1000)).toBe(false); // other board
  });

  test("Home (boardId: null) never matches isLooking", () => {
    const presence = new Presence();
    presence.report({ client: "c1", actor: "ada", boardId: null, looking: true }, 1000);

    // isLooking always takes a string boardId, so a null-board report can
    // never satisfy any isLooking(actor, boardId, now) query.
    expect(presence.isLooking("ada", "board-1", 1000)).toBe(false);
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
