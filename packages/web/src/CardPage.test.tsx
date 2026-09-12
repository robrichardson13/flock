import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import type { Comment, Reaction } from "./api.ts";
import { SystemEntry } from "./CardPage.tsx";
import { installDom, type FakeDom } from "./testdom.ts";

/**
 * Card 63: a question (`flock ask`) or a resolution (`flock done --resolution`) is still an
 * ordinary comment row underneath — core, the server, and `flock react` already treat every
 * `kind` alike — but the web thread rendered these through `SystemEntry`, a component that
 * never got the reaction chips or the double-tap sheet `ThreadGroup` bubbles get. These tests
 * mount the real `SystemEntry` against the fake DOM (see `reply.dom.test.tsx` for why: no real
 * event bubbling, so interaction goes through the React-stashed props on the host node) and
 * check both affordances actually render and wire back to the toggle callback.
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

function reactProps(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : null;
}

function findByClass(node: any, cls: string): any {
  if (node.nodeType === 1 && ((node.attrs?.class as string) ?? "").split(" ").includes(cls)) return node;
  for (const c of node.childNodes ?? []) {
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

const reactions = (emoji: string, actors: string[]): Reaction[] => [{ emoji, count: actors.length, actors }];

function question(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    cardId: "card1",
    cardNum: 63,
    author: "rob",
    authorKind: "human",
    kind: "question",
    num: 3,
    body: "which model?",
    createdAt: new Date().toISOString(),
    reactions: [],
    ...overrides,
  } as Comment;
}

function mount(comment: Comment, onToggleReaction: (c: Comment, emoji: string, mine: boolean) => void) {
  const root = createRoot(dom.container as unknown as Element);
  act(() => {
    root.render(<SystemEntry comment={comment} isNew={false} me="rob" onToggleReaction={onToggleReaction} />);
  });
  cleanup = () => act(() => root.unmount());
}

describe("SystemEntry reactions (card 63)", () => {
  it("renders reaction chips for a question, same as a comment bubble would", () => {
    mount(question({ reactions: reactions("👍", ["react-fixer"]) }), () => {});
    const chip = findByClass(dom.container, "reaction-chip");
    expect(chip).toBeTruthy();
  });

  it("renders reaction chips for a resolution", () => {
    mount(question({ kind: "resolution", reactions: reactions("🎉", ["react-fixer"]) }), () => {});
    expect(findByClass(dom.container, "reaction-chip")).toBeTruthy();
  });

  it("toggling a reaction chip calls back with the comment's own ref", () => {
    const toggled: Array<[number, string, boolean]> = [];
    mount(question({ num: 7, reactions: reactions("👍", ["rob"]) }), (c, emoji, mine) => toggled.push([c.num, emoji, mine]));
    const chip = findByClass(dom.container, "reaction-chip");
    act(() => { reactProps(chip).onClick(); });
    expect(toggled).toEqual([[7, "👍", true]]);
  });

  it("a double tap opens the reaction sheet, matching the comment bubble gesture", () => {
    mount(question(), () => {});
    const row = findByClass(dom.container, "thread-system");
    if (!row) throw new Error("thread-system row not rendered");
    const tapEvent = { clientX: 10, clientY: 10, target: { closest: () => null } };
    const lift = () => {
      const p = reactProps(row);
      p.onPointerDown(tapEvent);
      p.onPointerUp(tapEvent);
    };
    act(() => { lift(); lift(); });
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeTruthy();
    // The sheet-only Reply row never applies here (card 63 doesn't touch how asks are answered).
    expect(findByClass(dom.document.body, "sheet-reply-row")).toBeNull();
  });

  it("skips the double-tap gesture for an unconfirmed row (num <= 0)", () => {
    mount(question({ num: 0 }), () => {});
    const row = findByClass(dom.container, "thread-system");
    const tapEvent = { clientX: 10, clientY: 10, target: { closest: () => null } };
    const lift = () => {
      const p = reactProps(row);
      p.onPointerDown(tapEvent);
      p.onPointerUp(tapEvent);
    };
    act(() => { lift(); lift(); });
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeNull();
  });
});
