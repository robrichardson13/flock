import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { act, type ReactElement } from "react";
import { NotifyPrefs } from "./Notifications.tsx";
import { installDom, type FakeDom, type FakeNode } from "./testdom.ts";

/**
 * Card 81 (ADR 0024): "What buzzes" — the four independent level toggles and the quiet
 * check-in threshold, fetched from `GET /api/notify/settings` and saved on toggle via `PUT`.
 * These stub `fetch` directly (the same seam `api.ts`'s `req()` calls) rather than mocking the
 * `api` module, so a real request shape (method, path, body) is exercised end to end.
 */

let dom: FakeDom;
let createRoot: typeof import("react-dom/client").createRoot;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  dom = installDom();
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(() => dom.uninstall());

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function findAll(node: FakeNode, pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (pred(node)) out.push(node);
  for (const c of (node.childNodes ?? []) as FakeNode[]) findAll(c, pred, out);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reactProps(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : null;
}

function switches(): FakeNode[] {
  return findAll(dom.container as unknown as FakeNode, (n) => n.attrs?.role === "switch");
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function mount(ui: ReactElement) {
  const root = createRoot(dom.container as unknown as Element);
  act(() => { root.render(ui); });
  cleanup = () => act(() => root.unmount());
}

const DEFAULT_RESOLVED = { needsMe: true, review: true, info: false, settled: false, settledAfterMs: 20 * 60_000 };
const EMPTY_RAW = { needsMe: null, review: null, info: null, settled: null, settledAfterMs: null };

describe("NotifyPrefs (card 81)", () => {
  it("renders four switches carrying the fetched values", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return jsonResponse({ boardId: "", raw: EMPTY_RAW, resolved: DEFAULT_RESOLVED });
    }) as unknown as typeof fetch;

    mount(<NotifyPrefs open />);
    await flush();

    const rows = switches();
    expect(rows).toHaveLength(4);
    // Order: Needs me, Review requested, Everything else, Quiet check-in.
    expect(rows.map((s) => s.attrs["aria-checked"])).toEqual(["true", "true", "false", "false"]);
    expect(requests).toBe(1);
  });

  it("a toggle PUTs the field, and reverts the switch when the save fails", async () => {
    const captured: { put: Record<string, unknown> | null } = { put: null };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ boardId: "", raw: EMPTY_RAW, resolved: DEFAULT_RESOLVED });
      captured.put = JSON.parse(init!.body as string);
      return jsonResponse({ error: "boom" }, 500);
    }) as unknown as typeof fetch;

    mount(<NotifyPrefs open />);
    await flush();

    const everythingElse = switches()[2];
    expect(everythingElse.attrs["aria-checked"]).toBe("false");

    await act(async () => {
      reactProps(everythingElse).onClick();
    });
    await flush();

    expect(captured.put).toEqual({ info: true });
    // Optimistic flip reverted after the failed PUT.
    expect(switches()[2].attrs["aria-checked"]).toBe("false");
    expect(findAll(dom.container as unknown as FakeNode, (n) => (n.attrs?.class ?? "").split(/\s+/).includes("inline-error"))).toHaveLength(1);
  });

  it("a toggle PUTs the field and keeps the flip when the save succeeds", async () => {
    const captured: { put: Record<string, unknown> | null } = { put: null };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ boardId: "", raw: EMPTY_RAW, resolved: DEFAULT_RESOLVED });
      captured.put = JSON.parse(init!.body as string);
      const resolved = { ...DEFAULT_RESOLVED, ...captured.put };
      return jsonResponse({ boardId: "", raw: { ...EMPTY_RAW, ...captured.put }, resolved });
    }) as unknown as typeof fetch;

    mount(<NotifyPrefs open />);
    await flush();

    await act(async () => {
      reactProps(switches()[2]).onClick();
    });
    await flush();

    expect(captured.put).toEqual({ info: true });
    expect(switches()[2].attrs["aria-checked"]).toBe("true");
  });

  it("opened from a board reads that board's override, not the global row", async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("board=flock-2")) {
        return jsonResponse({
          boardId: "b2",
          raw: { needsMe: null, review: false, info: null, settled: null, settledAfterMs: null },
          resolved: { needsMe: true, review: false, info: false, settled: false, settledAfterMs: 20 * 60_000 },
        });
      }
      return jsonResponse({ boardId: "", raw: EMPTY_RAW, resolved: DEFAULT_RESOLVED });
    }) as unknown as typeof fetch;

    mount(<NotifyPrefs open board={{ slug: "flock-2", title: "Flock 2" }} />);
    await flush();

    // review is overridden off on this board, unlike the global default (on).
    expect(switches().map((s) => s.attrs["aria-checked"])).toEqual(["true", "false", "false", "false"]);
    expect(findAll(dom.container as unknown as FakeNode, (n) => (n.attrs?.class ?? "").includes("notify-board-name"))).toHaveLength(1);
  });

  it("opened from Home shows the global row and no board heading", async () => {
    globalThis.fetch = (async () => jsonResponse({ boardId: "", raw: EMPTY_RAW, resolved: DEFAULT_RESOLVED })) as unknown as typeof fetch;

    mount(<NotifyPrefs open />);
    await flush();

    expect(switches().map((s) => s.attrs["aria-checked"])).toEqual(["true", "true", "false", "false"]);
    expect(findAll(dom.container as unknown as FakeNode, (n) => (n.attrs?.class ?? "").includes("notify-board-name"))).toHaveLength(0);
    expect(findAll(dom.container as unknown as FakeNode, (n) => (n.attrs?.class ?? "").includes("notify-reset"))).toHaveLength(0);
  });
});
