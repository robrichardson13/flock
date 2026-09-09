import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, useLayoutEffect, type RefObject } from "react";
import { installDom, type FakeDom, type FakeNode } from "./testdom.ts";
import { useScrollRestore, useStickToBottom, type StickToBottomOptions } from "./live.ts";

/**
 * The DOM-level half of ADR 0013's scroll retention, and the tests card #3's first pass did
 * not have. Everything else about retention is pure and covered in `viewstate.test.ts`; what
 * lives only here is whether a real React mount and unmount actually restores and actually
 * writes.
 *
 * That distinction is not academic. The first pass wrote the channel/activity exit-writer as a
 * passive `useEffect`, and React 18 defers a deleted subtree's passive destroys until after the
 * mutation phase has already run `ref.current = null` — so the write early-returned and no
 * channel or activity offset was ever saved on unmount, with all 760 tests green. Every test in
 * the first two describes below fails if that effect goes back to being passive.
 *
 * `./testdom.ts` says why the DOM here is hand-written rather than happy-dom's.
 */

let dom: FakeDom;
let createRoot: typeof import("react-dom/client").createRoot;

/** `react-dom` decides at import time whether it has a DOM, so it is loaded after one exists. */
beforeAll(async () => {
  dom = installDom();
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(() => dom.uninstall());

/** A pane's scroll geometry, as the browser would report it once content has laid out. */
interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop?: number;
}

interface Mounted<A> {
  /** The scroll container React created — a `FakeNode`, so a test can set its geometry. */
  el: FakeNode;
  /** The hook's return value, refreshed on every render. */
  api: A;
  /** Give the pane a size, and (optionally) put the reader somewhere in it. */
  lay(g: Geometry): void;
  /** Move the reader by hand: assigns `scrollTop` and fires the `scroll` the browser would. */
  scrollTo(y: number): void;
  render(): void;
  unmount(): void;
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

/**
 * Mount a component that drives one of the two scroll hooks onto a real React root, and hand
 * the test the container element plus the hook's live return value.
 */
function mountPane<A extends { ref: RefObject<HTMLDivElement> }>(hook: () => A): Mounted<A> {
  const box: { api: A | null } = { api: null };
  function Pane() {
    const api = hook();
    box.api = api;
    // The panes attach the hook's `onScroll` through React's own event system; the fake DOM has
    // no delegation, so the test's `scrollTo` fires the node's listeners directly and this
    // subscription is what makes the hook hear it.
    const onScroll = (api as { onScroll?: () => void }).onScroll;
    useLayoutEffect(() => {
      const el = api.ref.current as unknown as FakeNode | null;
      if (!el || !onScroll) return;
      el.addEventListener("scroll", onScroll);
      return () => el.removeEventListener("scroll", onScroll);
    }, [api.ref, onScroll]);
    return <div ref={api.ref} className="pane-scroll"><div className="row" /></div>;
  }

  const root = createRoot(dom.container as unknown as Element);
  const render = () => act(() => { root.render(<Pane />); });
  render();
  let live = true;
  const unmount = () => { if (live) { live = false; act(() => root.unmount()); } };
  cleanup = unmount;

  const el = dom.container.firstChild as FakeNode;
  return {
    el,
    get api() { return box.api as A; },
    lay(g) {
      el.scrollHeight = g.scrollHeight;
      el.clientHeight = g.clientHeight;
      if (g.scrollTop !== undefined) el.scrollTop = g.scrollTop;
    },
    scrollTo(y) {
      el.scrollTop = y;
      act(() => el.fire("scroll"));
    },
    render,
    unmount,
  };
}

/** A tall pane: 5000px of content in a 500px window, so the bottom is scrollTop 4500. */
const TALL = { scrollHeight: 5000, clientHeight: 500 };

describe("useStickToBottom writes its offset out (ADR 0013)", () => {
  it("writes {y, bottom:false} on unmount when the reader had scrolled up", () => {
    const written: Array<{ y: number; bottom: boolean }> = [];
    const pane = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], { onExit: (p) => written.push(p) }));
    pane.lay(TALL);
    pane.scrollTo(1200);

    pane.unmount();

    // A passive exit-writer sees `ref.current === null` here and writes nothing at all: this
    // assertion is the blocker's regression guard.
    expect(written).toEqual([{ y: 1200, bottom: false }]);
  });

  it("writes bottom:true for a reader still pinned to the bottom, so the pin wins on the way back", () => {
    const written: Array<{ y: number; bottom: boolean }> = [];
    const pane = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], { onExit: (p) => written.push(p) }));
    pane.lay(TALL);
    pane.scrollTo(4500);

    pane.unmount();

    expect(written).toEqual([{ y: 4500, bottom: true }]);
  });

  it("writes on pagehide and on the tab being backgrounded, without unmounting", () => {
    const written: Array<{ y: number; bottom: boolean }> = [];
    const pane = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], { onExit: (p) => written.push(p) }));
    pane.lay(TALL);
    pane.scrollTo(900);

    dom.fireWindow("pagehide");
    expect(written).toEqual([{ y: 900, bottom: false }]);

    dom.setVisibility("hidden");
    expect(written).toHaveLength(2);
    dom.setVisibility("visible");
    expect(written).toHaveLength(2); // becoming visible again is not an exit
  });

  it("does not write on scroll — only on the way out", () => {
    const written: Array<{ y: number; bottom: boolean }> = [];
    const pane = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], { onExit: (p) => written.push(p) }));
    pane.lay(TALL);
    pane.scrollTo(400);
    pane.scrollTo(800);
    expect(written).toEqual([]);
  });
});

describe("useScrollRestore writes its offset out (ADR 0013)", () => {
  it("writes the offset on unmount", () => {
    const written: number[] = [];
    const pane = mountPane(() => ({ ref: useScrollRestore<HTMLDivElement>(undefined, (y) => written.push(y)) }));
    pane.lay({ ...TALL, scrollTop: 2222 });

    pane.unmount();

    expect(written).toEqual([2222]);
  });

  it("writes on pagehide too", () => {
    const written: number[] = [];
    const pane = mountPane(() => ({ ref: useScrollRestore<HTMLDivElement>(undefined, (y) => written.push(y)) }));
    pane.lay({ ...TALL, scrollTop: 640 });
    dom.fireWindow("pagehide");
    expect(written).toEqual([640]);
  });
});

/**
 * The settling window. A pane mounts before its content has height — against the cached
 * `flock.snap` frame, or with images still sizing — so the clamped restore lands at 0 and has
 * to re-apply as the pane grows. Without the window this is a bare clamp that stays at 0,
 * which is exactly what the channel and activity restore was doing.
 */
describe("a clamped restore holds its offset while content settles", () => {
  const restore = (y: number, extra: StickToBottomOptions = {}) =>
    mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], { restoreTop: y, ...extra }));

  it("re-applies the remembered offset once the pane has grown under it (useStickToBottom)", () => {
    const pane = restore(1200);
    // Nothing to restore against yet: zero-height content clamps the offset to 0.
    expect(pane.el.scrollTop).toBe(0);

    pane.lay(TALL);
    act(() => dom.resize());

    expect(pane.el.scrollTop).toBe(1200);
  });

  it("re-applies it for the top-anchored panes too (useScrollRestore)", () => {
    const pane = mountPane(() => ({ ref: useScrollRestore<HTMLDivElement>(1500, () => {}) }));
    expect(pane.el.scrollTop).toBe(0);

    pane.lay(TALL);
    act(() => dom.resize());

    expect(pane.el.scrollTop).toBe(1500);
  });

  it("leaves the reader unstuck, so arrivals count into the pill instead of yanking them down", () => {
    const written: Array<{ y: number; bottom: boolean }> = [];
    const pane = restore(1200, { onExit: (p) => written.push(p) });
    pane.lay(TALL);
    act(() => dom.resize());

    pane.unmount();

    // bottom:false, and at the restored offset rather than pinned to 4500.
    expect(written).toEqual([{ y: 1200, bottom: false }]);
  });

  it("clamps to the new maximum when the content shrank below the remembered offset", () => {
    const pane = mountPane(() => ({ ref: useScrollRestore<HTMLDivElement>(5000, () => {}) }));
    pane.lay({ scrollHeight: 900, clientHeight: 500 });
    act(() => dom.resize());
    expect(pane.el.scrollTop).toBe(400);
  });

  it("clamps to 0 when the content now fits without scrolling", () => {
    const pane = mountPane(() => ({ ref: useScrollRestore<HTMLDivElement>(5000, () => {}) }));
    pane.lay({ scrollHeight: 300, clientHeight: 500 });
    act(() => dom.resize());
    expect(pane.el.scrollTop).toBe(0);
  });

  it("closes the window on a scroll the restore did not cause, and never yanks again", () => {
    // A remembered offset past the pane's maximum keeps the window open: the clamp can never
    // reach it, so only a reader scroll or the timeout closes it.
    const pane = restore(9000);
    pane.lay(TALL);
    act(() => dom.resize());
    expect(pane.el.scrollTop).toBe(4500);
    dom.flushFrames(); // the applying-flag frame; from here a scroll is the reader's

    pane.scrollTo(100);
    pane.el.scrollHeight = 20000;
    act(() => dom.resize());

    expect(pane.el.scrollTop).toBe(100);
  });
});

/**
 * The two halves joined up: a reader scrolls a channel, leaves the tab, and the offset is in
 * the store for the next mount to restore. This is the whole feature for a bottom-anchored
 * pane, and with a passive exit-writer it read back nothing.
 */
describe("a bottom-anchored pane round-trips its offset through the store", () => {
  it("remembers where a reader left the channel, and restores it on the way back", async () => {
    const map = new Map<string, string>();
    const storage = {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
    // A fresh module instance, matching viewstate.test.ts: the version sweep runs once per one.
    const { readScroll, rememberScroll } = await import(`./viewstate.ts?${Math.random()}`) as typeof import("./viewstate.ts");
    try {
      const first = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], {
        onExit: (pos) => rememberScroll("retain-tab", "channel", pos),
      }));
      first.lay(TALL);
      first.scrollTo(1800);
      first.unmount();

      expect(readScroll("retain-tab", "channel")).toEqual({ y: 1800, bottom: false });

      // Coming back: the remembered position is handed in as `restoreTop` exactly as
      // `BoardView`'s Channel does, and lands once the pane has height.
      const remembered = readScroll("retain-tab", "channel");
      const second = mountPane(() => useStickToBottom<HTMLDivElement>(["m1"], {
        restoreTop: remembered && !remembered.bottom ? remembered.y : null,
      }));
      second.lay(TALL);
      act(() => dom.resize());
      expect(second.el.scrollTop).toBe(1800);
      second.unmount();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
    }
  });
});
