import { afterEach, describe, expect, it } from "bun:test";

/** A localStorage stand-in with the bits this module actually uses, mirroring snapshot.test.ts. */
function fakeStorage({ throws = false, quota = false } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (throws) throw new Error("blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws || quota) throw new Error("quota exceeded");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

/** The sweep runs once per module instance, so each case gets a fresh import. */
async function load(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return await import(`./viewstate.ts?${Math.random()}`) as typeof import("./viewstate.ts");
}

/** Backdate a record's offsets by `ms`, the way a long gap between sessions would. */
function age(s: ReturnType<typeof fakeStorage>, slug: string, ms: number) {
  const key = `flock.view.1.${slug}`;
  const rec = JSON.parse(s.map.get(key)!);
  rec.at -= ms;
  rec.scrollAt = rec.at;
  s.map.set(key, JSON.stringify(rec));
}

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
});

describe("tab retention", () => {
  it("round-trips a remembered tab under a versioned per-board key", async () => {
    const s = fakeStorage();
    const { rememberTab, rememberedTab } = await load(s);
    rememberTab("retain-tab", "channel");
    expect(rememberedTab("retain-tab")).toBe("channel");
    expect([...s.map.keys()]).toEqual(["flock.view.1.retain-tab"]);
  });

  it("returns null when nothing is remembered", async () => {
    const { rememberedTab } = await load(fakeStorage());
    expect(rememberedTab("never-visited")).toBeNull();
  });

  it("does not collide two boards", async () => {
    const s = fakeStorage();
    const { rememberTab, rememberedTab } = await load(s);
    rememberTab("board-a", "channel");
    rememberTab("board-b", "decisions");
    expect(rememberedTab("board-a")).toBe("channel");
    expect(rememberedTab("board-b")).toBe("decisions");
  });

  it("survives corrupt JSON and a store that throws", async () => {
    const s = fakeStorage();
    s.map.set("flock.view.1.x", "{not json");
    const { rememberedTab } = await load(s);
    expect(rememberedTab("x")).toBeNull();
    const { rememberTab: rememberTab2, rememberedTab: rememberedTab2 } = await load(fakeStorage({ throws: true }));
    expect(() => rememberTab2("x", "channel")).not.toThrow();
    expect(rememberedTab2("x")).toBeNull();
  });
});

describe("scroll retention", () => {
  it("round-trips a numeric offset (cards, decisions)", async () => {
    const s = fakeStorage();
    const { rememberScroll, readScroll } = await load(s);
    rememberScroll("retain-tab", "cards", 240);
    rememberScroll("retain-tab", "decisions", 10);
    expect(readScroll("retain-tab", "cards")).toBe(240);
    expect(readScroll("retain-tab", "decisions")).toBe(10);
  });

  it("round-trips a {y, bottom} position (channel, activity)", async () => {
    const s = fakeStorage();
    const { rememberScroll, readScroll } = await load(s);
    rememberScroll("retain-tab", "channel", { y: 500, bottom: false });
    expect(readScroll("retain-tab", "channel")).toEqual({ y: 500, bottom: false });
  });

  it("keeps every surface's slot independent within one board record", async () => {
    const s = fakeStorage();
    const { rememberScroll, readScroll } = await load(s);
    rememberScroll("retain-tab", "cards", 1);
    rememberScroll("retain-tab", "channel", { y: 2, bottom: true });
    rememberScroll("retain-tab", "activity", { y: 3, bottom: false });
    rememberScroll("retain-tab", "decisions", 4);
    expect(readScroll("retain-tab", "cards")).toBe(1);
    expect(readScroll("retain-tab", "channel")).toEqual({ y: 2, bottom: true });
    expect(readScroll("retain-tab", "activity")).toEqual({ y: 3, bottom: false });
    expect(readScroll("retain-tab", "decisions")).toBe(4);
    // Exactly one key per board, not one per surface.
    expect([...s.map.keys()]).toEqual(["flock.view.1.retain-tab"]);
  });

  it("a scroll write does not clobber an already-remembered tab", async () => {
    const s = fakeStorage();
    const { rememberTab, rememberScroll, rememberedTab } = await load(s);
    rememberTab("retain-tab", "channel");
    rememberScroll("retain-tab", "cards", 99);
    expect(rememberedTab("retain-tab")).toBe("channel");
  });

  it("expires an offset past the TTL but the tab survives", async () => {
    const s = fakeStorage();
    const { rememberScroll, readScroll, rememberedTab, SCROLL_TTL_MS } = await load(s);
    rememberScroll("retain-tab", "cards", 500);
    age(s, "retain-tab", SCROLL_TTL_MS + 1000);
    expect(readScroll("retain-tab", "cards")).toBeUndefined();
    expect(rememberedTab("retain-tab")).toBe("cards"); // tab itself is unaffected by the offset's age
  });

  it("keeps an offset just inside the TTL", async () => {
    const s = fakeStorage();
    const { rememberScroll, readScroll, SCROLL_TTL_MS } = await load(s);
    rememberScroll("retain-tab", "cards", 500);
    age(s, "retain-tab", SCROLL_TTL_MS - 1000);
    expect(readScroll("retain-tab", "cards")).toBe(500);
  });

  /**
   * The offset's age is its own clock. It used to share `at` with the tab, and `rememberTab`
   * fires on entry and on every tab the router settles on — so walking into a board was enough
   * to make a nine-hour-old offset young again and yank the reader to it for the rest of the
   * session. The ADR says an offset expires after one working session; this is what makes that
   * true rather than nearly true.
   */
  it("does not let a tab write make a stale offset young again", async () => {
    const s = fakeStorage();
    const { rememberScroll, rememberTab, readScroll, SCROLL_TTL_MS } = await load(s);
    rememberScroll("retain-tab", "channel", { y: 1234, bottom: false });
    age(s, "retain-tab", SCROLL_TTL_MS + 1000);
    expect(readScroll("retain-tab", "channel")).toBeUndefined();

    rememberTab("retain-tab", "channel"); // entering the board
    expect(readScroll("retain-tab", "channel")).toBeUndefined();

    // Writing an offset is what refreshes it, and only for the surface written.
    rememberScroll("retain-tab", "channel", { y: 77, bottom: false });
    expect(readScroll("retain-tab", "channel")).toEqual({ y: 77, bottom: false });
  });

  it("reads a record written before the split by its only timestamp", async () => {
    const s = fakeStorage();
    s.map.set("flock.view.1.old", JSON.stringify({ tab: "channel", at: Date.now(), scroll: { cards: 42 } }));
    const { readScroll } = await load(s);
    expect(readScroll("old", "cards")).toBe(42);
  });
});

describe("housekeeping", () => {
  it("sweeps a key written by an older version", async () => {
    const s = fakeStorage();
    s.map.set("flock.view.0.stale", JSON.stringify({ tab: "cards", at: Date.now(), scroll: {} }));
    const { rememberTab } = await load(s);
    // The sweep is lazy — it runs on the first store access, not on import — so trigger one.
    rememberTab("fresh", "channel");
    expect(s.map.has("flock.view.0.stale")).toBe(false);
    expect([...s.map.keys()]).toEqual(["flock.view.1.fresh"]);
  });

  it("prunes the oldest record once past the cap", async () => {
    const s = fakeStorage();
    const { rememberTab } = await load(s);
    // 50 boards already at the cap, oldest first, each a tick apart so `at` orders them
    // deterministically.
    for (let i = 0; i < 50; i++) {
      const raw = JSON.stringify({ tab: "cards", at: i, scroll: {} });
      s.map.set(`flock.view.1.b${i}`, raw);
    }
    // One more write pushes the store one past the cap; it should drop b0, the oldest.
    rememberTab("newest", "channel");
    expect(s.map.has("flock.view.1.b0")).toBe(false);
    expect(s.map.has("flock.view.1.b1")).toBe(true);
    expect(s.map.has("flock.view.1.newest")).toBe(true);
    expect(s.map.size).toBe(50);
  });

  /**
   * `prune` only ever ran after a *successful* write, so a store that had filled up could
   * never shed anything again — the one write failure worth retrying.
   */
  it("prunes and retries once when the store is full", async () => {
    const s = fakeStorage();
    // Refuses a write while it is over the record cap, accepts one once pruning has freed room.
    const full = {
      get length() { return s.map.size; },
      key: (i: number) => [...s.map.keys()][i] ?? null,
      getItem: (k: string) => s.map.get(k) ?? null,
      removeItem: (k: string) => void s.map.delete(k),
      setItem: (k: string, v: string) => { if (s.map.size > 50) throw new Error("quota exceeded"); s.map.set(k, v); },
    };
    const { rememberTab } = await load(full);
    for (let i = 0; i < 55; i++) s.map.set(`flock.view.1.b${i}`, JSON.stringify({ tab: "cards", at: i, scroll: {} }));
    rememberTab("newest", "channel");
    expect(s.map.has("flock.view.1.newest")).toBe(true);
    expect(s.map.has("flock.view.1.b0")).toBe(false);
  });

  /**
   * ADR 0013 assumed a deleted board's record was inert. `entryRedirect` reads it, so
   * `#/b/<gone>` kept redirecting and a slug reused later inherited the dead board's tab and
   * offsets. `BoardView` calls this on a 404, beside the snapshot cache it already clears.
   */
  it("forgets a board's record outright", async () => {
    const s = fakeStorage();
    const { rememberTab, rememberScroll, rememberedTab, readScroll, forgetView } = await load(s);
    rememberTab("gone", "channel");
    rememberScroll("gone", "cards", 800);
    forgetView("gone");
    expect(rememberedTab("gone")).toBeNull();
    expect(readScroll("gone", "cards")).toBeUndefined();
    expect([...s.map.keys()]).toEqual([]);
  });

  it("never throws when storage is entirely unavailable", async () => {
    const { rememberTab, rememberedTab, rememberScroll, readScroll } = await load(undefined);
    expect(() => rememberTab("x", "channel")).not.toThrow();
    expect(rememberedTab("x")).toBeNull();
    expect(() => rememberScroll("x", "cards", 1)).not.toThrow();
    expect(readScroll("x", "cards")).toBeUndefined();
  });
});

describe("entryRedirect", () => {
  it("redirects a bare board route to the remembered tab on entry", async () => {
    const { entryRedirect } = await load(fakeStorage());
    const remembered = () => "channel" as const;
    expect(entryRedirect("#/b/retain-tab", undefined, remembered)).toBe("#/b/retain-tab/channel");
  });

  it("does not redirect when the remembered tab is cards", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/retain-tab", undefined, () => "cards")).toBeNull();
  });

  it("does not redirect when nothing is remembered", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/retain-tab", undefined, () => null)).toBeNull();
  });

  it("does not redirect an in-board switch back to cards (the trap)", async () => {
    const { entryRedirect } = await load(fakeStorage());
    // Already inside "retain-tab"; tapping Cards writes the bare route again. Without the
    // slug-changed gate this would bounce straight back to "channel".
    expect(entryRedirect("#/b/retain-tab", "retain-tab", () => "channel")).toBeNull();
  });

  it("redirects when entering a different board than the one last rendered", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/board-b", "board-a", () => "activity")).toBe("#/b/board-b/activity");
  });

  it("keeps the hash's own spelling of the slug, so there is only one spelling in play", async () => {
    const { entryRedirect } = await load(fakeStorage());
    // The redirect edits the hash it was handed rather than re-encoding a decoded slug, so it
    // can never disagree with `paneHref`'s spelling of the same board.
    expect(entryRedirect("#/b/a%20b", undefined, () => "channel")).toBe("#/b/a%20b/channel");
  });

  it("never overrides an explicit deep link: a card route", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/retain-tab/c/3", undefined, () => "channel")).toBeNull();
  });

  it("never overrides an explicit deep link: an actor route", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/retain-tab/a/builder", undefined, () => "channel")).toBeNull();
  });

  it("never overrides an explicit tab route, cards included", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/retain-tab/channel", undefined, () => "decisions")).toBeNull();
    expect(entryRedirect("#/b/retain-tab/cards", undefined, () => "channel")).toBeNull();
  });

  it("leaves the boards list route alone", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/", "retain-tab", () => "channel")).toBeNull();
  });

  it("round-trips slug encoding", async () => {
    const { entryRedirect } = await load(fakeStorage());
    expect(entryRedirect("#/b/two%20words", undefined, (slug) => (slug === "two words" ? "channel" : null))).toBe("#/b/two%20words/channel");
  });
});
