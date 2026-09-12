import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, type ReactElement } from "react";
import { installDom, type FakeDom, type FakeNode } from "./testdom.ts";
import { TopBar, TopBarProvider, topBarShape, useTopBarSlot } from "./TopBar.tsx";
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

/**
 * Card 50: the search icon is Cards-tab-only chrome, registered through the board slot like
 * `onOpenBrief`/`onOpenTeam`. It has to show and hide as a screen re-registers the slot with
 * (or without) `onOpenSearch` — the toggle this test exercises — without any *title* change to
 * force the bar to re-render (see the `Titles.search` comment in TopBar.tsx).
 */
describe("TopBar search icon (card 50)", () => {
  let dom: FakeDom;
  let createRoot: typeof import("react-dom/client").createRoot;

  beforeAll(async () => {
    dom = installDom();
    createRoot = (await import("react-dom/client")).createRoot;
  });
  afterAll(() => dom.uninstall());

  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  const props = {
    actor: "rob",
    onNewBoard: () => {},
    onRename: () => {},
    onOpenNotifications: () => {},
  };

  function findByLabel(node: FakeNode, label: string): FakeNode | null {
    if (node.attrs?.["aria-label"] === label) return node;
    for (const c of node.children as FakeNode[]) {
      const found = findByLabel(c, label);
      if (found) return found;
    }
    return null;
  }

  function Slotter({ withSearch }: { withSearch: boolean }) {
    useTopBarSlot("board", { title: "flock-2", onOpenSearch: withSearch ? () => {} : undefined });
    return null;
  }

  function mount(withSearch: boolean): { root: FakeNode; rerender: (v: boolean) => void } {
    const container = dom.container as unknown as Element;
    const root = createRoot(container);
    const render = (v: boolean) =>
      act(() => {
        root.render(
          <TopBarProvider>
            <TopBar route={route("flock-2")} {...props} />
            <Slotter withSearch={v} />
          </TopBarProvider>,
        );
      });
    render(withSearch);
    cleanup = () => act(() => root.unmount());
    return { root: dom.container.firstChild as FakeNode, rerender: render };
  }

  it("renders the search icon on the Cards tab", () => {
    const { root } = mount(true);
    expect(findByLabel(root, "Search cards")).not.toBeNull();
  });

  it("renders no search icon off the Cards tab", () => {
    const { root } = mount(false);
    expect(findByLabel(root, "Search cards")).toBeNull();
  });

  it("shows and hides the icon as the slot toggles, with no other prop changing", () => {
    const { rerender } = mount(true);
    expect(findByLabel(dom.container.firstChild as FakeNode, "Search cards")).not.toBeNull();
    rerender(false);
    expect(findByLabel(dom.container.firstChild as FakeNode, "Search cards")).toBeNull();
    rerender(true);
    expect(findByLabel(dom.container.firstChild as FakeNode, "Search cards")).not.toBeNull();
  });
});
