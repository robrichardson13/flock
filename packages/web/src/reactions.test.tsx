import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { hasReaction, MessageReactions, REACTION_PALETTE, ReactionPalette, swallowNextClick, ThreadGroup } from "./thread.tsx";
import { FINE_POINTER_QUERY } from "./ui.tsx";
import type { Reaction } from "./api.ts";

/**
 * Card #1: on touch a double tap opens the reaction sheet instead of toggling 👍 on the spot,
 * and the dashed "🙂+" chip that used to sit permanently under every bubble on the phone is
 * desktop-only now.
 *
 * These render through `react-dom/server`, which runs the components for real (state
 * initialisers included) without needing a DOM — `useMedia` reads `window.matchMedia` in its
 * initialiser, so a stub below is what decides "touch" or "mouse" for a given render. The sheet
 * itself portals into `document.body` and so cannot be rendered this way; what is asserted here
 * is that it is *not* open at rest, and its contents are `ReactionPalette`, which is pure and
 * tested directly.
 */
const realWindow = (globalThis as { window?: unknown }).window;

/** `matches` for every query except the fine-pointer one, which answers `fine`. */
function stubPointer(fine: boolean) {
  const matchMedia = (query: string) => ({
    matches: query === FINE_POINTER_QUERY ? fine : false,
    addEventListener() {},
    removeEventListener() {},
  });
  (globalThis as { window?: unknown }).window = { ...(realWindow ?? {}), matchMedia };
}

afterEach(() => {
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
});

const reactions = (emoji: string, actors: string[]): Reaction[] => [{ emoji, count: actors.length, actors }];

describe("ReactionPalette", () => {
  it("offers exactly the one palette, in order", () => {
    const html = renderToStaticMarkup(<ReactionPalette isMine={() => false} onPick={() => {}} />);
    const found = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual([...REACTION_PALETTE]);
  });

  it("marks the emoji the viewer has already reacted with", () => {
    const html = renderToStaticMarkup(<ReactionPalette isMine={(e) => e === "🎉"} onPick={() => {}} />);
    expect(html).toContain('class="reaction-picker-item mine" aria-pressed="true" aria-label="🎉"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("wears the sheet's larger target only when asked", () => {
    expect(renderToStaticMarkup(<ReactionPalette size="lg" isMine={() => false} onPick={() => {}} />)).toContain("reaction-picker-item lg");
    expect(renderToStaticMarkup(<ReactionPalette isMine={() => false} onPick={() => {}} />)).not.toContain(" lg");
  });
});

describe("the add-reaction chip is desktop-only (#1)", () => {
  it("renders the dashed 🙂+ chip on a fine pointer", () => {
    stubPointer(true);
    const html = renderToStaticMarkup(<MessageReactions reactions={reactions("👍", ["rob"])} viewer="rob" onToggle={() => {}} />);
    expect(html).toContain("reaction-add");
    expect(html).toContain("reaction-chip");
  });

  it("renders no add chip on a coarse pointer, but keeps the existing reactions tappable", () => {
    stubPointer(false);
    const html = renderToStaticMarkup(<MessageReactions reactions={reactions("👍", ["rob"])} viewer="rob" onToggle={() => {}} />);
    expect(html).not.toContain("reaction-add");
    expect(html).toContain("reaction-chip");
    expect(html).toContain("👍");
  });

  it("renders nothing at all on touch when a bubble has no reactions yet", () => {
    stubPointer(false);
    expect(renderToStaticMarkup(<MessageReactions reactions={[]} viewer="rob" onToggle={() => {}} />)).toBe("");
  });

  it("still renders the row on desktop when a bubble has no reactions yet", () => {
    stubPointer(true);
    expect(renderToStaticMarkup(<MessageReactions reactions={[]} viewer="rob" onToggle={() => {}} />)).toContain("reaction-add");
  });
});

describe("a bubble at rest (#1)", () => {
  const group = [{
    id: "m1",
    num: 1,
    author: "agent",
    authorKind: "agent" as const,
    createdAt: new Date().toISOString(),
    body: "Card 3 done",
    reactions: [] as Reaction[],
  }];

  it("has no reaction sheet open and no 👍 flash — the old gesture's confirmation is gone", () => {
    stubPointer(false);
    const html = renderToStaticMarkup(
      <ThreadGroup
        group={group}
        mine={false}
        boardId="b1"
        doubleTapReact={{ canReact: (m) => m.num > 0, isMine: () => false, onPick: () => {} }}
      />,
    );
    expect(html).not.toContain("reaction-sheet-row");
    expect(html).not.toContain("dt-flash");
    expect(html).toContain("Card 3 done");
  });
});

describe("hasReaction", () => {
  it("is true only for the viewer's own emoji", () => {
    const rs = reactions("👍", ["rob", "builder"]);
    expect(hasReaction(rs, "rob", "👍")).toBe(true);
    expect(hasReaction(rs, "someone-else", "👍")).toBe(false);
    expect(hasReaction(rs, "rob", "🎉")).toBe(false);
    expect(hasReaction(rs, "", "👍")).toBe(false);
  });
});

/**
 * The trailing-click guard. A touch double tap is followed by the browser's compatibility
 * `click`, which without this lands on the backdrop the gesture just mounted and closes the
 * sheet on the frame it opened — the first pass through card #1 did exactly that under touch
 * emulation, with every unit test green, which is why this one exists.
 */
describe("swallowNextClick", () => {
  function fakeTarget() {
    const listeners: Array<(e: Event) => void> = [];
    return {
      listeners,
      addEventListener: (_t: "click", fn: (e: Event) => void) => void listeners.push(fn),
      removeEventListener: (_t: "click", fn: (e: Event) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
  }
  const fakeEvent = () => {
    let stopped = false;
    let prevented = false;
    return {
      ev: { stopPropagation: () => void (stopped = true), preventDefault: () => void (prevented = true) } as unknown as Event,
      stopped: () => stopped,
      prevented: () => prevented,
    };
  };

  it("stops the very next click and then stands down", () => {
    const target = fakeTarget();
    let timerFn: (() => void) | null = null;
    let cleared = 0;
    swallowNextClick(target, (fn) => { timerFn = fn; return 1; }, () => { cleared += 1; });
    expect(target.listeners).toHaveLength(1);
    const e = fakeEvent();
    target.listeners[0](e.ev);
    expect(e.stopped()).toBe(true);
    expect(e.prevented()).toBe(true);
    // Gone after one click, and its timeout cancelled with it.
    expect(target.listeners).toHaveLength(0);
    expect(cleared).toBe(1);
    expect(timerFn).not.toBeNull();
  });

  it("stands down on its own when no compatibility click ever arrives", () => {
    const target = fakeTarget();
    let timerFn: () => void = () => {};
    swallowNextClick(target, (fn) => { timerFn = fn; return 1; }, () => {});
    expect(target.listeners).toHaveLength(1);
    timerFn();
    // A later, genuine click must not be eaten.
    expect(target.listeners).toHaveLength(0);
  });

  it("hands back a stop the caller can run early", () => {
    const target = fakeTarget();
    const stop = swallowNextClick(target, () => 1, () => {});
    stop();
    expect(target.listeners).toHaveLength(0);
  });
});
