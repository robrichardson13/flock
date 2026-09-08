import { describe, expect, it } from "bun:test";
import { STATE_WORD, deskFact, idleMeta, liveAgents, wherePath } from "./BoardRow.tsx";
import type { CardStatus, TeamMember } from "./api.ts";

describe("wherePath", () => {
  it("keeps the last two segments of a project path", () => {
    expect(wherePath("/Users/dev/.nib/repos/flock/overall-ui", "overall-ui")).toBe("flock/overall-ui");
  });

  it("returns a single segment when that is all there is", () => {
    expect(wherePath("/x", "slug")).toBe("x");
  });

  it("tolerates a trailing slash", () => {
    expect(wherePath("/a/b/c/", "slug")).toBe("b/c");
  });

  it("falls back to the slug without a project", () => {
    expect(wherePath(null, "hosting")).toBe("hosting");
    expect(wherePath("/", "hosting")).toBe("hosting");
  });
});

describe("STATE_WORD", () => {
  it("names every board state", () => {
    expect(STATE_WORD).toEqual({
      awaiting: "needs you",
      working: "working",
      idle: "idle",
      complete: "done",
      archived: "archived",
    });
  });
});

const member = (name: string, kind: TeamMember["kind"], agoMs: number): TeamMember =>
  ({ name, kind, lastSeen: new Date(Date.now() - agoMs).toISOString(), events: 1 });

describe("liveAgents", () => {
  it("keeps only agents seen inside the active window, most recent first", () => {
    const team = [
      member("stale", "agent", 10 * 60_000),
      member("ada", "human", 1_000),
      member("older", "agent", 60_000),
      member("newest", "agent", 1_000),
    ];
    expect(liveAgents(team).map((m) => m.name)).toEqual(["newest", "older"]);
  });

  it("is empty when nobody is live, so the row keeps its chevron", () => {
    expect(liveAgents([member("gone", "agent", 60 * 60_000)])).toEqual([]);
  });

  it("leaves an overflow of two when five agents are live and three are shown", () => {
    const live = liveAgents([0, 1, 2, 3, 4].map((i) => member(`a${i}`, "agent", i * 1_000)));
    expect(live.length - live.slice(0, 3).length).toBe(2);
  });
});

const counts = (over: Partial<Record<CardStatus, number>> = {}): Record<CardStatus, number> =>
  ({ todo: 0, doing: 0, "awaiting-human": 0, done: 0, wontfix: 0, ...over });

describe("deskFact", () => {
  it("says how much is left, with the live count in front", () => {
    expect(deskFact({ state: "working", counts: counts({ doing: 2, todo: 3, done: 4 }), open: 5, total: 9 })).toBe("2 doing \u00B7 5 open");
  });

  it("drops the doing term when nobody is on it", () => {
    expect(deskFact({ state: "idle", counts: counts({ todo: 3, done: 1 }), open: 3, total: 4 })).toBe("3 open");
  });

  it("says what a finished board finished, wontfix folded into done", () => {
    expect(deskFact({ state: "complete", counts: counts({ done: 30, wontfix: 4 }), open: 0, total: 34 })).toBe("34 done");
  });

  it("names the two states that have no count to give", () => {
    expect(deskFact({ state: "archived", counts: counts(), open: 0, total: 12 })).toBe("Archived");
    expect(deskFact({ state: "idle", counts: counts(), open: 0, total: 0 })).toBe("No cards");
  });
});

describe("idleMeta", () => {
  const counts = (c: Partial<Record<CardStatus, number>>): Record<CardStatus, number> =>
    ({ todo: 0, doing: 0, "awaiting-human": 0, done: 0, wontfix: 0, ...c });
  const ago = () => "3d";
  const at = "2026-09-01T00:00:00.000Z";

  it("says what a finished board finished, wontfix folded into done", () => {
    expect(idleMeta({ state: "complete", counts: counts({ done: 30, wontfix: 4 }), open: 0, total: 34, lastActivityAt: at }, ago)).toBe("34 done · 3d");
  });

  it("says how much is left on a dormant board", () => {
    expect(idleMeta({ state: "idle", counts: counts({ todo: 5, done: 2 }), open: 5, total: 7, lastActivityAt: at }, ago)).toBe("5 open · 3d");
  });

  it("drops the age when the board was touched just now", () => {
    expect(idleMeta({ state: "idle", counts: counts({ todo: 5 }), open: 5, total: 5, lastActivityAt: at }, () => "just now")).toBe("5 open");
  });

  it("names the empty and archived cases instead of counting them", () => {
    expect(idleMeta({ state: "idle", counts: counts({}), open: 0, total: 0, lastActivityAt: at }, ago)).toBe("No cards");
    expect(idleMeta({ state: "archived", counts: counts({ done: 3 }), open: 0, total: 3, lastActivityAt: at }, ago)).toBe("Archived");
  });
});
