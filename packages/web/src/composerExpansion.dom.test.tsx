import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, type FakeDom } from "./testdom.ts";
import { LineComposer } from "./thread.tsx";

/**
 * The phone composer opens on focus and closes only when the keyboard goes. Driven through the
 * React props on each host node, as reply.dom.test.tsx does: the fake DOM does not bubble.
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

function find(node: any, match: (n: any) => boolean): any {
  if (node.nodeType === 1 && match(node)) return node;
  for (const c of node.childNodes ?? []) {
    const found = find(c, match);
    if (found) return found;
  }
  return null;
}

const byTag = (tag: string) => (n: any) => n.tagName?.toLowerCase() === tag;
const classes = (n: any) => ((n.attrs?.class as string) ?? "").split(" ");

function mount() {
  const root = createRoot(dom.container as unknown as Element);
  act(() => {
    root.render(
      <LineComposer
        className="card-composer"
        compact
        placeholder="Comment"
        action="Comment"
        boardId="b1"
        attachable
        above={<div className="mode-row" />}
        address={{ board: "b1", pane: "card", card: 1 }}
        onSubmit={async () => {}}
      />,
    );
  });
  cleanup = () => act(() => root.unmount());
  const form = () => find(dom.container, byTag("form"));
  const area = () => find(dom.container, byTag("textarea"));
  const attach = () => find(dom.container, (n) => "data-attach" in (n.attrs ?? {}));
  const focus = () => act(() => reactProps(area()).onFocus());
  const blur = (relatedTarget: unknown = null) =>
    act(() => reactProps(area()).onBlur({ relatedTarget, currentTarget: { form: { contains: (n: unknown) => n === "inside" }, scrollTop: 0 } }));
  return { form, area, attach, focus, blur };
}

describe("the phone composer's expansion", () => {
  it("rests as one line, with no mode row and no attach button", () => {
    const c = mount();
    expect(classes(c.form())).toContain("composer-collapsed");
    expect(find(dom.container, (n) => classes(n).includes("mode-row"))).toBeNull();
    expect(c.attach()).toBeNull();
  });

  it("opens on focus and closes when the keyboard goes", () => {
    const c = mount();
    c.focus();
    expect(classes(c.form())).toContain("composer-expanded");
    expect(c.attach()).not.toBeNull();
    c.blur();
    expect(classes(c.form())).toContain("composer-collapsed");
  });

  it("stays open when focus moves to a control inside the composer", () => {
    const c = mount();
    c.focus();
    c.blur("inside");
    expect(classes(c.form())).toContain("composer-expanded");
  });

  it("stays open while the photo picker has the keyboard", () => {
    const c = mount();
    c.focus();
    act(() => reactProps(c.form()).onMouseDown({ target: { closest: (sel: string) => (sel === "[data-attach]" ? {} : null) }, preventDefault() {} }));
    c.blur();
    expect(classes(c.form())).toContain("composer-expanded");
  });

  it("expands to full and drops back to the line when the keyboard goes", () => {
    const c = mount();
    c.focus();
    const expand = find(dom.container, (n) => classes(n).includes("composer-expand"));
    act(() => reactProps(expand).onClick());
    expect(classes(c.form())).toContain("composer-full");
    c.blur();
    expect(classes(c.form())).not.toContain("composer-full");
    expect(classes(c.form())).toContain("composer-collapsed");
  });
});
