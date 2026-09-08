import { describe, expect, it } from "bun:test";
import { FOCUSABLE_SELECTOR, focusReturnTarget, nextTrapIndex } from "./focus.ts";

describe("nextTrapIndex", () => {
  it("walks forward through the stops", () => {
    expect(nextTrapIndex(4, 0, false)).toBe(1);
    expect(nextTrapIndex(4, 2, false)).toBe(3);
  });

  it("wraps off the last stop to the first, instead of into the board underneath", () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0);
  });

  it("walks backward and wraps off the first stop to the last", () => {
    expect(nextTrapIndex(4, 2, true)).toBe(1);
    expect(nextTrapIndex(4, 0, true)).toBe(3);
  });

  it("enters at the first stop when focus is outside the dialog", () => {
    expect(nextTrapIndex(4, -1, false)).toBe(0);
    expect(nextTrapIndex(4, -1, true)).toBe(3);
  });

  it("treats an index past the end as outside", () => {
    expect(nextTrapIndex(4, 9, false)).toBe(0);
    expect(nextTrapIndex(4, 9, true)).toBe(3);
  });

  it("holds a single stop", () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
  });

  it("has nowhere to go in an empty dialog", () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1);
    expect(nextTrapIndex(0, 0, true)).toBe(-1);
  });
});

describe("focusReturnTarget", () => {
  const live = { id: "tile-24", connected: true };
  const gone = { id: "tile-24", connected: false };
  const isConnected = (el: { connected: boolean }) => el.connected;

  it("returns focus to the element that opened the dialog", () => {
    expect(focusReturnTarget(live, isConnected, () => null)).toBe(live);
  });

  it("falls back when the opener has been re-rendered out of the document", () => {
    const replacement = { id: "tile-24", connected: true };
    expect(focusReturnTarget(gone, isConnected, () => replacement)).toBe(replacement);
  });

  it("falls back when nothing was focused at open", () => {
    const replacement = { id: "tile-24", connected: true };
    expect(focusReturnTarget(null, isConnected, () => replacement)).toBe(replacement);
    expect(focusReturnTarget(undefined, isConnected, () => replacement)).toBe(replacement);
  });

  it("gives up rather than focusing something arbitrary", () => {
    expect(focusReturnTarget(gone, isConnected, () => null)).toBeNull();
    expect(focusReturnTarget(gone, isConnected, () => undefined)).toBeNull();
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("skips the faces demoted to tabindex -1", () => {
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).not.toContain('[tabindex="-1"],');
  });

  it("skips disabled controls", () => {
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])");
  });
});
