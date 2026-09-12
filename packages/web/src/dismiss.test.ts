import { describe, expect, it } from "bun:test";
import { createDismissGate, DISMISS_DEDUPE_MS, installForegroundDismiss, shouldDismiss } from "./dismiss.ts";

describe("shouldDismiss", () => {
  it("always runs the first time", () => {
    expect(shouldDismiss(null, 0)).toBe(true);
    expect(shouldDismiss(null, 1_000_000)).toBe(true);
  });

  it("suppresses a second signal inside the window", () => {
    expect(shouldDismiss(1_000, 1_000)).toBe(false);
    expect(shouldDismiss(1_000, 1_000 + DISMISS_DEDUPE_MS - 1)).toBe(false);
  });

  it("runs again once the window has elapsed", () => {
    expect(shouldDismiss(1_000, 1_000 + DISMISS_DEDUPE_MS)).toBe(true);
    expect(shouldDismiss(1_000, 99_000)).toBe(true);
  });

  it("does not lock shut when the clock goes backwards", () => {
    expect(shouldDismiss(5_000, 1_000)).toBe(true);
  });
});

describe("createDismissGate", () => {
  it("opens once per window, however many times it is asked", () => {
    let now = 0;
    const gate = createDismissGate(DISMISS_DEDUPE_MS, () => now);
    expect(gate()).toBe(true);
    expect(gate()).toBe(false);
    expect(gate()).toBe(false);
    now += DISMISS_DEDUPE_MS - 1;
    expect(gate()).toBe(false);
    now += 1;
    expect(gate()).toBe(true);
    expect(gate()).toBe(false);
  });

  it("measures the window from the last run, not the last attempt", () => {
    let now = 0;
    const gate = createDismissGate(1_000, () => now);
    expect(gate()).toBe(true);
    now = 900;
    expect(gate()).toBe(false); // an attempt, not a run
    now = 1_000;
    expect(gate()).toBe(true); // 1000ms after the run, not after the attempt
  });
});

/** The two event targets `installForegroundDismiss` touches, with a way to fire at them. */
function fakeTargets(visibility: DocumentVisibilityState = "visible") {
  const listeners: Record<string, Array<() => void>> = {};
  const add = (type: string, fn: EventListenerOrEventListenerObject) => {
    (listeners[type] ??= []).push(fn as () => void);
  };
  const remove = (type: string, fn: EventListenerOrEventListenerObject) => {
    listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
  };
  const target = { addEventListener: add, removeEventListener: remove };
  return {
    listeners,
    fire: (type: string) => { for (const f of [...(listeners[type] ?? [])]) f(); },
    count: (type: string) => (listeners[type] ?? []).length,
    targets: {
      doc: { ...target, visibilityState: visibility } as never,
      win: target as never,
    },
  };
}

describe("installForegroundDismiss", () => {
  it("sweeps immediately when the page is already visible on mount (the cold-launch case)", () => {
    let runs = 0;
    const f = fakeTargets("visible");
    installForegroundDismiss(() => runs++, f.targets, () => true);
    expect(runs).toBe(1);
  });

  it("does not sweep on mount when the page is hidden", () => {
    let runs = 0;
    const f = fakeTargets("hidden");
    installForegroundDismiss(() => runs++, f.targets, () => true);
    expect(runs).toBe(0);
  });

  it("sweeps on pageshow and on focus, and on visibilitychange only when visible", () => {
    let runs = 0;
    const f = fakeTargets("hidden");
    installForegroundDismiss(() => runs++, f.targets, () => true);
    f.fire("visibilitychange");
    expect(runs).toBe(0); // still hidden
    f.fire("pageshow");
    expect(runs).toBe(1);
    f.fire("focus");
    expect(runs).toBe(2);
    (f.targets.doc as unknown as { visibilityState: string }).visibilityState = "visible";
    f.fire("visibilitychange");
    expect(runs).toBe(3);
  });

  it("collapses one resume that fires all three signals into a single sweep", () => {
    let runs = 0;
    let now = 0;
    const f = fakeTargets("hidden");
    installForegroundDismiss(() => runs++, f.targets, createDismissGate(DISMISS_DEDUPE_MS, () => now));
    (f.targets.doc as unknown as { visibilityState: string }).visibilityState = "visible";
    f.fire("pageshow");
    f.fire("visibilitychange");
    f.fire("focus");
    expect(runs).toBe(1);
    now += DISMISS_DEDUPE_MS;
    f.fire("focus"); // a genuinely later foregrounding
    expect(runs).toBe(2);
  });

  it("never lets a throwing sweep escape into the event listener", () => {
    const f = fakeTargets("hidden");
    installForegroundDismiss(() => { throw new Error("boom"); }, f.targets, () => true);
    expect(() => f.fire("focus")).not.toThrow();
  });

  it("removes every listener it added on teardown", () => {
    const f = fakeTargets("hidden");
    const off = installForegroundDismiss(() => {}, f.targets, () => true);
    expect(f.count("visibilitychange") + f.count("pageshow") + f.count("focus")).toBe(3);
    off();
    expect(f.count("visibilitychange") + f.count("pageshow") + f.count("focus")).toBe(0);
  });
});

describe("installForegroundDismiss names the signal that woke it", () => {
  it("labels the mount, the visibility change, the pageshow and the focus differently", () => {
    const seen: string[] = [];
    const f = fakeTargets("visible");
    installForegroundDismiss((reason) => seen.push(reason), f.targets, () => true);
    f.fire("visibilitychange");
    f.fire("pageshow");
    f.fire("focus");
    expect(seen).toEqual(["mount", "visible", "pageshow", "focus"]);
  });
});
