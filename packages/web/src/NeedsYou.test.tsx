import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import type { Card } from "./api.ts";
import { NeedsYou } from "./NeedsYou.tsx";
import { installDom, type FakeDom } from "./testdom.ts";

/**
 * Card 76: the ask panel (the "Needs you"/"Waiting on you" box — a card with a pending
 * question, an answer field, and the Answer button) gets the same double-tap-to-react gesture
 * every comment already has (card 63). Reacting there answers the question (core's rule, tested
 * in `packages/core/test/comment-reactions.test.ts`); this only checks the web wiring: a double
 * tap on the panel opens the reaction sheet, and a double tap that starts on the input or the
 * button does not — it must reach the field/button normally instead.
 */
let dom: FakeDom;
let createRoot: typeof import("react-dom/client").createRoot;

beforeAll(async () => {
  dom = installDom();
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(() => dom.uninstall());

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

function findByClass(node: any, cls: string): any {
  if (node.nodeType === 1 && ((node.attrs?.class as string) ?? "").split(" ").includes(cls)) return node;
  for (const c of node.childNodes ?? []) {
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

function findByTag(node: any, tag: string): any {
  if (node.nodeType === 1 && node.nodeName?.toLowerCase() === tag) return node;
  for (const c of node.childNodes ?? []) {
    const found = findByTag(c, tag);
    if (found) return found;
  }
  return null;
}

function reactProps(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : null;
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "card1",
    boardId: "board1",
    num: 12,
    title: "Ship it",
    body: "",
    status: "awaiting-human",
    assignee: "builder",
    labels: [],
    question: "ship it?",
    questionBy: "builder",
    questionCommentNum: 3,
    questionReactions: [],
    position: 1,
    createdBy: "builder",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    blockedBy: [],
    blocked: false,
    heldAt: null,
    heldBy: null,
    holdReason: null,
    held: false,
    ...overrides,
  } as Card;
}

function mount(c: Card) {
  const root = createRoot(dom.container as unknown as Element);
  act(() => {
    root.render(<NeedsYou boardId={c.boardId} card={c} boardSlug="flock" />);
  });
  cleanup = () => act(() => root.unmount());
  return root;
}

function tapAt(node: any, event: { clientX: number; clientY: number; target: unknown }) {
  const p = reactProps(node);
  p.onPointerDown(event);
  p.onPointerUp(event);
}

describe("NeedsYou ask panel double-tap-to-react (card 76)", () => {
  it("a double tap on the panel opens the reaction sheet", () => {
    mount(card());
    const row = findByClass(dom.container, "needs-item");
    if (!row) throw new Error("needs-item row not rendered");
    const event = { clientX: 10, clientY: 10, target: { closest: () => null } };
    act(() => { tapAt(row, event); tapAt(row, event); });
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeTruthy();
  });

  it("a double tap that starts on the answer input does not open the sheet", () => {
    mount(card());
    const row = findByClass(dom.container, "needs-item");
    const input = findByTag(dom.container, "input");
    if (!row || !input) throw new Error("row or input not rendered");
    const event = { clientX: 10, clientY: 10, target: { closest: (sel: string) => (sel.includes("input") ? input : null) } };
    act(() => { tapAt(row, event); tapAt(row, event); });
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeNull();
  });

  it("a double tap that starts on the Answer button does not open the sheet", () => {
    mount(card());
    const row = findByClass(dom.container, "needs-item");
    const button = findByTag(dom.container, "button");
    if (!row || !button) throw new Error("row or button not rendered");
    const event = { clientX: 10, clientY: 10, target: { closest: (sel: string) => (sel.includes("button") ? button : null) } };
    act(() => { tapAt(row, event); tapAt(row, event); });
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeNull();
  });

  it("renders no reaction chips or gesture target when the card carries no pending question comment", () => {
    mount(card({ questionCommentNum: null, questionReactions: [] }));
    const row = findByClass(dom.container, "needs-item");
    expect(reactProps(row).onPointerDown).toBeUndefined();
  });

  it("renders reaction chips already on the pending question", () => {
    mount(card({ questionReactions: [{ emoji: "👍", count: 1, actors: ["rob"] }] }));
    expect(findByClass(dom.container, "reaction-chip")).toBeTruthy();
  });
});
