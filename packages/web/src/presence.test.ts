import { describe, expect, it } from "bun:test";
import { clientIsLooking, foregroundOnlyDevice, HEARTBEAT_MS, IDLE_MS, presenceStep, type PresenceState } from "./presence.ts";

describe("clientIsLooking, as the web wires it", () => {
  const t0 = 1_000_000;
  const desktop = { visible: true, focused: true, lastInputAt: t0, now: t0 + 1000, foregroundOnly: false };

  it("is true when visible, focused and touched recently", () => {
    expect(clientIsLooking(desktop)).toBe(true);
  });

  it("is false when hidden, even if focused and freshly touched", () => {
    expect(clientIsLooking({ ...desktop, visible: false })).toBe(false);
  });

  it("is false when unfocused on a desktop, but true on a phone (card 20)", () => {
    expect(clientIsLooking({ ...desktop, focused: false })).toBe(false);
    expect(clientIsLooking({ ...desktop, focused: false, foregroundOnly: true })).toBe(true);
  });

  it("is true one ms below IDLE_MS and false exactly at IDLE_MS, on a desktop only", () => {
    expect(clientIsLooking({ ...desktop, now: t0 + IDLE_MS - 1 })).toBe(true);
    expect(clientIsLooking({ ...desktop, now: t0 + IDLE_MS })).toBe(false);
    expect(clientIsLooking({ ...desktop, now: t0 + IDLE_MS, foregroundOnly: true })).toBe(true);
  });
});

describe("foregroundOnlyDevice", () => {
  // No DOM in this suite (see *.dom.test.tsx for those); the guard and the query are exercised
  // against a stub global, which is exactly the surface the function touches.
  const withWindow = <T,>(win: unknown, fn: () => T): T => {
    const had = "window" in globalThis;
    const saved = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      return fn();
    } finally {
      if (had) (globalThis as { window?: unknown }).window = saved;
      else delete (globalThis as { window?: unknown }).window;
    }
  };
  const stub = (matches: boolean) => ({ matchMedia: (media: string) => ({ matches, media }) });

  it("is false where window or matchMedia is missing, rather than throwing", () => {
    expect(withWindow(undefined, foregroundOnlyDevice)).toBe(false);
    expect(withWindow({}, foregroundOnlyDevice)).toBe(false);
  });

  it("follows the touch-primary media query", () => {
    expect(withWindow(stub(true), foregroundOnlyDevice)).toBe(true);
    expect(withWindow(stub(false), foregroundOnlyDevice)).toBe(false);
  });
});

describe("presenceStep", () => {
  const t0 = 1_000_000;

  it("sends on the very first evaluation (no prior state)", () => {
    expect(presenceStep(null, { looking: true, board: "b" }, t0)).toBe("send");
    expect(presenceStep(null, { looking: false, board: null }, t0)).toBe("send");
  });

  it("sends when looking flips, even with the same board", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0, failed: false };
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + 1)).toBe("send");
  });

  it("sends when the board changes, even with looking unchanged", () => {
    const prev: PresenceState = { looking: true, board: "a", lastSentAt: t0, failed: false };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + 1)).toBe("send");
    expect(presenceStep(prev, { looking: true, board: null }, t0 + 1)).toBe("send");
  });

  it("stays quiet while looking and nothing has changed, before the heartbeat is due", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0, failed: false };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + HEARTBEAT_MS - 1)).toBe("none");
  });

  it("beats once HEARTBEAT_MS has elapsed since the last send, still looking", () => {
    const prev: PresenceState = { looking: true, board: "b", lastSentAt: t0, failed: false };
    expect(presenceStep(prev, { looking: true, board: "b" }, t0 + HEARTBEAT_MS)).toBe("beat");
  });

  it("never beats while not looking, no matter how much time passed", () => {
    const prev: PresenceState = { looking: false, board: "b", lastSentAt: t0, failed: false };
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + HEARTBEAT_MS * 10)).toBe("none");
  });
});

describe("presenceStep retries a failed report", () => {
  const t0 = 1_000_000;

  it("beats again after a failed leave, which would otherwise never be retried", () => {
    const prev: PresenceState = { looking: false, board: "b", lastSentAt: t0, failed: true };
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + HEARTBEAT_MS - 1)).toBe("none");
    expect(presenceStep(prev, { looking: false, board: "b" }, t0 + HEARTBEAT_MS)).toBe("beat");
  });
});
