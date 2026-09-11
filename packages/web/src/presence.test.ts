import { describe, expect, it } from "bun:test";
import { HEARTBEAT_MS, IDLE_MS, isLooking, presenceStep, type PresenceState } from "./presence.ts";

describe("isLooking", () => {
  const t0 = 1_000_000;

  it("is true when visible, focused and touched recently", () => {
    expect(isLooking({ visible: true, focused: true, lastInputAt: t0, now: t0 + 1000 })).toBe(true);
  });

  it("is false when hidden, even if focused and freshly touched", () => {
    expect(isLooking({ visible: false, focused: true, lastInputAt: t0, now: t0 })).toBe(false);
  });

  it("is false when unfocused, even if visible and freshly touched", () => {
    expect(isLooking({ visible: true, focused: false, lastInputAt: t0, now: t0 })).toBe(false);
  });

  it("is true one ms below IDLE_MS and false exactly at IDLE_MS", () => {
    expect(isLooking({ visible: true, focused: true, lastInputAt: t0, now: t0 + IDLE_MS - 1 })).toBe(true);
    expect(isLooking({ visible: true, focused: true, lastInputAt: t0, now: t0 + IDLE_MS })).toBe(false);
  });
});

describe("presenceStep", () => {
  const t0 = 1_000_000;

  it("sends on the very first evaluation (no prior state)", () => {
    expect(presenceStep(null, { looking: true, board: "b" }, t0)).toBe("send");
    expect(presenceStep(null, { looking: false, board: null }, t0)).toBe("send");
  });

  it("sends when looking flips, even with the same board", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0 };
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + 1)).toBe("send");
  });

  it("sends when the board changes, even with looking unchanged", () => {
    const prev: PresenceState = { looking: true, board: "a", lastSentAt: t0 };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + 1)).toBe("send");
    expect(presenceStep(prev, { looking: true, board: null }, t0 + 1)).toBe("send");
  });

  it("stays quiet while looking and nothing has changed, before the heartbeat is due", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0 };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + HEARTBEAT_MS - 1)).toBe("none");
  });

  it("beats once HEARTBEAT_MS has elapsed since the last send, still looking", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0 };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + HEARTBEAT_MS)).toBe("beat");
  });

  it("never beats while not looking, no matter how much time passed", () => {
    const prev: PresenceState = { looking: false, board: "b", lastSentAt: t0 };
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + HEARTBEAT_MS * 10)).toBe("none");
  });
});
