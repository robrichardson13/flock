import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, type ReactElement } from "react";
import { installDom, type FakeDom, type FakeNode } from "./testdom.ts";
import { AppTopBar } from "./shell.tsx";

/**
 * #10: the desktop bar is shared between Home and a board. The bell is Home-only chrome —
 * only Home passes `onOpenNotifications`, so a board's `AppTopBar` (which omits it) must not
 * render the button at all, rather than rendering it disabled or inert.
 *
 * `AppTopBar` calls `useIsMobile`, which reads `window.matchMedia` on every render, so this
 * needs a real DOM (`./testdom.ts`) rather than `renderToStaticMarkup`.
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

/** True if any node in the subtree carries `cls` among its space-separated `class` attribute. */
function hasClass(node: FakeNode, cls: string): boolean {
  const classes = node.attrs?.class?.split(/\s+/) ?? [];
  if (classes.includes(cls)) return true;
  return node.children.some((c: FakeNode) => hasClass(c, cls));
}

function mount(ui: ReactElement): FakeNode {
  const root = createRoot(dom.container as unknown as Element);
  act(() => { root.render(ui); });
  cleanup = () => act(() => root.unmount());
  return dom.container.firstChild as FakeNode;
}

describe("AppTopBar bell placement (#10)", () => {
  const base = { actor: "rob", onNewBoard: () => {}, onRename: () => {} };

  it("renders the bell when Home passes onOpenNotifications", () => {
    const el = mount(<AppTopBar {...base} onOpenNotifications={() => {}} />);
    expect(hasClass(el, "notify-btn")).toBe(true);
  });

  it("omits the bell entirely when a board doesn't pass onOpenNotifications", () => {
    const el = mount(<AppTopBar {...base} />);
    expect(hasClass(el, "notify-btn")).toBe(false);
  });
});
