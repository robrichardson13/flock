import { describe, expect, test } from "bun:test";
import { Flock, type Actor } from "@flock/core";
import { bestEffortRefresh, fmtContext, fmtCost, fmtDuration, telemetryForActor, telemetryForCard } from "./telemetry.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scoutSession = "claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c";
const scout: Actor = { name: "scout", kind: "agent", session: scoutSession };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Telemetry", body: "" });
  return { f, board };
}

describe("format helpers", () => {
  test("fmtDuration renders hours, minutes, seconds, and the null dash", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(125_000)).toBe("2m5s");
    expect(fmtDuration(3_725_000)).toBe("1h2m");
  });

  test("fmtCost renders dollars or the unknown dash, never $0.00 for unknown", () => {
    expect(fmtCost(undefined)).toBe("—");
    expect(fmtCost(4.3426)).toBe("$4.34");
  });

  test("fmtContext renders K/K with a percentage, or the bare count with no max", () => {
    expect(fmtContext(undefined, undefined)).toBe("—");
    expect(fmtContext(148191, 1_000_000)).toBe("148K/1000K (15%)");
    expect(fmtContext(500, undefined)).toBe("500");
  });
});

describe("telemetryForCard / telemetryForActor", () => {
  test("a card with no session events reports empty telemetry and a null duration", async () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "X" });
    const result = await telemetryForCard(f, board.id, 1, { refresh: false, cwd: null });
    expect(result.telemetry).toEqual([]);
    expect(result.duration.ms).toBeNull();
    f.close();
  });

  test("a session with cost is final and is returned without attempting a refresh", async () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.claimCard(scout, board.id, 1);
    f.recordSessionReading({
      key: scoutSession,
      sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c",
      observedAt: "2026-09-11T00:00:00.000Z",
      endedAt: "2026-09-11T00:05:00.000Z",
      costUsd: 1.23,
      toolCalls: 7,
    });
    const result = await telemetryForCard(f, board.id, 1, { refresh: false, cwd: null });
    expect(result.telemetry).toHaveLength(1);
    // Unchanged: no cwd was ever available to resolve a refresh against, and none was needed.
    expect(result.telemetry[0]!.toolCalls).toBe(7);
    f.close();
  });

  test("an ended session without cost yet is still a refresh candidate (cost lands retroactively)", async () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.claimCard(scout, board.id, 1);
    f.recordSessionReading({
      key: scoutSession,
      sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c",
      observedAt: "2026-09-11T00:00:00.000Z",
      endedAt: "2026-09-11T00:05:00.000Z",
      toolCalls: 7,
    });
    // No cwd to resolve a reader against, so the refresh attempt is a no-op — but it must be
    // attempted (not skipped as "final") since there is still no cost on this reading.
    const result = await telemetryForCard(f, board.id, 1, { refresh: false, cwd: null });
    expect(result.telemetry).toHaveLength(1);
    expect(result.telemetry[0]!.toolCalls).toBe(7);
    expect(result.telemetry[0]!.costUsd).toBeUndefined();
    f.close();
  });

  test("a session with no stored row yet (link exists, no numbers) still appears and a refresh attempt does not throw", async () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.claimCard(scout, board.id, 1);
    // No recordSessionReading call: the events group-by alone must still surface the link.
    const result = await telemetryForCard(f, board.id, 1, { refresh: true, cwd: null });
    expect(result.telemetry).toHaveLength(1);
    expect(result.telemetry[0]!.key).toBe(scoutSession);
    expect(result.telemetry[0]!.actor).toBe("scout");
    f.close();
  });

  test("telemetryForActor sums cost and tool calls across distinct sessions", async () => {
    const { f, board } = fresh();
    f.createCard(scout, board.id, { title: "X" });
    f.claimCard(scout, board.id, 1);
    f.recordSessionReading({
      key: scoutSession,
      sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c",
      observedAt: "2026-09-11T00:00:00.000Z",
      endedAt: "2026-09-11T00:05:00.000Z",
      costUsd: 1.5,
      toolCalls: 4,
    });
    const result = await telemetryForActor(f, board.id, "scout", { refresh: false, cwd: null });
    expect(result.totals.costUsd).toBeCloseTo(1.5);
    expect(result.totals.toolCalls).toBe(4);
    expect(result.totals.cards).toEqual([1]);
    f.close();
  });

  test("an unknown actor with no sessions reports empty telemetry and null totals", async () => {
    const { f, board } = fresh();
    const result = await telemetryForActor(f, board.id, "nobody", { refresh: false, cwd: null });
    expect(result.telemetry).toEqual([]);
    expect(result.totals).toEqual({ costUsd: null, toolCalls: null, cards: [] });
    f.close();
  });
});

describe("bestEffortRefresh", () => {
  test("does nothing, and never throws, when there is no session", async () => {
    const { f } = fresh();
    await expect(bestEffortRefresh(f, undefined, "/tmp")).resolves.toBeUndefined();
    f.close();
  });

  test("does not throw for a session with no cwd hint available", async () => {
    const { f } = fresh();
    await expect(bestEffortRefresh(f, scoutSession, "")).resolves.toBeUndefined();
    f.close();
  });
});
