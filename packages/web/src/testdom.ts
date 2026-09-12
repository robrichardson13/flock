/**
 * A DOM small enough to hand-write, and real enough to run React 18's own commit phases.
 *
 * Test-only: nothing in the app imports this, so it never reaches a bundle. It exists because
 * `packages/web` has no DOM test environment — `happy-dom` and `jsdom` are not dependencies of
 * this repo or of the web package (checked before writing this; neither is installed), and
 * adding one was not asked for. What the scroll-retention hooks need is small: a tree React can
 * mutate, a scrollable element whose `scrollTop`/`scrollHeight`/`clientHeight` a test can set,
 * `ResizeObserver`, `requestAnimationFrame`, and `pagehide`/`visibilitychange`. That is roughly
 * a hundred lines, and it buys the one thing a pure test cannot reach: React's *phase ordering*.
 *
 * That ordering is the whole point. React 18 runs a deleted subtree's layout destroys during the
 * mutation phase, before it detaches host refs, and defers its passive destroys until after the
 * mutation phase has already set `ref.current = null`. So an exit-writer that reads `ref.current`
 * writes the offset from a layout cleanup and writes nothing at all from a passive one — a
 * difference no amount of pure testing can see, and the one that made card #3's first pass ship a
 * feature that never saved a channel or activity offset while 760 tests passed.
 *
 * If a real DOM environment (happy-dom, jsdom) is ever added to this package, this file is the
 * thing to delete; `live.dom.test.tsx` should keep working against the real one unchanged.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (ev: any) => void;

/** `el.style.setProperty`/`removeProperty` — the two calls `TopBar.tsx` makes to publish its
 *  measured height as a CSS custom property. Properties also read/write as plain keys
 *  (`style.color = ...`), same as a real `CSSStyleDeclaration`. */
class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string) { this[name] = value; }
  removeProperty(name: string) { delete this[name]; }
  getPropertyValue(name: string) { return (this[name] as string) ?? ""; }
}

/** A node with the surface React's host config and these hooks actually touch. */
export class FakeNode {
  nodeType = 1;
  nodeName: string;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: any[] = [];
  parentNode: any = null;
  ownerDocument: any;
  attrs: Record<string, string> = {};
  style: FakeStyle = new FakeStyle();
  /** `el.classList.add/remove` — backed by the same `class` attribute `className` reads and
   *  React itself writes, so either form of toggling a class shows up to the other. Only the
   *  handful of methods anything in this package actually calls. */
  get classList() {
    const read = () => (this.attrs.class ?? "").split(/\s+/).filter(Boolean);
    const write = (tokens: string[]) => { this.attrs.class = tokens.join(" "); };
    return {
      add: (...tokens: string[]) => write([...new Set([...read(), ...tokens])]),
      remove: (...tokens: string[]) => write(read().filter((t) => !tokens.includes(t))),
      contains: (token: string) => read().includes(token),
      toggle: (token: string, force?: boolean) => {
        const has = read().includes(token);
        const want = force ?? !has;
        if (want) write([...new Set([...read(), token])]);
        else write(read().filter((t) => t !== token));
        return want;
      },
    };
  }
  /** `el.dataset.foo = ...` / `delete el.dataset.foo` — a plain object is enough; nothing here
   *  reads it back through `getAttribute("data-foo")`. */
  dataset: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  /** Scroll geometry is inert here: a test sets it to describe the pane it wants. */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  constructor(name: string, doc: any) {
    this.nodeName = name.toUpperCase();
    this.ownerDocument = doc;
  }

  get tagName() { return this.nodeName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : -1;
    return i < 0 ? null : this.parentNode.childNodes[i + 1] ?? null;
  }
  get children() { return this.childNodes.filter((c: any) => c.nodeType === 1); }
  get isConnected() {
    let n: any = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  /** React's `shouldSetTextContent` fast path: a host element whose only child is a string
   *  gets that string written here directly rather than a separate Text child — exactly what
   *  `<span>Reply</span>` compiles to. A real `textContent` setter replaces every child with
   *  one text node, which is enough for a test to find the label the same way it would find
   *  any other text: walking `childNodes` for a `nodeType === 3`. */
  get textContent() {
    return this.childNodes.map((c: any) => (c.nodeType === 3 ? (c.nodeValue ?? "") : c.textContent ?? "")).join("");
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v) this.childNodes.push({ nodeType: 3, nodeValue: v, parentNode: this, ownerDocument: this.ownerDocument });
  }

  appendChild(c: any) {
    c.parentNode?.removeChild?.(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c: any, ref: any) {
    c.parentNode?.removeChild?.(c);
    c.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c: any) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  /** A zeroed rect: geometry here is inert, same as scroll geometry above — a test that cares
   *  about a real measurement sets it up itself; nothing does yet. */
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  addEventListener(t: string, f: Listener) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t: string, f: Listener) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); }
  /** Fire an event at this node only; no bubbling, which none of these hooks rely on. */
  fire(type: string) { for (const f of [...(this.listeners[type] ?? [])]) f({ type, target: this }); }
}

export interface FakeDom {
  document: any;
  /** Where a mounted tree lives. */
  container: FakeNode;
  /** Fire a window-level event (`pagehide`). */
  fireWindow(type: string): void;
  /** Set `document.visibilityState` and fire `visibilitychange`. */
  setVisibility(state: "visible" | "hidden"): void;
  /** Run every ResizeObserver callback, as a browser would after a layout change. */
  resize(): void;
  /** Run pending animation frames, so `settleRestore` can clear its `applying` flag. */
  flushFrames(): void;
  uninstall(): void;
}

const GLOBALS = ["document", "window", "Node", "Element", "HTMLElement", "HTMLIFrameElement", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "IS_REACT_ACT_ENVIRONMENT", "addEventListener", "removeEventListener"] as const;

/** Install the fake DOM onto `globalThis`. Call `uninstall()` in an `afterAll`. */
export function installDom(): FakeDom {
  const saved = new Map<string, unknown>();
  for (const k of GLOBALS) saved.set(k, (globalThis as any)[k]);
  const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

  const doc: any = {
    nodeType: 9,
    visibilityState: "visible",
    createElement: (n: string) => new FakeNode(n, doc),
    createElementNS: (_ns: string, n: string) => new FakeNode(n, doc),
    createTextNode: (t: string) => ({ nodeType: 3, nodeValue: t, parentNode: null, ownerDocument: doc }),
    createComment: (t: string) => ({ nodeType: 8, nodeValue: t, parentNode: null, ownerDocument: doc }),
    listeners: {} as Record<string, Listener[]>,
    addEventListener(t: string, f: Listener) { (doc.listeners[t] ||= []).push(f); },
    removeEventListener(t: string, f: Listener) { doc.listeners[t] = (doc.listeners[t] ?? []).filter((x: Listener) => x !== f); },
  };
  doc.documentElement = new FakeNode("html", doc);
  doc.body = new FakeNode("body", doc);
  doc.documentElement.parentNode = doc;
  doc.body.parentNode = doc.documentElement;
  doc.activeElement = doc.body;

  const winListeners: Record<string, Listener[]> = {};
  const observers = new Set<{ cb: () => void }>();
  let frames: Array<() => void> = [];
  let nextFrame = 1;

  class FakeResizeObserver {
    private entry: { cb: () => void };
    constructor(cb: () => void) { this.entry = { cb }; observers.add(this.entry); }
    observe() { /* target list is irrelevant: `resize()` fires every live observer */ }
    unobserve() {}
    disconnect() { observers.delete(this.entry); }
  }

  // `window` is `globalThis`, as it is in a browser; only its listener registry is ours, so a
  // test can fire `pagehide` without going near bun's native EventTarget.
  set("addEventListener", (t: string, f: Listener) => void ((winListeners[t] ||= []).push(f)));
  set("removeEventListener", (t: string, f: Listener) => void (winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f)));

  set("document", doc);
  set("window", globalThis);
  set("Node", FakeNode);
  set("Element", FakeNode);
  set("HTMLElement", FakeNode);
  set("HTMLIFrameElement", class extends FakeNode {});
  set("ResizeObserver", FakeResizeObserver);
  set("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return nextFrame++; });
  set("cancelAnimationFrame", () => {});
  set("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  set("IS_REACT_ACT_ENVIRONMENT", true);

  const container = doc.createElement("div") as FakeNode;
  doc.body.appendChild(container);

  return {
    document: doc,
    container,
    fireWindow(type: string) { for (const f of [...(winListeners[type] ?? [])]) f({ type }); },
    setVisibility(state) {
      doc.visibilityState = state;
      for (const f of [...(doc.listeners["visibilitychange"] ?? [])]) f({ type: "visibilitychange" });
    },
    resize() { for (const o of [...observers]) o.cb(); },
    flushFrames() { const due = frames; frames = []; for (const f of due) f(); },
    uninstall() { for (const k of GLOBALS) Object.defineProperty(globalThis, k, { value: saved.get(k), configurable: true, writable: true }); },
  };
}
