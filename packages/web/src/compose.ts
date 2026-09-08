import { attachmentUrl, type Attachment } from "./api.ts";

/**
 * One image the human has put on a message but not sent yet. It uploads the moment it is
 * staged, so it carries its own upload state and, once that lands, the attachment the
 * server made.
 */
export type StagedAttachment = {
  localId: string;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
};

export interface ComposeDraft {
  text: string;
  staged: StagedAttachment[];
}

/**
 * What a composer is composing *for*. The board and the pane are enough for the channel and
 * decisions; a card page composer adds the card number, since a board has many of those and
 * each keeps its own half-written comment.
 */
export interface DraftAddress {
  board: string;
  pane: "channel" | "decisions" | "card" | "reopen";
  card?: number;
}

export function draftKey(a: DraftAddress): string {
  return `${a.board} ${a.pane} ${a.card ?? ""}`;
}

/**
 * Drafts survive the composer that typed them. On the phone the composer is a sheet, and
 * cancelling it, tapping the backdrop or dragging it down must not throw away what was
 * typed; switching tabs unmounts the pane entirely, and that must not either. So the draft
 * lives here, in the module, keyed by where it was being written — and, since iOS freely
 * evicts and reloads a backgrounded home-screen app, it is mirrored into `localStorage` so
 * the reload gets it back too.
 *
 * The staged previews are `URL.createObjectURL` handles, good only for this page's lifetime.
 * This store owns them once a draft holds them — `clearDraft` hands the removed draft back
 * so the caller can revoke them — and only the ones that had already finished uploading (and
 * so carry a server attachment, reachable by URL) are written to storage; the rest cannot
 * survive a reload and are silently dropped, with the count surfaced via `takeDroppedCount`.
 */
const drafts = new Map<string, ComposeDraft>();

export const EMPTY_DRAFT: ComposeDraft = { text: "", staged: [] };

export function isEmptyDraft(d: ComposeDraft): boolean {
  return d.text === "" && d.staged.length === 0;
}

/* ---------- persistence: localStorage, debounced write-through ---------- */

const STORAGE_KEY = "flock.drafts";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PERSIST_DEBOUNCE_MS = 150;

interface PersistedStagedAttachment {
  attachment: Attachment;
}

interface PersistedEntry {
  text: string;
  staged: PersistedStagedAttachment[];
  updatedAt: number;
  /** How many staged attachments this entry could not keep, because they had not finished
   *  uploading (no server id yet) at the moment this was written. */
  dropped: number;
}

type PersistedStore = Record<string, PersistedEntry>;

/**
 * Set the moment real storage throws — private mode, a full quota, an origin with site data
 * blocked — so every later read and write for this module instance goes here instead. The
 * draft store still works for the rest of the tab's life; it just does not survive a reload.
 */
let fallback: PersistedStore | null = null;

function readStore(): PersistedStore {
  if (fallback) return fallback;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PersistedStore) : {};
  } catch {
    fallback = {};
    return fallback;
  }
}

function writeStore(store: PersistedStore): void {
  if (fallback) {
    fallback = store;
    return;
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    fallback = store;
  }
}

/** Read once, right after `restore()`, by the composer that lost attachments to a reload —
 *  so it can say "N attachments need re-adding" — then forgotten. */
const droppedCounts = new Map<string, number>();

export function takeDroppedCount(key: string): number {
  const n = droppedCounts.get(key) ?? 0;
  droppedCounts.delete(key);
  return n;
}

/** Loads whatever survived into `drafts`, pruning anything older than a week. Runs once, at
 *  import, before the first paint. */
function restore(): void {
  const store = readStore();
  const now = Date.now();
  let pruned = false;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry.updatedAt !== "number" || now - entry.updatedAt > MAX_AGE_MS) {
      delete store[key];
      pruned = true;
      continue;
    }
    const staged: StagedAttachment[] = (Array.isArray(entry.staged) ? entry.staged : [])
      .filter((s): s is PersistedStagedAttachment => !!s?.attachment?.id)
      .map((s) => ({
        localId: s.attachment.id,
        previewUrl: attachmentUrl(s.attachment.boardId, s.attachment.id),
        status: "ready" as const,
        attachment: s.attachment,
      }));
    const draft: ComposeDraft = { text: typeof entry.text === "string" ? entry.text : "", staged };
    if (!isEmptyDraft(draft)) drafts.set(key, draft);
    if (entry.dropped) droppedCounts.set(key, entry.dropped);
  }
  if (pruned) writeStore(store);
}

function serialize(): PersistedStore {
  const store: PersistedStore = {};
  const now = Date.now();
  for (const [key, draft] of drafts.entries()) {
    const keep = draft.staged.filter((s) => s.status === "ready" && s.attachment);
    store[key] = {
      text: draft.text,
      staged: keep.map((s) => ({ attachment: s.attachment! })),
      updatedAt: now,
      dropped: draft.staged.length - keep.length,
    };
  }
  return store;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Synchronous write-through: the debounce's own timeout lands here, and so do the two
 *  moments a backgrounded tab can vanish without warning — visibilitychange going hidden,
 *  and pagehide — so a draft is never more than one keystroke-and-a-blink from storage. */
export function flushDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeStore(serialize());
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushDrafts, PERSIST_DEBOUNCE_MS);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") flushDrafts();
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("pagehide", flushDrafts);

restore();

/* ---------- draft accessors ---------- */

export function getDraft(key: string): ComposeDraft {
  return drafts.get(key) ?? EMPTY_DRAFT;
}

/** Storing an empty draft removes it: an untouched composer should leave nothing behind. */
export function saveDraft(key: string, d: ComposeDraft): void {
  if (isEmptyDraft(d)) drafts.delete(key);
  else drafts.set(key, d);
  scheduleFlush();
}

/** Removes a draft and returns it, so the caller can revoke any preview URLs it held. Sent
 *  messages are the only thing that clears storage — cancelling a sheet or switching tabs
 *  never does — so this flushes immediately rather than waiting on the debounce. */
export function clearDraft(key: string): ComposeDraft | undefined {
  const had = drafts.get(key);
  drafts.delete(key);
  droppedCounts.delete(key);
  flushDrafts();
  return had;
}

/** Test seam. */
export function resetDrafts(): void {
  drafts.clear();
  droppedCounts.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function draftCount(): number {
  return drafts.size;
}

/* ---------- Enter key handling ---------- */

/**
 * Whether a keydown on the composer's textarea should submit rather than let the browser's
 * own handling (a newline) run. Callers `preventDefault` only when this returns true.
 *
 * `enterSends` is true only on a device with a mouse or trackpad (see `useHasFinePointer` in
 * ui.tsx): there, plain Enter sends and Shift+Enter falls through to its ordinary newline,
 * like other chat composers. On a touch device Enter is always a newline, since there is no
 * keyboard-shortcut convention to match. ⌘/Ctrl+Enter always sends, on every device,
 * regardless of `enterSends` or Shift.
 *
 * An IME candidate confirmation also arrives as `key: "Enter"`; some browsers mark it with
 * `isComposing`, others (notably older Safari/Chrome-on-Android paths) only set the legacy
 * `keyCode 229`, so both are checked and never treated as a send.
 */
export function shouldSendOnEnter(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}, enterSends: boolean): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return enterSends && !e.shiftKey;
}
