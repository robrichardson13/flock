import { beforeEach, describe, expect, it } from "bun:test";
import { clearDraft, draftCount, draftKey, getDraft, isEmptyDraft, resetDrafts, saveDraft, shouldSendOnEnter, type StagedAttachment } from "./compose.ts";

const key = (overrides: Partial<Parameters<typeof shouldSendOnEnter>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...overrides,
});

const staged = (localId: string): StagedAttachment => ({ localId, previewUrl: `blob:${localId}`, status: "ready" });

const attachment = (id: string, boardId = "b1") => ({
  id,
  boardId,
  messageId: null,
  author: "ada",
  authorKind: "human" as const,
  mime: "image/png",
  name: null,
  size: 1,
  sha256: "x",
  width: null,
  height: null,
  createdAt: new Date().toISOString(),
});

beforeEach(resetDrafts);

describe("draftKey", () => {
  it("separates panes on one board", () => {
    expect(draftKey({ board: "b1", pane: "channel" })).not.toBe(draftKey({ board: "b1", pane: "decisions" }));
  });

  it("separates boards on one pane", () => {
    expect(draftKey({ board: "b1", pane: "channel" })).not.toBe(draftKey({ board: "b2", pane: "channel" }));
  });

  it("separates cards on one board", () => {
    expect(draftKey({ board: "b1", pane: "card", card: 1 })).not.toBe(draftKey({ board: "b1", pane: "card", card: 2 }));
  });

  it("is stable for the same address", () => {
    expect(draftKey({ board: "b1", pane: "card", card: 7 })).toBe(draftKey({ board: "b1", pane: "card", card: 7 }));
  });
});

describe("draft store", () => {
  it("has no draft until one is saved", () => {
    expect(getDraft("k")).toEqual({ text: "", staged: [] });
    expect(draftCount()).toBe(0);
  });

  it("keeps text and attachments across the composer that wrote them", () => {
    saveDraft("k", { text: "half a thought", staged: [staged("a")] });
    expect(getDraft("k").text).toBe("half a thought");
    expect(getDraft("k").staged).toHaveLength(1);
  });

  it("stores nothing for an empty draft, and forgets one emptied again", () => {
    saveDraft("k", { text: "", staged: [] });
    expect(draftCount()).toBe(0);
    saveDraft("k", { text: "typing", staged: [] });
    expect(draftCount()).toBe(1);
    saveDraft("k", { text: "", staged: [] });
    expect(draftCount()).toBe(0);
  });

  it("keeps a draft that is only an attachment", () => {
    saveDraft("k", { text: "", staged: [staged("a")] });
    expect(draftCount()).toBe(1);
  });

  it("hands the cleared draft back so its previews can be revoked", () => {
    saveDraft("k", { text: "x", staged: [staged("a"), staged("b")] });
    const gone = clearDraft("k");
    expect(gone?.staged.map((s) => s.previewUrl)).toEqual(["blob:a", "blob:b"]);
    expect(draftCount()).toBe(0);
    expect(clearDraft("k")).toBeUndefined();
  });

  it("keeps drafts for different addresses apart", () => {
    saveDraft(draftKey({ board: "b", pane: "channel" }), { text: "chan", staged: [] });
    saveDraft(draftKey({ board: "b", pane: "decisions" }), { text: "dec", staged: [] });
    expect(getDraft(draftKey({ board: "b", pane: "channel" })).text).toBe("chan");
    expect(getDraft(draftKey({ board: "b", pane: "decisions" })).text).toBe("dec");
  });
});

describe("shouldSendOnEnter", () => {
  describe("desktop (enterSends: true)", () => {
    it("sends on plain Enter", () => {
      expect(shouldSendOnEnter(key(), true)).toBe(true);
    });

    it("does not send on Shift+Enter, leaving the newline to the browser", () => {
      expect(shouldSendOnEnter(key({ shiftKey: true }), true)).toBe(false);
    });

    it("sends on Cmd+Enter and Ctrl+Enter regardless of Shift", () => {
      expect(shouldSendOnEnter(key({ metaKey: true }), true)).toBe(true);
      expect(shouldSendOnEnter(key({ ctrlKey: true }), true)).toBe(true);
      expect(shouldSendOnEnter(key({ ctrlKey: true, shiftKey: true }), true)).toBe(true);
    });

    it("ignores a non-Enter key", () => {
      expect(shouldSendOnEnter(key({ key: "a" }), true)).toBe(false);
    });

    it("never sends mid-IME-composition, whether flagged by isComposing or the legacy keyCode 229", () => {
      expect(shouldSendOnEnter(key({ isComposing: true }), true)).toBe(false);
      expect(shouldSendOnEnter(key({ keyCode: 229 }), true)).toBe(false);
    });
  });

  describe("mobile / touch (enterSends: false)", () => {
    it("never sends on plain Enter, leaving the newline to the browser", () => {
      expect(shouldSendOnEnter(key(), false)).toBe(false);
    });

    it("still sends on Cmd+Enter / Ctrl+Enter", () => {
      expect(shouldSendOnEnter(key({ metaKey: true }), false)).toBe(true);
      expect(shouldSendOnEnter(key({ ctrlKey: true }), false)).toBe(true);
    });

    it("does not send on Shift+Enter either", () => {
      expect(shouldSendOnEnter(key({ shiftKey: true }), false)).toBe(false);
    });
  });
});

describe("isEmptyDraft", () => {
  it("is true only with no text and no attachments", () => {
    expect(isEmptyDraft({ text: "", staged: [] })).toBe(true);
    expect(isEmptyDraft({ text: " ", staged: [] })).toBe(false);
    expect(isEmptyDraft({ text: "", staged: [staged("a")] })).toBe(false);
  });
});

/* ---------- persistence ---------- */

/**
 * A localStorage stand-in. `throws` reproduces the browsers that make the accessor itself
 * raise — private mode, a full quota, an origin with site data blocked — which is the case
 * the store's try/catch exists for.
 */
function fakeStorage({ throws = false }: { throws?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => {
      if (throws) throw new Error("blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error("blocked");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Captures the one listener the module registers for an event, so a test can fire it
 *  without a real DOM. */
function fakeTarget() {
  const listeners = new Map<string, () => void>();
  return {
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string) => listeners.get(type)?.(),
  };
}

/** The store reads storage once, at import, so each case gets a fresh module instance. */
async function loadCompose(opts: { storage?: unknown; visibilityState?: string } = {}) {
  const doc = fakeTarget();
  doc.visibilityState = opts.visibilityState ?? "visible";
  const win = fakeTarget();
  Object.defineProperty(globalThis, "localStorage", { value: opts.storage ?? fakeStorage(), configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
  const realAddEventListener = globalThis.addEventListener.bind(globalThis);
  // pagehide is registered on globalThis itself; intercept just that one type so unrelated
  // listeners (bun's own machinery) are untouched.
  (globalThis as unknown as { addEventListener: typeof globalThis.addEventListener }).addEventListener = ((type: string, fn: EventListenerOrEventListenerObject) => {
    if (type === "pagehide") return win.addEventListener(type, fn as () => void);
    return realAddEventListener(type, fn as EventListenerOrEventListenerObject);
  }) as typeof globalThis.addEventListener;
  const mod = (await import(`./compose.ts?case=${Math.random()}`)) as typeof import("./compose.ts");
  globalThis.addEventListener = realAddEventListener;
  return { mod, doc, win, storage: opts.storage as ReturnType<typeof fakeStorage> | undefined };
}

describe("persistence", () => {
  it("write-through lands in storage after the debounce, not before", async () => {
    const storage = fakeStorage();
    const { mod } = await loadCompose({ storage });
    mod.saveDraft("k", { text: "typing", staged: [] });
    expect(storage.map.has("flock.drafts")).toBe(false);
    await new Promise((r) => setTimeout(r, mod.PERSIST_DEBOUNCE_MS + 60));
    expect(storage.map.has("flock.drafts")).toBe(true);
    const stored = JSON.parse(storage.map.get("flock.drafts")!);
    expect(stored.k.text).toBe("typing");
    expect(typeof stored.k.updatedAt).toBe("number");
  });

  it("flushes synchronously when the tab goes hidden", async () => {
    const storage = fakeStorage();
    const { mod, doc } = await loadCompose({ storage });
    mod.saveDraft("k", { text: "half a thought", staged: [] });
    expect(storage.map.has("flock.drafts")).toBe(false);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(JSON.parse(storage.map.get("flock.drafts")!).k.text).toBe("half a thought");
  });

  it("flushes synchronously on pagehide", async () => {
    const storage = fakeStorage();
    const { mod, win } = await loadCompose({ storage });
    mod.saveDraft("k", { text: "leaving", staged: [] });
    win.fire("pagehide");
    expect(JSON.parse(storage.map.get("flock.drafts")!).k.text).toBe("leaving");
  });

  it("restores a draft written by a previous tab", async () => {
    const storage = fakeStorage();
    storage.map.set("flock.drafts", JSON.stringify({ k: { text: "left off here", staged: [], updatedAt: Date.now(), dropped: 0 } }));
    const { mod } = await loadCompose({ storage });
    expect(mod.getDraft("k").text).toBe("left off here");
  });

  it("restores an attachment that had finished uploading, by server id", async () => {
    const storage = fakeStorage();
    const att = attachment("srv-1");
    storage.map.set("flock.drafts", JSON.stringify({ k: { text: "", staged: [{ attachment: att }], updatedAt: Date.now(), dropped: 1 } }));
    const { mod } = await loadCompose({ storage });
    const d = mod.getDraft("k");
    expect(d.staged).toHaveLength(1);
    expect(d.staged[0].attachment?.id).toBe("srv-1");
    expect(d.staged[0].status).toBe("ready");
    expect(mod.takeDroppedCount("k")).toBe(1);
    // Read once, then forgotten.
    expect(mod.takeDroppedCount("k")).toBe(0);
  });

  it("prunes entries older than 7 days on load", async () => {
    const storage = fakeStorage();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    storage.map.set(
      "flock.drafts",
      JSON.stringify({
        stale: { text: "ancient", staged: [], updatedAt: eightDaysAgo, dropped: 0 },
        fresh: { text: "recent", staged: [], updatedAt: Date.now(), dropped: 0 },
      }),
    );
    const { mod } = await loadCompose({ storage });
    expect(mod.getDraft("stale").text).toBe("");
    expect(mod.getDraft("fresh").text).toBe("recent");
    const onDisk = JSON.parse(storage.map.get("flock.drafts")!);
    expect(onDisk.stale).toBeUndefined();
  });

  it("send clears the entry from storage", async () => {
    const storage = fakeStorage();
    const { mod } = await loadCompose({ storage });
    mod.saveDraft("k", { text: "about to send", staged: [] });
    mod.flushDrafts();
    expect(storage.map.has("flock.drafts")).toBe(true);
    mod.clearDraft("k");
    expect(JSON.parse(storage.map.get("flock.drafts")!).k).toBeUndefined();
    expect(mod.getDraft("k")).toEqual({ text: "", staged: [] });
  });

  it("cancel (never clearing) keeps the entry", async () => {
    const storage = fakeStorage();
    const { mod } = await loadCompose({ storage });
    mod.saveDraft("k", { text: "not sent", staged: [] });
    mod.flushDrafts();
    // Simulating "cancel": nothing more happens, no clearDraft call.
    expect(JSON.parse(storage.map.get("flock.drafts")!).k.text).toBe("not sent");
    expect(mod.getDraft("k").text).toBe("not sent");
  });

  it("falls back to memory when storage throws, without losing the draft", async () => {
    const storage = fakeStorage({ throws: true });
    const { mod } = await loadCompose({ storage });
    expect(() => mod.saveDraft("k", { text: "private mode", staged: [] })).not.toThrow();
    expect(() => mod.flushDrafts()).not.toThrow();
    // Never actually wrote to the throwing storage.
    expect(storage.map.has("flock.drafts")).toBe(false);
    // But the draft is still live for the rest of the tab's life.
    expect(mod.getDraft("k").text).toBe("private mode");
  });
});
