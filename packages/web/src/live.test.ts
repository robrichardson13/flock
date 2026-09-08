import { describe, expect, it } from "bun:test";
import type { CardStatus } from "./api.ts";
import {
  applyReplayFrame,
  enterDelay,
  enterOrders,
  flipDeltas,
  isSelfScroll,
  movedIds,
  nextBaseline,
  paneGrowth,
  planReplay,
  type ReplayEventLike,
  type ReplayFrame,
  replayChangedCards,
  replayEstimatedMs,
  replayIsOwnWritesOnly,
  REPLAY_MAX_ABSENCE_MS,
  REPLAY_MAX_CARDS,
  REPLAY_MAX_TOTAL_MS,
  shouldAnimateFlip,
  shouldRepin,
  STAGGER_CAP,
  STAGGER_MS,
} from "./live.ts";

/** A pane sitting exactly at the bottom: no growth pending. */
const AT_BOTTOM = { scrollTop: 920, scrollHeight: 1000, clientHeight: 80 };
/** A pane short of the bottom by well more than the 1px slop `shouldRepin` allows. */
const SHORT_OF_BOTTOM = { scrollTop: 600, scrollHeight: 1000, clientHeight: 80 };

describe("shouldRepin", () => {
  it("never repins when the reader is not stuck to the bottom", () => {
    expect(shouldRepin({ stuck: false, animating: false, ...SHORT_OF_BOTTOM })).toBe(false);
  });

  it("never repins while a smooth 'N new' scroll is animating, even if stuck and short", () => {
    expect(shouldRepin({ stuck: true, animating: true, ...SHORT_OF_BOTTOM })).toBe(false);
  });

  it("does nothing when already at the bottom", () => {
    expect(shouldRepin({ stuck: true, animating: false, ...AT_BOTTOM })).toBe(false);
  });

  it("tolerates a sub-pixel gap as being at the bottom", () => {
    expect(shouldRepin({ stuck: true, animating: false, scrollTop: 919.5, scrollHeight: 1000, clientHeight: 80 })).toBe(false);
  });

  it("repins when stuck, not animating, and short of the bottom", () => {
    expect(shouldRepin({ stuck: true, animating: false, ...SHORT_OF_BOTTOM })).toBe(true);
  });

  it("stuck-but-not-animating and not-stuck-but-animating both refuse to repin", () => {
    expect(shouldRepin({ stuck: false, animating: true, ...SHORT_OF_BOTTOM })).toBe(false);
  });
});

describe("shouldAnimateFlip", () => {
  it("never animates on a hidden tab, even with moves pending", () => {
    expect(shouldAnimateFlip({ enabled: true, reduced: false, hidden: true, moveCount: 3 })).toBe(false);
  });

  it("never animates when reduced motion is requested", () => {
    expect(shouldAnimateFlip({ enabled: true, reduced: true, hidden: false, moveCount: 3 })).toBe(false);
  });

  it("never animates when the caller disabled it", () => {
    expect(shouldAnimateFlip({ enabled: false, reduced: false, hidden: false, moveCount: 3 })).toBe(false);
  });

  it("never animates when nothing moved", () => {
    expect(shouldAnimateFlip({ enabled: true, reduced: false, hidden: false, moveCount: 0 })).toBe(false);
  });

  it("animates when enabled, visible, motion is not reduced, and something moved", () => {
    expect(shouldAnimateFlip({ enabled: true, reduced: false, hidden: false, moveCount: 1 })).toBe(true);
  });
});

describe("enterOrders", () => {
  it("numbers only the new ids, in the order the list renders them", () => {
    const orders = enterOrders(["a", "b", "c", "d"], new Set(["b", "d"]));
    expect([...orders]).toEqual([["b", 0], ["d", 1]]);
  });

  it("gives nothing to a list with nothing new in it", () => {
    expect(enterOrders(["a", "b"], new Set()).size).toBe(0);
  });
});

describe("enterDelay", () => {
  it("lets the first arrival go without waiting", () => {
    expect(enterDelay(0)).toBeUndefined();
    expect(enterDelay(undefined)).toBeUndefined();
  });

  it("spaces the rest 30ms apart", () => {
    expect(enterDelay(1)).toEqual({ animationDelay: `${STAGGER_MS}ms` });
    expect(enterDelay(3)).toEqual({ animationDelay: `${3 * STAGGER_MS}ms` });
  });

  it("caps the queue so a burst of thirty does not take a second to land", () => {
    const last = { animationDelay: `${(STAGGER_CAP - 1) * STAGGER_MS}ms` };
    expect(enterDelay(STAGGER_CAP - 1)).toEqual(last);
    expect(enterDelay(30)).toEqual(last);
  });
});

describe("isSelfScroll", () => {
  it("recognises the echo of a pin we performed", () => {
    expect(isSelfScroll({ expected: 5867, scrollTop: 5867 })).toBe(true);
  });

  it("does not claim a scroll when no pin is outstanding", () => {
    expect(isSelfScroll({ expected: -1, scrollTop: -1 })).toBe(false);
    expect(isSelfScroll({ expected: -1, scrollTop: 0 })).toBe(false);
  });

  it("treats a move away from the pinned position as the reader's", () => {
    expect(isSelfScroll({ expected: 5867, scrollTop: 5200 })).toBe(false);
  });

  it("still recognises the echo after content grew underneath it", () => {
    // The regression: the pane pinned at 5867, a "Show more" toggle appeared and added
    // 168px, and the pin's own scroll event arrived afterwards reading a 168px distance.
    // It is still our scroll, so `stuck` must survive and let the re-pin happen.
    expect(isSelfScroll({ expected: 5867, scrollTop: 5867 })).toBe(true);
  });
});

describe("paneGrowth", () => {
  it("lights nothing on the first commit, even with real counts already in hand", () => {
    // A cold snapshot's own message/event counts must not read as growth (#17 B11): there
    // was no "previous" for them to have grown past.
    expect(paneGrowth({ channel: 12, activity: 40 }, "channel", null, new Set())).toEqual(new Set());
  });

  it("lights the pane you are not on when it grows", () => {
    const prev = { channel: 12, activity: 40 };
    const grew = paneGrowth({ channel: 12, activity: 41 }, "channel", prev, new Set());
    expect(grew).toEqual(new Set(["activity"]));
  });

  it("never lights the pane currently showing, even if its own count grew", () => {
    const prev = { channel: 12, activity: 40 };
    const grew = paneGrowth({ channel: 13, activity: 40 }, "channel", prev, new Set());
    expect(grew).toEqual(new Set());
  });

  it("clears the moment the reader switches to the pane that grew", () => {
    const already = new Set<"channel" | "activity">(["activity"]);
    const grew = paneGrowth({ channel: 12, activity: 41 }, "activity", { channel: 12, activity: 41 }, already);
    expect(grew).toEqual(new Set());
  });

  it("keeps a pane lit across a render where nothing changed further", () => {
    const already = new Set<"channel" | "activity">(["activity"]);
    const grew = paneGrowth({ channel: 12, activity: 41 }, "channel", { channel: 12, activity: 41 }, already);
    expect(grew).toEqual(new Set(["activity"]));
  });
});

/**
 * #9: the phone Cards pane unmounts on a tab switch (it's keyed on `tab`), but `useNewIds` /
 * `useMovedIds` / `useFlip` — which drive its animations — do not unmount with it (they live
 * in `BoardView`, above the pane). Left alone, that produces a stale, timing-dependent
 * half-replay on return: the design note at scratchpad/flock/8.md §1 catches `useFlip` flying
 * a net move from wherever the pane last measured, with `useNewIds`/`useMovedIds`'s windows
 * having already burned out from ticking while unmounted. `nextBaseline` and `flipDeltas` are
 * the pure decisions the hooks build on to make a remount deterministic: no diff at all,
 * regardless of how long the surface was away.
 */
describe("nextBaseline (#9 remount rule)", () => {
  it("keeps the running baseline when resetKey has not changed", () => {
    const seen = new Set(["a", "b"]);
    expect(nextBaseline(seen, true, "cards", "cards", () => new Set(["a", "b", "c"]))).toBe(seen);
  });

  it("snaps to the current commit when resetKey changes and the data is ready", () => {
    const seen = new Set(["a", "b"]);
    const result = nextBaseline(seen, true, "cards", "away", () => new Set(["a", "b", "c"]));
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("stays un-baselined on a resetKey change while the data is not ready yet", () => {
    const seen = new Set(["a", "b"]);
    expect(nextBaseline(seen, false, "cards", "away", () => new Set(["a", "b", "c"]))).toBeNull();
  });

  it("treats the very first render (an unset lastReset) as a reset too", () => {
    const unset = Symbol("unset");
    const result = nextBaseline<Set<string>>(null, true, "cards", unset, () => new Set(["a"]));
    expect(result).toEqual(new Set(["a"]));
  });
});

describe("nextBaseline + movedIds together: a remount shows no stale tint", () => {
  it("a card that moved while the pane was unmounted does not tint on return", () => {
    // The pane last saw the card in "todo"; while it was unmounted it moved to "doing".
    // On the render that remounts the pane, resetKey flips from "away" to "cards".
    const seenBeforeUnmount = new Map([["c1", "todo"]]);
    const nowAfterRemount = new Map([["c1", "doing"]]);
    const base = nextBaseline(seenBeforeUnmount, true, "cards", "away", () => nowAfterRemount);
    expect([...movedIds(base, nowAfterRemount)]).toEqual([]);
  });

  it("without the reset, the same stale baseline would (wrongly) tint it", () => {
    const seenBeforeUnmount = new Map([["c1", "todo"]]);
    const nowAfterRemount = new Map([["c1", "doing"]]);
    expect([...movedIds(seenBeforeUnmount, nowAfterRemount)]).toEqual(["c1"]);
  });

  it("a live move while mounted continuously still tints, unaffected by the rule", () => {
    const seen = new Map([["c1", "todo"]]);
    const next = new Map([["c1", "doing"]]);
    const base = nextBaseline(seen, true, "cards", "cards", () => next);
    expect([...movedIds(base, next)]).toEqual(["c1"]);
  });
});

describe("flipDeltas (#9 remount rule)", () => {
  const prev = new Map([["c1", { x: 0, y: 0 }]]);
  const now = new Map([["c1", { x: 0, y: 120 }]]);

  it("computes a delta for an id present in both frames when not remounted", () => {
    expect(flipDeltas(prev, now, false)).toEqual([{ id: "c1", dx: 0, dy: -120 }]);
  });

  it("suppresses the diff entirely on a remount, however different the positions", () => {
    expect(flipDeltas(prev, now, true)).toEqual([]);
  });

  it("has nothing to diff against on the very first mount (`prev` is null)", () => {
    expect(flipDeltas(null, now, false)).toEqual([]);
  });

  it("ignores an id that only appeared or only disappeared, not moved", () => {
    const arrived = new Map([["c1", { x: 0, y: 0 }], ["c2", { x: 10, y: 10 }]]);
    expect(flipDeltas(prev, arrived, false)).toEqual([]);
  });

  it("treats sub-pixel drift as not having moved", () => {
    const drifted = new Map([["c1", { x: 0.4, y: 0 }]]);
    expect(flipDeltas(prev, drifted, false)).toEqual([]);
  });
});

/**
 * #10: the minimal "while you were away" replay (scratchpad/flock/8.md §8). `replayChangedCards`
 * diffs two placement frames — never the event log — so an intermediate status while the reader
 * was away is never reconstructed; `planReplay` is every gate in one place; `applyReplayFrame`
 * is the substitution that lets the existing FLIP/tint/enter hooks do all the animating.
 */
function placementMap(entries: [string, CardStatus][]): Map<string, CardStatus> {
  return new Map(entries);
}

describe("replayChangedCards", () => {
  it("finds a card whose status differs between the two frames", () => {
    const before = placementMap([["c1", "todo"]]);
    const after = placementMap([["c1", "doing"]]);
    expect([...replayChangedCards(before, after)]).toEqual(["c1"]);
  });

  it("coalesces an absence spanning several moves into one changed card", () => {
    // The frame the pane last painted only ever has the starting status; whatever happened
    // to the card in between while it was away is not in either frame, and does not need to
    // be — this is the whole point of diffing frames instead of the event log.
    const before = placementMap([["c1", "todo"]]);
    const after = placementMap([["c1", "done"]]);
    expect([...replayChangedCards(before, after)]).toEqual(["c1"]);
  });

  it("counts a card missing from the before frame as changed (created while away)", () => {
    const before = placementMap([]);
    const after = placementMap([["c1", "todo"]]);
    expect([...replayChangedCards(before, after)]).toEqual(["c1"]);
  });

  it("does not count a card that disappeared from the live snapshot", () => {
    const before = placementMap([["c1", "todo"]]);
    const after = placementMap([]);
    expect([...replayChangedCards(before, after)]).toEqual([]);
  });

  it("finds nothing when every status agrees", () => {
    const before = placementMap([["c1", "todo"], ["c2", "doing"]]);
    const after = placementMap([["c1", "todo"], ["c2", "doing"]]);
    expect([...replayChangedCards(before, after)]).toEqual([]);
  });
});

describe("replayIsOwnWritesOnly", () => {
  it("is true when every placement event since the watermark is the reader's own", () => {
    const events: ReplayEventLike[] = [{ seq: 11, type: "card.moved", actor: "rob" }, { seq: 12, type: "card.claimed", actor: "rob" }];
    expect(replayIsOwnWritesOnly(events, 10, "rob")).toBe(true);
  });

  it("is false the moment one relevant event belongs to someone else", () => {
    const events: ReplayEventLike[] = [{ seq: 11, type: "card.moved", actor: "rob" }, { seq: 12, type: "card.moved", actor: "agent-x" }];
    expect(replayIsOwnWritesOnly(events, 10, "rob")).toBe(false);
  });

  it("is false when there is nothing relevant at all — no events is not 'own writes only'", () => {
    expect(replayIsOwnWritesOnly([], 10, "rob")).toBe(false);
    const onlyComments: ReplayEventLike[] = [{ seq: 11, type: "comment.posted", actor: "rob" }];
    expect(replayIsOwnWritesOnly(onlyComments, 10, "rob")).toBe(false);
  });

  it("ignores events at or before the watermark", () => {
    const events: ReplayEventLike[] = [{ seq: 10, type: "card.moved", actor: "agent-x" }, { seq: 11, type: "card.moved", actor: "rob" }];
    expect(replayIsOwnWritesOnly(events, 10, "rob")).toBe(true);
  });

  it("ignores non-placement event types even from someone else", () => {
    const events: ReplayEventLike[] = [{ seq: 11, type: "card.moved", actor: "rob" }, { seq: 12, type: "message.posted", actor: "agent-x" }];
    expect(replayIsOwnWritesOnly(events, 10, "rob")).toBe(true);
  });
});

describe("replayEstimatedMs", () => {
  it("costs nothing for zero changed cards", () => {
    expect(replayEstimatedMs(0)).toBe(0);
  });

  it("grows with the count, staying under the 1.2s cap up to the 3-card limit", () => {
    const one = replayEstimatedMs(1);
    const three = replayEstimatedMs(REPLAY_MAX_CARDS);
    expect(three).toBeGreaterThan(one);
    expect(three).toBeLessThanOrEqual(REPLAY_MAX_TOTAL_MS);
  });
});

function frame(at: number, placements: Record<string, CardStatus>, seq = 100, backgrounded = false): ReplayFrame {
  return { seq, at, placements: new Map(Object.entries(placements) as [string, CardStatus][]), backgrounded };
}

describe("planReplay gates", () => {
  const NOW = 1_000_000;
  const base = { after: placementMap([["c1", "doing"]]), now: NOW, reduced: false, events: [] as ReplayEventLike[], actorName: "rob" };

  it("does nothing on a first load — no saved frame", () => {
    expect(planReplay({ ...base, before: null })).toEqual({ kind: "none" });
  });

  it("does nothing under reduced motion, even with a real change and no other gate tripped", () => {
    const before = frame(NOW - 1000, { c1: "todo" });
    expect(planReplay({ ...base, before, reduced: true })).toEqual({ kind: "none" });
  });

  it("does nothing when the absence was a backgrounding, not a tab switch", () => {
    const before = frame(NOW - 1000, { c1: "todo" }, 100, true);
    expect(planReplay({ ...base, before })).toEqual({ kind: "none" });
  });

  it("does nothing after more than 5 minutes away", () => {
    const before = frame(NOW - (REPLAY_MAX_ABSENCE_MS + 1), { c1: "todo" });
    expect(planReplay({ ...base, before })).toEqual({ kind: "none" });
  });

  it("replays right at the 5-minute boundary", () => {
    const before = frame(NOW - REPLAY_MAX_ABSENCE_MS, { c1: "todo" });
    expect(planReplay({ ...base, before }).kind).toBe("beat");
  });

  it("does nothing when nothing changed", () => {
    const before = frame(NOW - 1000, { c1: "doing" });
    expect(planReplay({ ...base, before })).toEqual({ kind: "none" });
  });

  it("does nothing when the only placement events since leaving are the reader's own", () => {
    const before = frame(NOW - 1000, { c1: "todo" }, 100);
    const events: ReplayEventLike[] = [{ seq: 101, type: "card.moved", actor: "rob" }];
    expect(planReplay({ ...base, before, events })).toEqual({ kind: "none" });
  });

  it("replays when a change coincides with someone else's write too", () => {
    const before = frame(NOW - 1000, { c1: "todo" }, 100);
    const events: ReplayEventLike[] = [{ seq: 101, type: "card.moved", actor: "agent-x" }];
    expect(planReplay({ ...base, before, events }).kind).toBe("beat");
  });

  it("plans a beat for 1-3 changed cards", () => {
    const before = frame(NOW - 1000, { c1: "todo", c2: "todo", c3: "todo" });
    const after = placementMap([["c1", "doing"], ["c2", "doing"], ["c3", "done"]]);
    const plan = planReplay({ ...base, before, after });
    expect(plan.kind).toBe("beat");
    if (plan.kind === "beat") expect(plan.ids).toEqual(new Set(["c1", "c2", "c3"]));
  });

  it("compresses to a tint, no motion, past the card-count cap", () => {
    const before = frame(NOW - 1000, { c1: "todo", c2: "todo", c3: "todo", c4: "todo" });
    const after = placementMap([["c1", "doing"], ["c2", "doing"], ["c3", "done"], ["c4", "done"]]);
    const plan = planReplay({ ...base, before, after });
    expect(plan.kind).toBe("tint");
    if (plan.kind === "tint") expect(plan.ids.size).toBe(4);
  });

  it("returns the pre-absence placements on a beat, for the caller to substitute", () => {
    const before = frame(NOW - 1000, { c1: "todo" });
    const plan = planReplay({ ...base, before });
    expect(plan.kind).toBe("beat");
    if (plan.kind === "beat") expect([...plan.before]).toEqual([["c1", "todo"]]);
  });
});

describe("applyReplayFrame", () => {
  const cards: { id: string; status: CardStatus }[] = [{ id: "c1", status: "doing" }, { id: "c2", status: "done" }];

  it("returns the cards unchanged when there is no active frame", () => {
    expect(applyReplayFrame(cards, null)).toBe(cards);
  });

  it("wears the frame's old status for a card that changed", () => {
    const overrideFrame = placementMap([["c1", "todo"], ["c2", "done"]]);
    const out = applyReplayFrame(cards, overrideFrame);
    expect(out).toEqual([{ id: "c1", status: "todo" }, { id: "c2", status: "done" }]);
  });

  it("drops a card the frame never saw — it plays its own arrival once the beat swaps", () => {
    const overrideFrame = placementMap([["c1", "todo"]]);
    const out = applyReplayFrame(cards, overrideFrame);
    expect(out.map((c) => c.id)).toEqual(["c1"]);
  });

  it("leaves an unchanged card's object identity alone", () => {
    const overrideFrame = placementMap([["c1", "doing"], ["c2", "done"]]);
    const out = applyReplayFrame(cards, overrideFrame);
    expect(out[0]).toBe(cards[0]);
    expect(out[1]).toBe(cards[1]);
  });
});
