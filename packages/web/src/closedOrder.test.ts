import { describe, expect, it } from "bun:test";
import { closedOrder, type ClosedOrderable } from "./closedOrder.ts";

const card = (num: number, closedAt: string | null, updatedAt = closedAt ?? "2026-01-01T00:00:00.000Z"): ClosedOrderable => ({
  num,
  closedAt,
  updatedAt,
});

describe("closedOrder", () => {
  it("puts the most recently closed card first", () => {
    const cards = [card(1, "2026-01-01T00:00:00.000Z"), card(2, "2026-03-01T00:00:00.000Z"), card(3, "2026-02-01T00:00:00.000Z")];
    expect(closedOrder(cards).map((c) => c.num)).toEqual([2, 3, 1]);
  });

  it("falls back to updatedAt when closedAt is null", () => {
    const cards = [card(1, "2026-01-01T00:00:00.000Z"), card(2, null, "2026-05-01T00:00:00.000Z")];
    expect(closedOrder(cards).map((c) => c.num)).toEqual([2, 1]);
  });

  it("breaks ties on the same close time by num descending", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const cards = [card(3, same), card(1, same), card(2, same)];
    expect(closedOrder(cards).map((c) => c.num)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input array", () => {
    const cards = [card(1, "2026-01-01T00:00:00.000Z"), card(2, "2026-02-01T00:00:00.000Z")];
    const copy = [...cards];
    closedOrder(cards);
    expect(cards).toEqual(copy);
  });
});
