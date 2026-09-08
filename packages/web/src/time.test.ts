import { describe, expect, it } from "bun:test";
import { agoText, timeAgo } from "./App.tsx";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("timeAgo", () => {
  it("says 'just now' under a minute and never goes negative for a clock skew", () => {
    expect(timeAgo(ago(0))).toBe("just now");
    expect(timeAgo(ago(59_000))).toBe("just now");
    expect(timeAgo(ago(-5_000))).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(timeAgo(ago(5 * 60_000))).toBe("5m");
    expect(timeAgo(ago(3 * 3_600_000))).toBe("3h");
    expect(timeAgo(ago(6 * 86_400_000))).toBe("6d");
  });
});

describe("agoText", () => {
  it("appends 'ago' only to the numeric forms, so nothing reads 'just now ago'", () => {
    expect(agoText(ago(0))).toBe("just now");
    expect(agoText(ago(5 * 60_000))).toBe("5m ago");
    expect(agoText(ago(2 * 86_400_000))).toBe("2d ago");
  });
});
