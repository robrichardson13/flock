import { describe, expect, test } from "bun:test";
import { groupBoardsByActivity, isActiveBoard } from "./boardActivity.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z").getTime();

function board(overrides: Partial<{ doing: number; awaiting: number; lastEvent: string | null }> = {}) {
  const { doing = 0, awaiting = 0, lastEvent = null } = overrides;
  return {
    counts: { doing, "awaiting-human": awaiting } as { doing: number; "awaiting-human": number },
    lastEvent: lastEvent ? { createdAt: lastEvent } : null,
  };
}

describe("isActiveBoard", () => {
  test("a doing card makes a board active regardless of recency", () => {
    expect(isActiveBoard(board({ doing: 1, lastEvent: "2020-01-01T00:00:00.000Z" }), NOW)).toBe(true);
  });

  test("an awaiting-human card makes a board active", () => {
    expect(isActiveBoard(board({ awaiting: 1 }), NOW)).toBe(true);
  });

  test("no open work but an event inside the last hour is active", () => {
    expect(isActiveBoard(board({ lastEvent: "2026-09-06T11:30:00.000Z" }), NOW)).toBe(true);
  });

  test("an event exactly at the one-hour boundary is idle", () => {
    expect(isActiveBoard(board({ lastEvent: "2026-09-06T11:00:00.000Z" }), NOW)).toBe(false);
  });

  test("an event just inside the hour is active", () => {
    expect(isActiveBoard(board({ lastEvent: "2026-09-06T11:00:00.001Z" }), NOW)).toBe(true);
  });

  test("an event over an hour old with no open work is idle", () => {
    expect(isActiveBoard(board({ lastEvent: "2026-09-06T10:00:00.000Z" }), NOW)).toBe(false);
  });

  test("no open work and no last event at all falls back to idle", () => {
    expect(isActiveBoard(board(), NOW)).toBe(false);
  });
});

describe("groupBoardsByActivity", () => {
  test("splits into active-first and idle groups, preserving relative order", () => {
    const a = { id: "a", ...board({ awaiting: 1 }) };
    const b = { id: "b", ...board() };
    const c = { id: "c", ...board({ doing: 1 }) };
    const d = { id: "d", ...board({ lastEvent: "2026-09-06T11:59:00.000Z" }) };
    const { active, idle } = groupBoardsByActivity([a, b, c, d], NOW);
    expect(active.map((x) => x.id)).toEqual(["a", "c", "d"]);
    expect(idle.map((x) => x.id)).toEqual(["b"]);
  });

  test("an all-active or all-idle list leaves the other group empty", () => {
    const a = { id: "a", ...board({ doing: 1 }) };
    expect(groupBoardsByActivity([a], NOW)).toEqual({ active: [a], idle: [] });
    const b = { id: "b", ...board() };
    expect(groupBoardsByActivity([b], NOW)).toEqual({ active: [], idle: [b] });
  });

  test("an empty list produces two empty groups", () => {
    expect(groupBoardsByActivity([], NOW)).toEqual({ active: [], idle: [] });
  });
});
