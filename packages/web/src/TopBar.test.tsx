import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, type ReactElement } from "react";
import { installDom, type FakeDom, type FakeNode } from "./testdom.ts";
import { TopBar, topBarShape } from "./TopBar.tsx";
import type { Route } from "./App.tsx";

function route(board?: string): Route {
  return { board, tab: "cards" };
}

describe("topBarShape", () => {
  it("is home with no board at all", () => {
    expect(topBarShape(false, false, false)).toBe("home");
    // A card slot held with no board on the route is not a real state, but the route wins.
    expect(topBarShape(false, true, true)).toBe("home");
  });

  it("is board on a board route with no card", () => {
    expect(topBarShape(true, false, false)).toBe("board");
    expect(topBarShape(true, false, true)).toBe("board");
  });

  it("is card while the route names a card and the card slot is held", () => {
    expect(topBarShape(true, true, true)).toBe("card");
  });

  it("falls back to board the instant the card slot is released, even before the route catches up", () => {
    // This is the close case: BoardView holds `route.card` for the length of the exit
    // animation, but CardPage yields its slot the moment `closing` goes true.
    expect(topBarShape(true, true, false)).toBe("board");
  });
});

/**
 * #10: the bell is Home-only chrome. It used to render on the phone's shared bar for both the
 * "home" and "board" shapes; a board's nav is tight enough without it.
 *
 * `TopBar` measures itself with a `ResizeObserver`, so this needs a real DOM (`./testdom.ts`)
 * rather than `renderToStaticMarkup`.
 */
describe("TopBar bell placement (#10)", () => {
  let dom: FakeDom;
  let createRoot: typeof import("react-dom/client").createRoot;

  beforeAll(async () => {
    dom = installDom();
    createRoot = (await import("react-dom/client")).createRoot;
  });
  afterAll(() => dom.uninstall());

  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

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

  const props = {
    actor: "rob",
    onNewBoard: () => {},
    onRename: () => {},
    onOpenNotifications: () => {},
  };

  it("renders the bell on the boards list (no board on the route)", () => {
    const el = mount(<TopBar route={route(undefined)} {...props} />);
    expect(hasClass(el, "notify-btn")).toBe(true);
  });

  it("does not render the bell on a board route", () => {
    const el = mount(<TopBar route={route("flock-2")} {...props} />);
    expect(hasClass(el, "notify-btn")).toBe(false);
  });
});
