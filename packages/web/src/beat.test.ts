import { describe, expect, it } from "bun:test";
import { createBeatScheduler, GAP_FACTOR, gapMsSince, RESUME_DEDUPE_MS, RETRY_BACKOFF_MS, retryDelayMs, type BeatClock, type BeatContext } from "./beat.ts";

/** A fake clock and timer queue: nothing here sleeps, and `advance` is the only thing that moves. */
function fakeClock(start = 1_000_000) {
  let t = start;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: BeatClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: t + ms, fn });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
  };
  /** Move time forward, firing every timer due along the way. Bounded, so a self-rescheduling
   *  timer at zero delay can never hang the suite. */
  const advance = (ms: number) => {
    const target = t + ms;
    for (let i = 0; i < 1000; i++) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) {
        if (entry[1].at > target) continue;
        if (due === null || entry[1].at < due[1].at) due = entry;
      }
      if (due === null) break;
      timers.delete(due[0]);
      // Never backwards: a timer already overdue when a frozen clock resumes fires at *now*.
      t = Math.max(t, due[1].at);
      due[1].fn();
    }
    t = target;
  };
  /** Jump the clock without firing anything: exactly what iOS does to a frozen page. */
  const freeze = (ms: number) => {
    t += ms;
  };
  return { clock, advance, freeze, pending: () => timers.size, at: () => t };
}

const CADENCE = 15_000;

function harness(behaviour: (ctx: BeatContext) => Promise<void> | void = () => {}) {
  const f = fakeClock();
  const beats: BeatContext[] = [];
  const scheduler = createBeatScheduler({
    cadenceMs: CADENCE,
    clock: f.clock,
    beat: (ctx) => {
      beats.push(ctx);
      return behaviour(ctx);
    },
  });
  return { ...f, beats, scheduler };
}

describe("gapMsSince", () => {
  it("is null before the first tick and for an ordinary interval", () => {
    expect(gapMsSince(null, 1000, CADENCE)).toBeNull();
    expect(gapMsSince(0, CADENCE, CADENCE)).toBeNull();
    expect(gapMsSince(0, CADENCE * GAP_FACTOR - 1, CADENCE)).toBeNull();
  });

  it("reports the elapsed time once it reaches GAP_FACTOR cadences", () => {
    expect(gapMsSince(0, CADENCE * GAP_FACTOR, CADENCE)).toBe(CADENCE * GAP_FACTOR);
    expect(gapMsSince(1000, 81_000, CADENCE)).toBe(80_000);
  });

  it("is null for a clock that went backwards, rather than a negative gap", () => {
    expect(gapMsSince(10_000, 5_000, CADENCE)).toBeNull();
  });
});

describe("retryDelayMs", () => {
  it("walks the backoff table and then stops, so retries are bounded", () => {
    for (const [i, ms] of RETRY_BACKOFF_MS.entries()) expect(retryDelayMs(i)).toBe(ms);
    expect(retryDelayMs(RETRY_BACKOFF_MS.length)).toBeNull();
    expect(retryDelayMs(-1)).toBeNull();
  });
});

describe("createBeatScheduler", () => {
  it("beats on start and then once per cadence", () => {
    const h = harness();
    h.scheduler.start();
    expect(h.beats.map((b) => b.reason)).toEqual(["start"]);
    h.advance(CADENCE * 3);
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "tick", "tick", "tick"]);
    expect(h.beats.slice(1).every((b) => b.gapMs === null && !b.forced)).toBe(true);
    h.scheduler.stop();
  });

  it("stop ends the chain, and a resume after stop does nothing", () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.stop();
    h.advance(CADENCE * 5);
    h.scheduler.resume("visible");
    expect(h.beats).toHaveLength(1);
    expect(h.pending()).toBe(0);
  });

  it("a resume beats immediately, forced, and re-arms the chain from there", () => {
    const h = harness();
    h.scheduler.start();
    h.advance(CADENCE - 1_000);
    h.scheduler.resume("visible");
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "visible"]);
    expect(h.beats[1].forced).toBe(true);
    // The chain now runs a full cadence from the resume, not from the old tick.
    h.advance(CADENCE - 1);
    expect(h.beats).toHaveLength(2);
    h.advance(1);
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "visible", "tick"]);
    h.scheduler.stop();
  });

  it("dedupes the burst iOS fires on one resume (pageshow + focus + visible)", () => {
    const h = harness();
    h.scheduler.start();
    h.advance(CADENCE + RESUME_DEDUPE_MS);
    h.scheduler.resume("pageshow");
    h.scheduler.resume("focus");
    h.scheduler.resume("visible");
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "tick", "pageshow"]);
    h.scheduler.stop();
  });

  // The card 91 reproduction: the page is frozen mid-cadence, wakes long past the trust window,
  // and iOS never fires the event that would have told us. The next tick must still arrive and
  // must carry the gap.
  it("reports a gap when the timer was frozen past GAP_FACTOR cadences", () => {
    const h = harness();
    h.scheduler.start();
    h.freeze(80_000);
    h.advance(1);
    const late = h.beats.at(-1)!;
    expect(late.reason).toBe("tick");
    expect(late.gapMs).toBe(80_000);
    h.scheduler.stop();
  });

  it("reports the gap on a resume too, naming the signal that woke it", () => {
    const h = harness();
    h.scheduler.start();
    h.freeze(80_000);
    h.scheduler.resume("live-up");
    expect(h.beats.at(-1)).toMatchObject({ reason: "live-up", gapMs: 80_000, forced: true });
    h.scheduler.stop();
  });

  it("a failed beat retries on backoff and never ends the chain", async () => {
    let fail = true;
    const h = harness(() => (fail ? Promise.reject(new Error("offline")) : Promise.resolve()));
    h.scheduler.start();
    await Promise.resolve();
    h.advance(RETRY_BACKOFF_MS[0]);
    await Promise.resolve();
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "retry"]);
    fail = false;
    h.advance(RETRY_BACKOFF_MS[1]);
    await Promise.resolve();
    expect(h.beats.map((b) => b.reason)).toEqual(["start", "retry", "retry"]);
    // Recovered: the cadence carries on, with no retry left pending.
    h.advance(CADENCE * 2);
    expect(h.beats.filter((b) => b.reason === "tick").length).toBeGreaterThanOrEqual(1);
    h.scheduler.stop();
  });

  it("stops retrying past the backoff table but keeps beating on cadence", async () => {
    const h = harness(() => Promise.reject(new Error("offline")));
    h.scheduler.start();
    for (const ms of RETRY_BACKOFF_MS) {
      await Promise.resolve();
      h.advance(ms);
    }
    await Promise.resolve();
    const retries = h.beats.filter((b) => b.reason === "retry").length;
    expect(retries).toBe(RETRY_BACKOFF_MS.length);
    // Exhausted, but alive: the ordinary chain is still armed and still firing.
    const before = h.beats.length;
    h.advance(CADENCE * 2);
    expect(h.beats.length).toBeGreaterThan(before);
    h.scheduler.stop();
  });

  it("a beat that throws synchronously leaves the chain armed", () => {
    let boom = true;
    const h = harness(() => {
      if (boom) throw new Error("nope");
    });
    h.scheduler.start();
    boom = false;
    h.advance(CADENCE * 2);
    expect(h.beats.length).toBeGreaterThanOrEqual(3);
    h.scheduler.stop();
  });
});
