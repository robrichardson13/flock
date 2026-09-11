import { describe, expect, test } from "bun:test";
import { PRESENCE_TTL_MS, Presence } from "../src/index.ts";

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
