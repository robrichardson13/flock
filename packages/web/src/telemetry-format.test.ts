import { describe, expect, it } from "bun:test";
import {
  alsoWorkedAcross,
  contextPercent,
  formatAgo,
  formatCompactNumber,
  formatContext,
  formatCostUsd,
  formatDurationMs,
  formatToolCalls,
  hasLiveSession,
  hasReadings,
  liveDurationMs,
  liveSessionDurationMs,
  modelDiffers,
  resolvedModel,
  topTools,
  totalDurationMs,
  totalTokens,
  UNKNOWN,
} from "./telemetry-format.ts";
import type { HarnessSessionTelemetry } from "./api.ts";

describe("formatCostUsd", () => {
  it("formats a known cost to two decimals", () => {
    expect(formatCostUsd(4.3)).toBe("$4.30");
    expect(formatCostUsd(0.005)).toBe("$0.01");
  });
  it("never renders a live/unknown cost as $0.00", () => {
    expect(formatCostUsd(undefined)).toBe(UNKNOWN);
    expect(formatCostUsd(Number.NaN)).toBe(UNKNOWN);
  });
  it("does render an actually-zero cost as $0.00 — a real reading, not an absent one", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatCompactNumber", () => {
  it("compacts thousands and millions", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1000)).toBe("1K");
    expect(formatCompactNumber(148191)).toBe("148.2K");
    expect(formatCompactNumber(1000000)).toBe("1M");
    expect(formatCompactNumber(3653384)).toBe("3.7M");
  });
});

describe("formatContext", () => {
  it("renders used and max together", () => {
    expect(formatContext(182_000, 1_000_000)).toBe("182K / 1M");
  });
  it("is unknown, not a partial fraction, when either half is missing", () => {
    expect(formatContext(182_000, undefined)).toBe(UNKNOWN);
    expect(formatContext(undefined, 1_000_000)).toBe(UNKNOWN);
    expect(formatContext(undefined, undefined)).toBe(UNKNOWN);
  });
});

describe("contextPercent", () => {
  it("rounds and clamps to 0-100", () => {
    expect(contextPercent(150_000, 1_000_000)).toBe(15);
    expect(contextPercent(2_000_000, 1_000_000)).toBe(100);
  });
  it("is null, never 0, when a reading is missing", () => {
    expect(contextPercent(undefined, 1_000_000)).toBeNull();
    expect(contextPercent(0, 1_000_000)).toBe(0);
  });
});

describe("formatToolCalls", () => {
  it("pluralizes and singularizes", () => {
    expect(formatToolCalls(1)).toBe("1 tool");
    expect(formatToolCalls(47)).toBe("47 tools");
  });
  it("is unknown, never 0 tools, when nothing has been read", () => {
    expect(formatToolCalls(undefined)).toBe(UNKNOWN);
  });
  it("does render a real zero", () => {
    expect(formatToolCalls(0)).toBe("0 tools");
  });
});

describe("formatDurationMs", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(21 * 60_000)).toBe("21m");
    expect(formatDurationMs(65 * 60_000)).toBe("1h 5m");
    expect(formatDurationMs(60 * 60_000)).toBe("1h");
  });
  it("is unknown for null, undefined or negative", () => {
    expect(formatDurationMs(null)).toBe(UNKNOWN);
    expect(formatDurationMs(undefined)).toBe(UNKNOWN);
    expect(formatDurationMs(-5)).toBe(UNKNOWN);
  });
});

describe("liveDurationMs", () => {
  const now = Date.parse("2026-09-12T00:10:00.000Z");
  it("uses the stored ms once the card is closed", () => {
    expect(liveDurationMs({ claimedAt: "2026-09-12T00:00:00.000Z", closedAt: "2026-09-12T00:05:00.000Z", ms: 300_000 }, now)).toBe(300_000);
  });
  it("counts up from the claim while doing, ignoring a stale ms of null", () => {
    expect(liveDurationMs({ claimedAt: "2026-09-12T00:00:00.000Z", closedAt: null, ms: null }, now)).toBe(600_000);
  });
  it("is null when there is no claim to count from", () => {
    expect(liveDurationMs({ claimedAt: null, closedAt: null, ms: null }, now)).toBeNull();
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-09-12T00:10:00.000Z");
  it("reads at second, minute and hour resolution", () => {
    expect(formatAgo("2026-09-12T00:09:48.000Z", now)).toBe("12s ago");
    expect(formatAgo("2026-09-12T00:05:00.000Z", now)).toBe("5m ago");
    expect(formatAgo("2026-09-11T21:10:00.000Z", now)).toBe("3h ago");
  });
  it("is unknown with no reading at all", () => {
    expect(formatAgo(undefined, now)).toBe(UNKNOWN);
  });
});

const session = (over: Partial<HarnessSessionTelemetry> = {}): HarnessSessionTelemetry => ({
  key: "claude-code:abc",
  actor: "harness-web",
  observedAt: "2026-09-12T00:00:00.000Z",
  alsoWorked: [],
  ...over,
});

describe("resolvedModel / modelDiffers", () => {
  it("prefers the observed model over the declared one", () => {
    expect(resolvedModel(session({ model: "claude-opus-5", declaredModel: "opus" }))).toBe("claude-opus-5");
  });
  it("falls back to the declared model when nothing was observed", () => {
    expect(resolvedModel(session({ declaredModel: "opus" }))).toBe("opus");
  });
  it("flags a mismatch only when both are known and differ", () => {
    expect(modelDiffers(session({ model: "claude-opus-5", declaredModel: "opus" }))).toBe(true);
    expect(modelDiffers(session({ model: "claude-opus-5", declaredModel: "claude-opus-5" }))).toBe(false);
    expect(modelDiffers(session({ model: "claude-opus-5" }))).toBe(false);
  });
});

describe("totalTokens", () => {
  it("sums all four token counters across sessions", () => {
    const sessions = [
      session({ inputTokens: 100, outputTokens: 50 }),
      session({ cacheReadTokens: 10, cacheWriteTokens: 5 }),
    ];
    expect(totalTokens(sessions)).toBe(165);
  });
  it("is null, not 0, when no session has reported any tokens", () => {
    expect(totalTokens([session(), session()])).toBeNull();
  });
});

describe("liveSessionDurationMs", () => {
  const now = Date.parse("2026-09-12T00:10:00.000Z");
  it("uses the harness's own duration once the session has one", () => {
    expect(liveSessionDurationMs(session({ durationMs: 5000, startedAt: "2026-09-12T00:00:00.000Z" }), now)).toBe(5000);
  });
  it("counts up from startedAt while the session is still live", () => {
    expect(liveSessionDurationMs(session({ startedAt: "2026-09-12T00:00:00.000Z" }), now)).toBe(600_000);
  });
  it("is null with neither a reported duration nor a known start", () => {
    expect(liveSessionDurationMs(session(), now)).toBeNull();
  });
});

describe("totalDurationMs", () => {
  const now = Date.parse("2026-09-12T00:10:00.000Z");
  it("sums each session's own duration", () => {
    expect(totalDurationMs([session({ durationMs: 1000 }), session({ durationMs: 2000 })], now)).toBe(3000);
  });
  it("counts a live session's elapsed time into the total too", () => {
    expect(totalDurationMs([session({ durationMs: 1000 }), session({ startedAt: "2026-09-12T00:09:00.000Z" })], now)).toBe(1000 + 60_000);
  });
  it("is null when every session is still live with no known start", () => {
    expect(totalDurationMs([session(), session()], now)).toBeNull();
  });
});

describe("hasLiveSession", () => {
  it("is true when any session is running or idle", () => {
    expect(hasLiveSession([session({ liveness: "gone" }), session({ liveness: "running" })])).toBe(true);
    expect(hasLiveSession([session({ liveness: "idle" })])).toBe(true);
  });
  it("is false when every session has ended or is unread", () => {
    expect(hasLiveSession([session({ liveness: "gone" })])).toBe(false);
    expect(hasLiveSession([session({ liveness: "unknown" }), session()])).toBe(false);
    expect(hasLiveSession([])).toBe(false);
  });
});

describe("topTools", () => {
  it("sorts by count desc, ties broken by name", () => {
    expect(topTools({ Read: 2, Bash: 24, Edit: 18, Write: 3 })).toEqual([["Bash", 24], ["Edit", 18], ["Write", 3]]);
  });
  it("is empty for an absent histogram", () => {
    expect(topTools(undefined)).toEqual([]);
  });
});

describe("hasReadings / alsoWorkedAcross (card 16 polish)", () => {
  const s = (over: Partial<HarnessSessionTelemetry> = {}): HarnessSessionTelemetry => ({
    key: "claude-code:a",
    actor: "a",
    observedAt: "2026-09-12T00:00:00.000Z",
    alsoWorked: [],
    ...over,
  });

  it("calls a session with nothing but a key unreadable", () => {
    expect(hasReadings(s())).toBe(false);
    expect(hasReadings(s({ liveness: "unknown" }))).toBe(false);
  });

  it("calls any single real reading readable", () => {
    expect(hasReadings(s({ model: "claude-opus-5" }))).toBe(true);
    expect(hasReadings(s({ costUsd: 0 }))).toBe(true);
    expect(hasReadings(s({ contextUsed: 1 }))).toBe(true);
    expect(hasReadings(s({ toolCalls: 0 }))).toBe(true);
    expect(hasReadings(s({ liveness: "gone" }))).toBe(true);
  });

  it("unions and sorts alsoWorked across sessions, de-duplicated", () => {
    expect(alsoWorkedAcross([s({ alsoWorked: [3, 1] }), s({ alsoWorked: [1, 2] })])).toEqual([1, 2, 3]);
    expect(alsoWorkedAcross([])).toEqual([]);
  });
});
