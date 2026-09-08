import { describe, expect, it } from "bun:test";
import { dayLabel, GROUP_WINDOW_MS, groupMessages, splitByDay, threadChunks } from "./grouping.ts";

const at = (ms: number) => new Date(ms).toISOString();
const m = (author: string, ms: number) => ({ author, createdAt: at(ms) });

describe("groupMessages", () => {
  it("returns nothing for no messages", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("groups consecutive messages from the same actor inside the window", () => {
    const a = m("conductor", 0);
    const b = m("conductor", 60_000);
    expect(groupMessages([a, b])).toEqual([[a, b]]);
  });

  it("starts a new group when the actor changes", () => {
    const a = m("conductor", 0);
    const b = m("ada", 1_000);
    const c = m("conductor", 2_000);
    expect(groupMessages([a, b, c])).toEqual([[a], [b], [c]]);
  });

  it("starts a new group when the gap exceeds the window", () => {
    const a = m("conductor", 0);
    const b = m("conductor", GROUP_WINDOW_MS + 1);
    expect(groupMessages([a, b])).toEqual([[a], [b]]);
  });

  it("keeps a message exactly on the window boundary in the same group", () => {
    const a = m("conductor", 0);
    const b = m("conductor", GROUP_WINDOW_MS);
    expect(groupMessages([a, b])).toEqual([[a, b]]);
  });

  it("measures the gap message-to-message, not from the head of the run", () => {
    // Four minutes apart each: a run longer than the window, but never a pause inside it.
    const msgs = [0, 240_000, 480_000, 720_000].map((t) => m("conductor", t));
    expect(groupMessages(msgs)).toEqual([msgs]);
  });

  it("starts a new group on an unparseable or out-of-order timestamp", () => {
    const a = m("conductor", 1_000);
    const bad = { author: "conductor", createdAt: "not a date" };
    const back = m("conductor", 500);
    expect(groupMessages([a, bad])).toEqual([[a], [bad]]);
    expect(groupMessages([a, back])).toEqual([[a], [back]]);
  });

  it("honours a caller-supplied window", () => {
    const a = m("conductor", 0);
    const b = m("conductor", 2_000);
    expect(groupMessages([a, b], 1_000)).toEqual([[a], [b]]);
    expect(groupMessages([a, b], 5_000)).toEqual([[a, b]]);
  });
});

const c = (author: string, ms: number, kind = "comment") => ({ author, createdAt: at(ms), kind });

describe("threadChunks", () => {
  it("returns nothing for an empty thread", () => {
    expect(threadChunks([])).toEqual([]);
  });

  it("groups ordinary comments exactly as the channel groups messages", () => {
    const a = c("web-dev", 0);
    const b = c("web-dev", 1_000);
    expect(threadChunks([a, b])).toEqual([{ system: false, items: [a, b] }]);
  });

  it("gives a question, an answer and a resolution a row each", () => {
    const q = c("web-dev", 0, "question");
    const a = c("ada", 1_000, "answer");
    const r = c("web-dev", 2_000, "resolution");
    expect(threadChunks([q, a, r])).toEqual([
      { system: true, items: [q] },
      { system: true, items: [a] },
      { system: true, items: [r] },
    ]);
  });

  it("never lets a system entry join the run around it, same author or not", () => {
    const before = c("web-dev", 0);
    const res = c("web-dev", 1_000, "resolution");
    const after = c("web-dev", 2_000);
    expect(threadChunks([before, res, after])).toEqual([
      { system: false, items: [before] },
      { system: true, items: [res] },
      { system: false, items: [after] },
    ]);
  });

  it("starts a new run when the author changes", () => {
    const a = c("web-dev", 0);
    const b = c("ada", 1_000);
    expect(threadChunks([a, b])).toEqual([
      { system: false, items: [a] },
      { system: false, items: [b] },
    ]);
  });
});

describe("dayLabel", () => {
  // Built from local Date components (not a UTC-offset ISO string) so the boundary the last
  // test exercises lands on local midnight regardless of the machine's own time zone.
  const now = new Date(2026, 8, 8, 9, 0, 0);

  it("names today and yesterday", () => {
    expect(dayLabel(new Date(2026, 8, 8, 23, 0, 0).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 7, 23, 0, 0).toISOString(), now)).toBe("Yesterday");
  });

  it("names anything older by weekday and date", () => {
    const old = new Date(2026, 8, 5, 10, 0, 0);
    expect(dayLabel(old.toISOString(), now)).toBe(new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(old));
  });

  it("uses the calendar day, not a rolling 24-hour window", () => {
    // Four minutes apart, either side of local midnight: different calendar days.
    const midnight = new Date(2026, 8, 8, 0, 0, 0).getTime();
    expect(dayLabel(new Date(midnight - 2 * 60_000).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(midnight + 2 * 60_000).toISOString(), now)).toBe("Today");
  });
});

describe("splitByDay", () => {
  const now = new Date("2026-09-08T09:00:00.000Z");
  const e = (ms: string) => ({ createdAt: ms });

  it("returns nothing for no items", () => {
    expect(splitByDay([], now)).toEqual([]);
  });

  it("groups consecutive same-day items under one label without reordering", () => {
    const a = e("2026-09-07T10:00:00.000Z");
    const b = e("2026-09-07T11:00:00.000Z");
    const c = e("2026-09-08T08:00:00.000Z");
    expect(splitByDay([a, b, c], now)).toEqual([
      { label: "Yesterday", items: [a, b] },
      { label: "Today", items: [c] },
    ]);
  });
});
