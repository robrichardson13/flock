import { describe, expect, test } from "bun:test";
import { buildNotifyPatch, formatNotifySettings, formatThreshold, isEmptyPatch, parseOnOff, parseThreshold } from "./notify.ts";
import { DEFAULT_NOTIFY_SETTINGS } from "@flock/core";

describe("parseOnOff", () => {
  test("accepts on/off, case-insensitive", () => {
    expect(parseOnOff("on", "review")).toBe(true);
    expect(parseOnOff("OFF", "review")).toBe(false);
    expect(parseOnOff(" On ", "review")).toBe(true);
  });

  test("rejects anything else, naming the flag", () => {
    expect(() => parseOnOff("yes", "review")).toThrow(/--review must be "on" or "off"/);
    expect(() => parseOnOff("1", "needs-me")).toThrow(/--needs-me/);
  });
});

describe("parseThreshold", () => {
  test("minutes, hours, and a bare number (minutes)", () => {
    expect(parseThreshold("30m")).toBe(30 * 60_000);
    expect(parseThreshold("2h")).toBe(2 * 60 * 60_000);
    expect(parseThreshold("45")).toBe(45 * 60_000);
    expect(parseThreshold("1H")).toBe(60 * 60_000);
  });

  test("rejects garbage", () => {
    expect(() => parseThreshold("soon")).toThrow(/--threshold must look like/);
    expect(() => parseThreshold("30x")).toThrow(/--threshold/);
    expect(() => parseThreshold("")).toThrow();
  });
});

describe("formatThreshold", () => {
  test("round-trips whole hours as h, everything else as m", () => {
    expect(formatThreshold(60 * 60_000)).toBe("1h");
    expect(formatThreshold(24 * 60 * 60_000)).toBe("24h");
    expect(formatThreshold(20 * 60_000)).toBe("20m");
    expect(formatThreshold(90 * 60_000)).toBe("90m");
  });
});

describe("buildNotifyPatch", () => {
  test("only includes flags actually passed", () => {
    expect(buildNotifyPatch({})).toEqual({});
    expect(buildNotifyPatch({ "needs-me": "off" })).toEqual({ needsMe: false });
    expect(
      buildNotifyPatch({ "needs-me": "on", review: "off", everything: "on", settled: "on", threshold: "1h" }),
    ).toEqual({ needsMe: true, review: false, info: true, settled: true, settledAfterMs: 60 * 60_000 });
  });

  test("propagates a bad on/off or threshold as a FlockError", () => {
    expect(() => buildNotifyPatch({ review: "sometimes" })).toThrow();
    expect(() => buildNotifyPatch({ threshold: "later" })).toThrow();
  });
});

describe("isEmptyPatch", () => {
  test("true for {}, false once any field is set", () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ needsMe: false })).toBe(false);
  });
});

describe("formatNotifySettings", () => {
  const resolved = { ...DEFAULT_NOTIFY_SETTINGS };

  test("global (boardId '') labels every set field 'global', everything else 'default'", () => {
    const global = { needsMe: false, review: null, info: null, settled: null, settledAfterMs: null };
    const lines = formatNotifySettings({ boardId: "", boardLabel: "global (all boards)", resolved: { ...resolved, needsMe: false }, board: null, global });
    expect(lines[0]).toBe("Notify settings — global (all boards):");
    expect(lines.find((l) => l.includes("needs-me"))).toContain("(global)");
    expect(lines.find((l) => l.includes("review"))).toContain("(default)");
  });

  test("a board override reports 'board'; an inherited global value reports 'global'; neither reports 'default'", () => {
    const global = { needsMe: null, review: false, info: null, settled: null, settledAfterMs: null };
    const board = { needsMe: null, review: null, info: true, settled: null, settledAfterMs: 45 * 60_000 };
    const lines = formatNotifySettings({
      boardId: "b1",
      boardLabel: "flock-2",
      resolved: { needsMe: true, review: false, info: true, settled: false, settledAfterMs: 45 * 60_000 },
      board,
      global,
    });
    expect(lines.find((l) => l.includes("needs-me"))).toContain("(default)");
    expect(lines.find((l) => l.includes("review"))).toContain("(global)");
    expect(lines.find((l) => l.includes("everything"))).toContain("(board)");
    expect(lines.find((l) => l.includes("threshold"))).toContain("(board)");
  });
});
