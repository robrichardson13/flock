import { describe, expect, test } from "bun:test";
import {
  SETTLED_MAX_KEYS,
  SETTLED_THRESHOLD_MAX_MS,
  SETTLED_THRESHOLD_MIN_MS,
  SettledTracker,
  type Event,
  type SettledIsLooking,
  type ThresholdFor,
} from "../src/index.ts";

const BOARD = "b1";

function ev(partial: Partial<Event>): Event {
  return {
    seq: 1,
    boardId: BOARD,
    actor: "ada",
    actorKind: "human",
    type: "message.posted",
    cardNum: null,
    data: {},
    createdAt: "2026-09-11T00:00:00.000Z",
    ...partial,
  };
}

/** A stub `isLooking` driven by a Set of "actor|board" strings. */
function stubLooking(initiallyLooking: string[] = []): { isLooking: SettledIsLooking; set: Set<string> } {
  const key = (a: string, b: string) => `${a}|${b}`;
  const set = new Set(initiallyLooking);
  const isLooking: SettledIsLooking = (actor, boardId) => set.has(key(actor, boardId));
  return { isLooking, set };
}

/** A stub clock advanced explicitly by the test, matching what `SettledTracker` is built against. */
function stubClock(start = 0): { clock: () => number; now: number; advance: (ms: number) => void } {
  const state = { now: start };
  return {
    clock: () => state.now,
    get now() {
      return state.now;
    },
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

function fixedThreshold(ms: number): ThresholdFor {
  return () => ms;
}

const TEN_MIN = 10 * 60_000;

describe("SettledTracker", () => {
  test("arms on someone else's post, fires once the quiet period elapses", () => {
    const { isLooking } = stubLooking();
    const clock = stubClock(0);
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: clock.clock });

    tracker.onEvent(ev({ actor: "scout", boardId: BOARD }), ["rob"]);

    expect(tracker.tick(TEN_MIN - 1)).toEqual([]);
    const fires = tracker.tick(TEN_MIN);
    expect(fires).toEqual([{ actor: "rob", boardId: BOARD, quietMs: TEN_MIN }]);
  });

  test("fires once per quiet period; a further tick with no new activity fires nothing again", () => {
    const { isLooking } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);
    expect(tracker.tick(TEN_MIN).length).toBe(1);
    expect(tracker.tick(TEN_MIN + 60_000)).toEqual([]);
    expect(tracker.tick(TEN_MIN * 100)).toEqual([]);
  });

  test("re-arms only on new activity: another post after firing lets it fire again", () => {
    const { isLooking } = stubLooking();
    const clock = stubClock(0);
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: clock.clock });

    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);
    expect(tracker.tick(TEN_MIN).length).toBe(1);

    // No new event: stays quiet, does not fire again.
    expect(tracker.tick(TEN_MIN + TEN_MIN)).toEqual([]);

    // New activity re-arms the clock for this key, from wherever the clock is now.
    clock.advance(2 * TEN_MIN);
    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);
    expect(tracker.tick(2 * TEN_MIN + TEN_MIN - 1)).toEqual([]);
    expect(tracker.tick(2 * TEN_MIN + TEN_MIN)).toEqual([{ actor: "rob", boardId: BOARD, quietMs: TEN_MIN }]);
  });

  test("self-posts do not arm: the recipient's own event on their own key is not a board going quiet on them", () => {
    const { isLooking } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0 });

    tracker.onEvent(ev({ actor: "rob" }), ["rob", "scout"]);

    // rob authored it, so rob's key never armed.
    expect(tracker.tick(TEN_MIN)).toEqual([{ actor: "scout", boardId: BOARD, quietMs: TEN_MIN }]);
  });

  test("suppressed while looking: deferred, not dropped, and fires once they look away", () => {
    const { isLooking, set } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);

    set.add("rob|b1");
    expect(tracker.tick(TEN_MIN)).toEqual([]);
    expect(tracker.tick(TEN_MIN * 5)).toEqual([]);

    set.delete("rob|b1");
    // Still quiet since the original arm — fires as soon as they look away, without a new event.
    const fires = tracker.tick(TEN_MIN * 5 + 1);
    expect(fires).toEqual([{ actor: "rob", boardId: BOARD, quietMs: TEN_MIN * 5 + 1 }]);
  });

  test("threshold is clamped below the minimum", () => {
    const { isLooking } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(1000), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);

    expect(tracker.tick(1000)).toEqual([]);
    expect(tracker.tick(SETTLED_THRESHOLD_MIN_MS - 1)).toEqual([]);
    expect(tracker.tick(SETTLED_THRESHOLD_MIN_MS)).toEqual([
      { actor: "rob", boardId: BOARD, quietMs: SETTLED_THRESHOLD_MIN_MS },
    ]);
  });

  test("threshold is clamped above the maximum", () => {
    const { isLooking } = stubLooking();
    const huge = SETTLED_THRESHOLD_MAX_MS * 10;
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(huge), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout" }), ["rob"]);

    expect(tracker.tick(SETTLED_THRESHOLD_MAX_MS - 1)).toEqual([]);
    expect(tracker.tick(SETTLED_THRESHOLD_MAX_MS)).toEqual([
      { actor: "rob", boardId: BOARD, quietMs: SETTLED_THRESHOLD_MAX_MS },
    ]);
  });

  test("evicts the oldest-armed key once past the 200-key cap", () => {
    const { isLooking } = stubLooking();
    const clock = stubClock(0);
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: clock.clock });

    for (let i = 0; i < SETTLED_MAX_KEYS; i++) {
      tracker.onEvent(ev({ actor: "scout", boardId: `board-${i}` }), ["rob"]);
      clock.advance(1);
    }
    expect(tracker.size()).toBe(SETTLED_MAX_KEYS);

    // One more key pushes past the cap: the oldest-armed (board-0) is evicted.
    tracker.onEvent(ev({ actor: "scout", boardId: "board-new" }), ["rob"]);
    expect(tracker.size()).toBe(SETTLED_MAX_KEYS);

    // board-0's key is gone: at the time it would have fired, nothing does.
    const fires = tracker.tick(TEN_MIN + SETTLED_MAX_KEYS);
    const boards = fires.map((f) => f.boardId);
    expect(boards).not.toContain("board-0");
    expect(boards).toContain("board-new");
    expect(boards).toContain(`board-${SETTLED_MAX_KEYS - 1}`);
  });

  test("respects a custom maxKeys", () => {
    const { isLooking } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0, maxKeys: 2 });

    tracker.onEvent(ev({ actor: "scout", boardId: "b1" }), ["rob"]);
    tracker.onEvent(ev({ actor: "scout", boardId: "b2" }), ["rob"]);
    tracker.onEvent(ev({ actor: "scout", boardId: "b3" }), ["rob"]);

    expect(tracker.size()).toBe(2);
  });

  test("independent per (actor, board): one recipient looking does not suppress another", () => {
    const { isLooking, set } = stubLooking(["rob|b1"]);
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout", boardId: BOARD }), ["rob", "ada"]);

    const fires = tracker.tick(TEN_MIN);
    expect(fires).toEqual([{ actor: "ada", boardId: BOARD, quietMs: TEN_MIN }]);
    set.delete("rob|b1");
  });

  test("multiple recipients on the same board get independent quiet clocks", () => {
    const { isLooking } = stubLooking();
    const clock = stubClock(0);
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: clock.clock });

    tracker.onEvent(ev({ actor: "scout", boardId: BOARD, seq: 1 }), ["rob"]);
    // ada's key arms 5 minutes later, from a different event.
    clock.advance(5 * 60_000);
    tracker.onEvent(ev({ actor: "scout", boardId: BOARD, seq: 2 }), ["ada"]);

    const fires = tracker.tick(TEN_MIN);
    expect(fires).toEqual([{ actor: "rob", boardId: BOARD, quietMs: TEN_MIN }]);
    // ada's key needs 5 more minutes to reach its own threshold.
    expect(tracker.tick(TEN_MIN + 5 * 60_000 - 1)).toEqual([]);
    expect(tracker.tick(TEN_MIN + 5 * 60_000)).toEqual([{ actor: "ada", boardId: BOARD, quietMs: TEN_MIN }]);
  });

  test("no recipients means no key created", () => {
    const { isLooking } = stubLooking();
    const tracker = new SettledTracker({ isLooking, thresholdFor: fixedThreshold(TEN_MIN), clock: () => 0 });

    tracker.onEvent(ev({ actor: "scout" }), []);
    expect(tracker.size()).toBe(0);
    expect(tracker.tick(TEN_MIN)).toEqual([]);
  });
});
