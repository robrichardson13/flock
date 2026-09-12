import { describe, expect, it } from "bun:test";
import type { Card } from "./api.ts";
import { filterCards, matchesQuery, searchMatchCount } from "./cardSearch.ts";

function card(over: Partial<Card> = {}): Card {
  return {
    id: over.id ?? "c1",
    boardId: "b1",
    num: over.num ?? 1,
    title: over.title ?? "Untitled",
    body: over.body ?? "",
    status: over.status ?? "todo",
    assignee: over.assignee ?? null,
    labels: over.labels ?? [],
    question: null,
    questionBy: null,
    position: 0,
    createdBy: "someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    blockedBy: [],
    blocked: false,
    heldAt: null,
    heldBy: null,
    holdReason: null,
    ...over,
  } as Card;
}

describe("matchesQuery", () => {
  it("matches an empty query against everything", () => {
    expect(matchesQuery(card(), "")).toBe(true);
    expect(matchesQuery(card(), "   ")).toBe(true);
  });

  it("matches a bare card number", () => {
    expect(matchesQuery(card({ num: 12 }), "12")).toBe(true);
    expect(matchesQuery(card({ num: 12 }), "13")).toBe(false);
  });

  it("matches a #-prefixed card number", () => {
    expect(matchesQuery(card({ num: 12 }), "#12")).toBe(true);
    expect(matchesQuery(card({ num: 5 }), "#12")).toBe(false);
  });

  it("still matches a number as a title/body substring", () => {
    expect(matchesQuery(card({ num: 99, title: "Track 12 issues" }), "12")).toBe(true);
  });

  it("matches a label, case-insensitively", () => {
    expect(matchesQuery(card({ labels: ["Card-Search"] }), "card-search")).toBe(true);
    expect(matchesQuery(card({ labels: ["other"] }), "card-search")).toBe(false);
  });

  it("matches the assignee", () => {
    expect(matchesQuery(card({ assignee: "search-builder" }), "search")).toBe(true);
    expect(matchesQuery(card({ assignee: null }), "search")).toBe(false);
  });

  it("matches the title case-insensitively", () => {
    expect(matchesQuery(card({ title: "Fix the Nav Bar" }), "nav bar")).toBe(true);
    expect(matchesQuery(card({ title: "FIX THE NAV BAR" }), "nav")).toBe(true);
  });

  it("matches the body", () => {
    expect(matchesQuery(card({ body: "reproduce on iOS" }), "ios")).toBe(true);
  });

  it("ANDs multiple words rather than ORing them", () => {
    const c = card({ title: "Search icon", body: "opens a composer", labels: ["card-search"] });
    expect(matchesQuery(c, "search composer")).toBe(true);
    expect(matchesQuery(c, "search missing")).toBe(false);
  });
});

describe("filterCards", () => {
  const cards = [
    card({ id: "a", num: 1, title: "Search icon" }),
    card({ id: "b", num: 2, title: "Unrelated", labels: ["bug"] }),
    card({ id: "c", num: 12, title: "Twelfth card" }),
  ];

  it("returns every card for an empty query", () => {
    expect(filterCards(cards, "")).toEqual(cards);
  });

  it("narrows to matching cards, preserving order", () => {
    expect(filterCards(cards, "search").map((c) => c.id)).toEqual(["a"]);
  });

  it("finds a card by number", () => {
    expect(filterCards(cards, "12").map((c) => c.id)).toEqual(["c"]);
    expect(filterCards(cards, "#12").map((c) => c.id)).toEqual(["c"]);
  });

  it("returns nothing when no card matches", () => {
    expect(filterCards(cards, "nonexistent-term")).toEqual([]);
  });
});

describe("searchMatchCount", () => {
  const cards = [card({ id: "a", title: "match" }), card({ id: "b", title: "no" }), card({ id: "c", title: "match too" })];

  it("counts matches against the total", () => {
    expect(searchMatchCount(cards, "match")).toEqual({ matched: 2, total: 3 });
  });

  it("counts everything as matched when the query is empty", () => {
    expect(searchMatchCount(cards, "")).toEqual({ matched: 3, total: 3 });
  });
});
