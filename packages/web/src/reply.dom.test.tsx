import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, type FakeDom } from "./testdom.ts";
import { ThreadGroup, type ThreadEntry } from "./thread.tsx";

/**
 * Card #26: the mobile double-tap sheet's Reply row.
 *
 * This mounts the real `ThreadGroup` (and the real `ReactionSheet` it opens, portal and all)
 * against the fake DOM, the same environment `gesture.dom.test.tsx` uses for the gesture
 * itself. That file's own comment explains why interaction here goes through the React props
 * React stashes on each host node (an `__reactProps$…` expando) rather than a real dispatched
 * event: the fake DOM does not bubble, so a `.fire("click")` on a node no ancestor is listening
 * to reaches nothing. Reading the props object and calling the handler directly is the same
 * shortcut `gesture.dom.test.tsx` takes when it calls `useDoubleTapReact`'s returned handlers
 * by hand instead of dispatching a real pointer event.
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

/** The props object React stashed on a host node, or null for a plain (non-React) one. */
function reactProps(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : null;
}

/** The first descendant (node included) whose `class` attribute carries `cls` as one of its
 *  space-separated tokens. */
function findByClass(node: any, cls: string): any {
  if (node.nodeType === 1 && ((node.attrs?.class as string) ?? "").split(" ").includes(cls)) return node;
  for (const c of node.childNodes ?? []) {
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

/** Every text node's content under `node`, concatenated — `FakeNode.textContent` is always
 *  `""` (see testdom.ts), so reading a rendered label means walking down to the real text
 *  nodes React actually created. */
function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return (node.childNodes ?? []).map(textOf).join("");
}

interface Entry extends ThreadEntry { num: number }

const entry: Entry = {
  id: "m1",
  author: "rob",
  authorKind: "human",
  createdAt: new Date().toISOString(),
  body: "hello world",
  num: 5,
};

/** Mounts `ThreadGroup` over one bubble, opens its reaction sheet by driving the real
 *  double-tap gesture (two paired lifts on the bubble, exactly what a touch double tap
 *  produces), and hands back what a test needs to find inside the now-open sheet. */
function mountOpenSheet(onReply: (e: Entry) => void) {
  const root = createRoot(dom.container as unknown as Element);
  act(() => {
    root.render(
      <ThreadGroup<Entry>
        group={[entry]}
        mine={false}
        boardId="b1"
        doubleTapReact={{ canReact: (e) => e.num > 0, isMine: () => false, onPick: () => {} }}
        onReply={onReply}
      />,
    );
  });
  cleanup = () => act(() => root.unmount());

  const bubble = findByClass(dom.container, "bubble");
  if (!bubble) throw new Error("bubble not rendered");
  const tapEvent = { clientX: 10, clientY: 10, target: { closest: () => null } };
  const lift = () => {
    const p = reactProps(bubble);
    p.onPointerDown(tapEvent);
    p.onPointerUp(tapEvent);
  };
  act(() => { lift(); lift(); }); // two lifts inside the pairing window: one double tap

  return { bubble };
}

describe("the reaction sheet's Reply row (#26)", () => {
  it("renders a Reply row once the sheet is open", () => {
    mountOpenSheet(() => {});
    const row = findByClass(dom.document.body, "sheet-reply-row");
    expect(row).toBeTruthy();
    expect(textOf(row)).toBe("Reply");
  });

  it("tapping Reply hands back the entry and closes the sheet", () => {
    const replied: Entry[] = [];
    mountOpenSheet((e) => replied.push(e));
    const row = findByClass(dom.document.body, "sheet-reply-row");
    act(() => { reactProps(row).onClick(); });
    expect(replied).toEqual([entry]);
    // The sheet's own close transition kicks in the instant `onClose` runs.
    const backdrop = findByClass(dom.document.body, "sheet-backdrop");
    expect((backdrop.attrs.class as string)).toContain("closing");
  });

  it("Cancel clears the sheet without touching reply", () => {
    const replied: Entry[] = [];
    mountOpenSheet((e) => replied.push(e));
    const cancel = findByClass(dom.document.body, "sheet-cancel");
    act(() => { reactProps(cancel).onClick(); });
    expect(replied).toEqual([]);
    const backdrop = findByClass(dom.document.body, "sheet-backdrop");
    expect((backdrop.attrs.class as string)).toContain("closing");
  });

  it("renders no Reply row when the caller offers no onReply", () => {
    const root = createRoot(dom.container as unknown as Element);
    act(() => {
      root.render(
        <ThreadGroup<Entry>
          group={[entry]}
          mine={false}
          boardId="b1"
          doubleTapReact={{ canReact: (e) => e.num > 0, isMine: () => false, onPick: () => {} }}
        />,
      );
    });
    cleanup = () => act(() => root.unmount());
    const bubble = findByClass(dom.container, "bubble");
    const tapEvent = { clientX: 10, clientY: 10, target: { closest: () => null } };
    const lift = () => {
      const p = reactProps(bubble);
      p.onPointerDown(tapEvent);
      p.onPointerUp(tapEvent);
    };
    act(() => { lift(); lift(); });
    expect(findByClass(dom.document.body, "sheet-reply-row")).toBeNull();
    // The rest of the sheet still opened normally.
    expect(findByClass(dom.document.body, "reaction-sheet-row")).toBeTruthy();
  });
});
