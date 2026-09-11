import { describe, expect, it } from "bun:test";
import { failPending, isDoubleTap, mergeThread, nextTempId, resolvePending, tapMoved, type PendingSend, type ThreadEntry } from "./thread.tsx";

/** A minimal `ThreadEntry` for the merge tests: only `id` and `body` matter to them. */
function entry(id: string, body = id): ThreadEntry {
  return { id, author: "rob", authorKind: "human", createdAt: "2026-09-08T00:00:00.000Z", body };
}

function send(tempId: string, entryOverride?: Partial<ThreadEntry>): PendingSend<ThreadEntry> {
  return {
    tempId,
    entry: { ...entry(tempId), ...entryOverride },
    sending: true,
    draftText: entryOverride?.body ?? tempId,
    draftAttachmentIds: [],
  };
}

describe("mergeThread", () => {
  it("appends a pending send after the fetched rows", () => {
    const fetched = [entry("a"), entry("b")];
    const pending = [send("optimistic-1")];
    expect(mergeThread(fetched, pending).map((e) => e.id)).toEqual(["a", "b", "optimistic-1"]);
  });

  it("drops a pending entry once its id shows up in the fetched list", () => {
    // The POST resolved and handed the entry its real id ("c"); a refetch has now brought
    // "c" back too. The overlay must not render it a second time.
    const fetched = [entry("a"), entry("b"), entry("c")];
    const pending = [send("optimistic-1", { id: "c" })];
    expect(mergeThread(fetched, pending).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a pending entry whose real id has not been confirmed by a refetch yet", () => {
    // resolvePending already swapped the temp id for the real one, but the fetched list is
    // still the last snapshot from before the send.
    const fetched = [entry("a"), entry("b")];
    const pending = [send("optimistic-1", { id: "real-9" })];
    expect(mergeThread(fetched, pending).map((e) => e.id)).toEqual(["a", "b", "real-9"]);
  });

  it("merges several pending sends in submission order, confirming independently", () => {
    const pending = [send("optimistic-1", { id: "real-1" }), send("optimistic-2")];
    // "real-1" already landed in a refetch; "optimistic-2" has not resolved at all yet.
    const withOneConfirmed = mergeThread([entry("a"), entry("real-1")], pending);
    expect(withOneConfirmed.map((e) => e.id)).toEqual(["a", "real-1", "optimistic-2"]);
  });

  it("is a no-op with nothing pending", () => {
    const fetched = [entry("a"), entry("b")];
    expect(mergeThread(fetched, [])).toEqual(fetched);
  });
});

describe("resolvePending", () => {
  it("swaps a pending entry's temp id and body for the server's real object", () => {
    const pending = [send("optimistic-1")];
    const real = entry("real-9", "confirmed body");
    const out = resolvePending(pending, "optimistic-1", real);
    expect(out).toEqual([{ ...pending[0], entry: real, sending: false }]);
  });

  it("leaves entries for other sends untouched", () => {
    const pending = [send("optimistic-1"), send("optimistic-2")];
    const out = resolvePending(pending, "optimistic-2", entry("real-2"));
    expect(out[0]).toEqual(pending[0]);
    expect(out[1].entry.id).toBe("real-2");
    expect(out[1].sending).toBe(false);
  });

  it("no-ops when the temp id is not present", () => {
    const pending = [send("optimistic-1")];
    expect(resolvePending(pending, "nope", entry("real-9"))).toEqual(pending);
  });
});

describe("failPending", () => {
  it("drops the failed send and leaves the rest", () => {
    const pending = [send("optimistic-1"), send("optimistic-2")];
    expect(failPending(pending, "optimistic-1")).toEqual([pending[1]]);
  });

  it("no-ops when the temp id is not present", () => {
    const pending = [send("optimistic-1")];
    expect(failPending(pending, "nope")).toEqual(pending);
  });
});

describe("nextTempId", () => {
  it("never repeats within a session", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextTempId()));
    expect(ids.size).toBe(50);
  });

  it("cannot collide with a real (short base36) id", () => {
    expect(nextTempId().startsWith("optimistic-")).toBe(true);
  });
});

/**
 * The double-tap gesture's thresholds (#6), unchanged by #1 — what the gesture *does* moved
 * from "toggle 👍" to "open the reaction sheet", but what counts as a double tap did not, and
 * these guard that the rework left the detection alone.
 */
describe("isDoubleTap", () => {
  const at = (x: number, y: number, t: number) => ({ x, y, t });

  it("is false with no previous tap to pair against", () => {
    expect(isDoubleTap(null, at(10, 10, 1000))).toBe(false);
  });

  it("pairs two quick taps in the same place", () => {
    expect(isDoubleTap(at(10, 10, 1000), at(12, 11, 1200))).toBe(true);
  });

  it("does not pair taps more than 300ms apart", () => {
    expect(isDoubleTap(at(10, 10, 1000), at(10, 10, 1301))).toBe(false);
    expect(isDoubleTap(at(10, 10, 1000), at(10, 10, 1300))).toBe(true);
  });

  it("does not pair taps further apart than a fingertip", () => {
    // 32px is the radius; (24, 24) is ~33.9 away, (20, 20) ~28.3.
    expect(isDoubleTap(at(0, 0, 1000), at(24, 24, 1100))).toBe(false);
    expect(isDoubleTap(at(0, 0, 1000), at(20, 20, 1100))).toBe(true);
  });
});

describe("tapMoved", () => {
  it("treats a lift with no recorded press as movement (nothing to measure against)", () => {
    expect(tapMoved(null, { x: 5, y: 5 })).toBe(true);
  });

  it("lets a still finger through", () => {
    expect(tapMoved({ x: 100, y: 100 }, { x: 104, y: 98 })).toBe(false);
  });

  it("rejects a scroll", () => {
    expect(tapMoved({ x: 100, y: 100 }, { x: 100, y: 180 })).toBe(true);
  });
});
