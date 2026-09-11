import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, type FakeDom } from "./testdom.ts";
import { useDoubleTapReact } from "./thread.tsx";

/**
 * Card #3: the trailing-click guard must arm only when the double tap actually opened
 * something.
 *
 * `swallowNextClick` puts a capture-phase click listener on `window`, ahead of everything else
 * on the page. Card #1 armed it the instant a double tap was recognised, before `ThreadGroup`'s
 * `canReact` gate had said whether a sheet would open at all — so double-tapping an optimistic
 * bubble (num 0, still in flight) armed a global guard with nothing on screen to explain it.
 * Usually harmless, because the gesture's own compatibility click consumes it; on a browser
 * that sends no such click it is a 400ms window in which an unrelated tap is silently eaten.
 *
 * The hook needs React's own render and a `window` to register on, so this mounts for real
 * against `testdom.ts` and calls the handlers it hands back directly — the fake DOM has no
 * event delegation, and the point here is the hook's decision, not the browser's dispatch.
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

type Handlers = { onPointerDown: (e: never) => void; onPointerUp: (e: never) => void };
interface Entry { id: string; num: number }

/** Count the capture-phase click guards `swallowNextClick` puts up, and let a test take them
 *  down again so one case never leaks into the next. */
function watchClickGuards() {
  const real = globalThis.addEventListener;
  const armed: Array<(e: Event) => void> = [];
  (globalThis as { addEventListener: unknown }).addEventListener = (type: string, fn: (e: Event) => void, opts?: unknown) => {
    if (type === "click") armed.push(fn);
    return (real as (t: string, f: (e: Event) => void, o?: unknown) => void)(type, fn, opts);
  };
  return {
    get count() { return armed.length; },
    /** Put `addEventListener` back and let every guard this case armed fire once, which is how
     *  a guard takes itself (and its fallback timer) down — otherwise a timer outlives the fake
     *  DOM and fires into an uninstalled `window` during some later test file. */
    restore() {
      (globalThis as { addEventListener: unknown }).addEventListener = real;
      for (const fn of armed.splice(0)) fn({ stopPropagation() {}, preventDefault() {} } as unknown as Event);
    },
  };
}

/** Mount a bubble driving the real hook and hand back its per-entry handlers, plus a double
 *  tap that plays two lifts in the same place inside the pairing window. */
function mountGesture(onDoubleTap: (entry: Entry) => boolean) {
  const box: { handlers: ((entry: Entry) => Handlers) | null } = { handlers: null };
  function Bubble() {
    box.handlers = useDoubleTapReact<Entry>(onDoubleTap);
    return <div className="msg bubble" />;
  }
  const root = createRoot(dom.container as unknown as Element);
  act(() => { root.render(<Bubble />); });
  cleanup = () => act(() => root.unmount());
  const tap = (entry: Entry) => {
    const h = box.handlers!(entry);
    // `target.closest` is what the hook uses to ignore taps that started on a button or a link;
    // a plain bubble body answers null.
    const e = { clientX: 100, clientY: 100, target: { closest: () => null } } as never;
    h.onPointerDown(e);
    h.onPointerUp(e);
  };
  return { tap, doubleTap: (entry: Entry) => { tap(entry); tap(entry); } };
}

describe("the trailing-click guard arms only when the tap opened something (#3)", () => {
  it("arms after a double tap the caller acted on", () => {
    const seen: Entry[] = [];
    const { doubleTap } = mountGesture((entry) => { seen.push(entry); return true; });
    const guards = watchClickGuards();
    try {
      doubleTap({ id: "m1", num: 1 });
      expect(seen).toHaveLength(1);
      expect(guards.count).toBe(1);
    } finally {
      guards.restore();
    }
  });

  it("arms nothing when the caller declines — an optimistic bubble with no number yet", () => {
    const seen: Entry[] = [];
    // What `ThreadGroup` does for `canReact(entry) === false`: no sheet opens, nothing is shown.
    const { doubleTap } = mountGesture((entry) => { seen.push(entry); return false; });
    const guards = watchClickGuards();
    try {
      doubleTap({ id: "optimistic-1", num: 0 });
      // The gesture was still recognised and the caller still heard about it...
      expect(seen).toHaveLength(1);
      // ...but with no overlay mounted there is no stray click to guard against.
      expect(guards.count).toBe(0);
    } finally {
      guards.restore();
    }
  });

  it("arms nothing for a lone tap, which is not the gesture at all", () => {
    const seen: Entry[] = [];
    const { tap } = mountGesture((entry) => { seen.push(entry); return true; });
    const guards = watchClickGuards();
    try {
      tap({ id: "m1", num: 1 });
      expect(seen).toHaveLength(0);
      expect(guards.count).toBe(0);
    } finally {
      guards.restore();
    }
  });
});
