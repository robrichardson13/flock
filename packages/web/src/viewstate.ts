/**
 * Remembers which tab a board was left on, and where each of its scrollable surfaces was
 * scrolled to — so leaving a board for the boards list and coming back reopens it where the
 * reader left it, and switching tabs within a board keeps each tab's own position too.
 *
 * See `docs/adr/0013-remembered-tab-and-scroll-position.md` for the design this implements.
 * Everything in this module is pure and DOM-free by design (ADR consequence: "the pure parts
 * ... are what the tests should cover"); the scroll-restoring DOM effects live in `live.ts`
 * and are applied from `BoardView.tsx`.
 *
 * Storage is `localStorage`, matching the app's one existing persistence idiom (`flock.snap`,
 * `flock.brief.<slug>`, ...): one record per board at `flock.view.1.<slug>`, every access
 * `try`/`catch`ed, versioned and swept the same way `flock.snap` is.
 */
import type { BoardTab } from "./BoardView.tsx";

/** Bumped whenever a stored record's shape changes. Old keys are swept on first use. */
const VIEW_VERSION = "1";
const PREFIX = `flock.view.${VIEW_VERSION}.`;

/** Remembered offsets older than this are treated as stale noise; the tab itself never
 *  expires (which surface you read is a preference, not a moment). */
export const SCROLL_TTL_MS = 8 * 60 * 60 * 1000;

/** Bound on how many boards' records this store keeps; past it the oldest (by `at`) is
 *  dropped on write, so an ever-growing list of visited boards cannot grow the store forever. */
const MAX_RECORDS = 50;

/** A bottom-anchored surface's remembered position: `bottom` is whether the reader was
 *  pinned to the bottom at write time, in which case `y` is not restored — the pin wins. */
export interface Pos {
  y: number;
  bottom: boolean;
}

export type ScrollSurface = "cards" | "channel" | "activity" | "decisions";

interface ViewScroll {
  cards?: number;
  channel?: Pos;
  activity?: Pos;
  decisions?: number;
}

interface ViewRecord {
  tab: BoardTab;
  /** When this record was last written, ms since epoch. Drives both scroll TTL and the
   *  store's oldest-first pruning. */
  at: number;
  scroll: ViewScroll;
}

const TABS: readonly BoardTab[] = ["cards", "channel", "activity", "decisions"];

let swept = false;

/** Every key currently in the store, or null where the store cannot enumerate itself. */
function keysOf(s: Storage): string[] | null {
  if (typeof s.key !== "function" || typeof s.length !== "number") return null;
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) out.push(k);
  }
  return out;
}

/** Drop entries written by an older version of this module, once per session. */
function sweep(s: Storage) {
  swept = true;
  for (const k of keysOf(s) ?? []) {
    if (k.startsWith("flock.view.") && !k.startsWith(PREFIX)) s.removeItem(k);
  }
}

function store(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    if (!swept) sweep(s);
    return s;
  } catch {
    return null;
  }
}

function isPos(v: unknown): v is Pos {
  return !!v && typeof v === "object" && typeof (v as Pos).y === "number" && typeof (v as Pos).bottom === "boolean";
}

function parseRecord(raw: string): ViewRecord | null {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !TABS.includes(v.tab)) return null;
    const at = typeof v.at === "number" ? v.at : 0;
    const s = v.scroll && typeof v.scroll === "object" ? v.scroll : {};
    const scroll: ViewScroll = {};
    if (typeof s.cards === "number") scroll.cards = s.cards;
    if (typeof s.decisions === "number") scroll.decisions = s.decisions;
    if (isPos(s.channel)) scroll.channel = s.channel;
    if (isPos(s.activity)) scroll.activity = s.activity;
    return { tab: v.tab, at, scroll };
  } catch {
    return null;
  }
}

/** The raw stored record for a board, or null when there is nothing usable. */
function readView(slug: string): ViewRecord | null {
  try {
    const raw = store()?.getItem(PREFIX + slug);
    return raw ? parseRecord(raw) : null;
  } catch {
    // Corrupt JSON, a hostile value, a store that throws on read: no record is a valid answer.
    return null;
  }
}

/** Drop the oldest records past `MAX_RECORDS`, keyed by their own `at`. */
function prune(s: Storage) {
  const keys = (keysOf(s) ?? []).filter((k) => k.startsWith(PREFIX));
  if (keys.length <= MAX_RECORDS) return;
  const entries = keys.map((k) => {
    const raw = (() => { try { return s.getItem(k); } catch { return null; } })();
    const at = raw ? parseRecord(raw)?.at : undefined;
    return { k, at: at ?? 0 };
  });
  entries.sort((a, b) => a.at - b.at);
  for (const { k } of entries.slice(0, entries.length - MAX_RECORDS)) {
    try { s.removeItem(k); } catch { /* nothing to do */ }
  }
}

function writeView(slug: string, record: ViewRecord): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(PREFIX + slug, JSON.stringify(record));
    prune(s);
  } catch {
    // Private mode, or storage full. Retention is a convenience, not a requirement.
  }
}

/** The tab a board was last left on, or null when nothing is remembered for it. Never
 *  expires: which surface a reader reads is a standing preference, not a stale fact. */
export function rememberedTab(slug: string): BoardTab | null {
  return readView(slug)?.tab ?? null;
}

/** Record which tab a board is showing now. Called on every real tab the router settles on
 *  (never while a card page or actor sheet is merely borrowing "cards" as its route tab). */
export function rememberTab(slug: string, tab: BoardTab): void {
  const prev = readView(slug);
  writeView(slug, { tab, at: Date.now(), scroll: prev?.scroll ?? {} });
}

export function readScroll(slug: string, surface: "cards" | "decisions"): number | undefined;
export function readScroll(slug: string, surface: "channel" | "activity"): Pos | undefined;
export function readScroll(slug: string, surface: ScrollSurface): number | Pos | undefined {
  const v = readView(slug);
  if (!v) return undefined;
  if (Date.now() - v.at > SCROLL_TTL_MS) return undefined;
  return v.scroll[surface] as number | Pos | undefined;
}

export function rememberScroll(slug: string, surface: "cards" | "decisions", value: number): void;
export function rememberScroll(slug: string, surface: "channel" | "activity", value: Pos): void;
export function rememberScroll(slug: string, surface: ScrollSurface, value: number | Pos): void {
  const prev = readView(slug);
  writeView(slug, {
    tab: prev?.tab ?? "cards",
    at: Date.now(),
    scroll: { ...(prev?.scroll ?? {}), [surface]: value },
  });
}

/** Matches only the bare board route: `#/b/<slug>`, with an optional trailing slash. A card
 *  route, an actor route, and an explicit `#/b/<slug>/<tab>` (`/cards` included, though the
 *  app never writes it itself) all fall through untouched — this is the whole of the
 *  explicit-link-always-wins rule; there is no second place that has to agree with it. */
const BARE_BOARD_ROUTE = /^#\/b\/([^/]+)\/?$/;

/**
 * The hash the app should be on instead of `hash`, or null to leave it alone.
 *
 * Fires only on *entering* a board — the rendered board slug differing from the previously
 * rendered one, including the very first render, where there is no previous board — never on
 * an in-board switch back to Cards, which also writes the bare route (`paneHref(slug,
 * "cards") === "#/b/<slug>"`, ADR 0013). Without that gate a reader tapping Cards while
 * already inside the board would be read as a fresh entry and bounced straight back to
 * whatever tab they left.
 */
export function entryRedirect(hash: string, prevBoard: string | undefined, remembered: (slug: string) => BoardTab | null): string | null {
  const m = hash.match(BARE_BOARD_ROUTE);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  if (slug === prevBoard) return null;
  const tab = remembered(slug);
  if (!tab || tab === "cards") return null;
  return `#/b/${encodeURIComponent(slug)}/${tab}`;
}
