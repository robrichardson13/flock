import { describe, expect, test } from "bun:test";
import { Flock, FlockError, type Actor, type SessionReading } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scoutSession = "claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c";
const scout: Actor = { name: "scout", kind: "agent", session: scoutSession };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Telemetry", body: "" });
  return { f, board };
}

function reading(overrides: Partial<SessionReading> = {}): SessionReading {
  return {
    key: scoutSession,
    sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c",
    observedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("recordSessionReading / upsert", () => {
  test("rejects a reading with no key, no sessionId, or no observedAt", () => {
    const { f } = fresh();
    expect(() => f.recordSessionReading(reading({ key: "" }))).toThrow(FlockError);
    expect(() => f.recordSessionReading({ ...reading(), sessionId: "" })).toThrow(FlockError);
    expect(() => f.recordSessionReading({ ...reading(), observedAt: "" } as SessionReading)).toThrow(FlockError);
  });

  test("rejects a key longer than the limit", () => {
    const { f } = fresh();
    expect(() => f.recordSessionReading(reading({ key: "x".repeat(500) }))).toThrow(/200/);
  });

  test("a later reading updates the numbers it carries", () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.recordSessionReading(reading({ harness: "claude-code@2.1.269", model: "claude-opus-5", toolCalls: 3, liveness: "running" }));
    f.recordSessionReading(reading({ toolCalls: 12, liveness: "idle" }));

    const [t] = f.sessionsForCard(board.id, 1);
    expect(t.toolCalls).toBe(12);
    expect(t.liveness).toBe("idle");
    // A field the second reading did not carry is untouched.
    expect(t.harness).toBe("claude-code@2.1.269");
    expect(t.model).toBe("claude-opus-5");
  });

  test("a null-carrying (absent) field on a later reading never clobbers a known value", () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.recordSessionReading(reading({ costUsd: 4.34, costExact: true }));
    // A liveness-only poll: no cost field at all.
    f.recordSessionReading(reading({ liveness: "gone" }));

    const [t] = f.sessionsForCard(board.id, 1);
    expect(t.costUsd).toBe(4.34);
    expect(t.costExact).toBe(true);
    expect(t.liveness).toBe("gone");
  });

  test("bounds an oversized tool histogram rather than growing the row without limit", () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    const tools: Record<string, number> = {};
    for (let i = 0; i < 500; i++) tools[`tool-${i}`] = i;
    f.recordSessionReading(reading({ tools }));

    const [t] = f.sessionsForCard(board.id, 1);
    expect(Object.keys(t.tools ?? {}).length).toBeLessThanOrEqual(64);
  });

  test("an oversized extra blob is dropped rather than stored partially", () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.recordSessionReading(reading({ extra: { blob: "x".repeat(10_000) } }));
    const [t] = f.sessionsForCard(board.id, 1);
    expect(t.extra).toBeUndefined();
  });
});

describe("sessionsForCard (group-by over events)", () => {
  test("a card with no session-linked event returns an empty array, not null", () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "No harness here" });
    expect(f.sessionsForCard(board.id, 1)).toEqual([]);
  });

  test("a session key on an event is enough to appear, even before any reading was ever recorded", () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    const [t] = f.sessionsForCard(board.id, 1);
    expect(t.key).toBe(scoutSession);
    expect(t.actor).toBe("scout");
    expect(t.alsoWorked).toEqual([]);
  });

  test("two sessions that both wrote on a card each appear once, and the same session on two cards reports alsoWorked", () => {
    const { f, board } = fresh();
    const otherSession = "claude-code:aaaaaaaa-1111-2222-3333-444444444444";
    const other: Actor = { name: "builder", kind: "agent", session: otherSession };

    const c1 = f.createCard(scout, board.id, { title: "First" });
    f.addComment(other, board.id, c1.num, "also worked here");
    const c2 = f.createCard(scout, board.id, { title: "Second" });
    void c2;

    const t1 = f.sessionsForCard(board.id, c1.num);
    expect(t1.map((s) => s.key).sort()).toEqual([otherSession, scoutSession].sort());
    const scoutEntry = t1.find((s) => s.key === scoutSession)!;
    expect(scoutEntry.alsoWorked).toEqual([2]);

    const t2 = f.sessionsForCard(board.id, c2.num);
    expect(t2).toHaveLength(1);
    expect(t2[0]!.alsoWorked).toEqual([1]);
  });

  test("declaredModel comes from the agent's own Runtime.model, independent of the observed harness_sessions.model", () => {
    const { f, board } = fresh();
    f.createCard({ ...scout, model: "sonnet" }, board.id, { title: "X" });
    f.recordSessionReading(reading({ model: "claude-opus-5" }));

    const [t] = f.sessionsForCard(board.id, 1);
    expect(t.declaredModel).toBe("sonnet");
    expect(t.model).toBe("claude-opus-5");
  });
});

describe("sessionsForActor", () => {
  test("an actor who never carried a session gets an empty array", () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "X" });
    expect(f.sessionsForActor(board.id, "ada")).toEqual([]);
  });

  test("one session across two cards collapses to one entry with both cards in alsoWorked", () => {
    const { f, board } = fresh();
    const c1 = f.createCard(scout, board.id, { title: "First" });
    f.claimCard(scout, board.id, c1.num);
    const c2 = f.createCard(scout, board.id, { title: "Second" });
    f.claimCard(scout, board.id, c2.num);

    const sessions = f.sessionsForActor(board.id, "scout");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.key).toBe(scoutSession);
    // alsoWorked lists every card touched other than the one being asked about elsewhere; from
    // the actor view it is just every card this session touched.
    expect(sessions[0]!.alsoWorked.sort()).toEqual([c1.num, c2.num].sort());
  });
});

describe("cardDuration", () => {
  test("a card never claimed reports both ends null and ms null", () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "X" });
    expect(f.cardDuration(board.id, 1)).toEqual({ claimedAt: null, closedAt: null, ms: null });
  });

  test("a claimed-but-open card reports claimedAt and a null ms", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "X" });
    f.claimCard(scout, board.id, c.num);
    const d = f.cardDuration(board.id, c.num);
    expect(d.claimedAt).not.toBeNull();
    expect(d.closedAt).toBeNull();
    expect(d.ms).toBeNull();
  });

  test("a claimed and closed card reports a non-negative ms, needing no harness at all", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "X" });
    f.claimCard(scout, board.id, c.num);
    f.closeCard(scout, board.id, c.num, { resolution: "done" });
    const d = f.cardDuration(board.id, c.num);
    expect(d.claimedAt).not.toBeNull();
    expect(d.closedAt).not.toBeNull();
    expect(d.ms).not.toBeNull();
    expect(d.ms!).toBeGreaterThanOrEqual(0);
  });
});
