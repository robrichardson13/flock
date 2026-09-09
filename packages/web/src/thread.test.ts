import { describe, expect, it } from "bun:test";
import { failPending, measuredLineCount, mergeThread, nextTempId, resolvePending, type PendingSend, type ThreadEntry } from "./thread.tsx";

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

describe("measuredLineCount", () => {
  // #6: the `+N` hidden-line hint's pure core — see thread.tsx's LineComposer, which pairs
  // this with a DOM measurement (scrollHeight, computed padding/line-height) that happy-dom
  // cannot produce, so only the arithmetic is unit-tested here.
  it("counts one line for a field exactly one line-height plus its padding tall", () => {
    expect(measuredLineCount(48, 24, 24)).toBe(1);
  });

  it("counts multiple lines for a taller field", () => {
    expect(measuredLineCount(24 * 4 + 24, 24, 24)).toBe(4);
  });

  it("rounds rather than floors, so a sub-pixel-short measurement still counts the line it clearly holds", () => {
    expect(measuredLineCount(24 * 3 + 24 - 1, 24, 24)).toBe(3);
  });

  it("never reports fewer than one line, however short the measurement", () => {
    expect(measuredLineCount(0, 24, 24)).toBe(1);
    expect(measuredLineCount(10, 24, 24)).toBe(1);
  });

  it("falls back to one line rather than dividing by zero if line-height cannot be read", () => {
    expect(measuredLineCount(200, 24, 0)).toBe(1);
  });
});
