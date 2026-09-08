/**
 * The last settled frame, kept on the client (#43).
 *
 * A refresh of a screen you were just looking at used to paint a state that is not the data
 * yet — Home's onboarding, a board's bare "Loading…" — for as long as one HTTP round trip
 * takes. The fix is not a server renderer (#40's decision): it is to remember the payload
 * that produced the last good frame and hand it back *synchronously*, in the `useState`
 * initialiser, so the first paint is that frame and the fetch swaps identical data under an
 * already mounted tree.
 *
 * Synchronous is the whole requirement, which is why this is `localStorage` and not
 * IndexedDB: an async read would land back in an effect and reintroduce the frame it is
 * meant to remove. It is a cache, never a source of truth — every read is `try`/`catch`ed
 * and may return null (private mode, a blocked origin, a cleared store), every caller has
 * to work without it, and the version in the key means a payload shape change simply
 * misses rather than deserialising into something the UI cannot render.
 */

/** Bumped whenever a cached payload's shape changes. Old keys are swept on first use. */
const VERSION = "1";
const PREFIX = `flock.snap.${VERSION}.`;
/** Everything flock caches here is small JSON; the busiest board snapshot in the repo is
 *  ~120KB of cards and channel history, against a 5MB origin budget. Past this a payload
 *  is not worth a first frame, and is dropped rather than stored. */
const MAX_CHARS = 512_000;

/** The route each cached payload belongs to. Board and card keys take the ref from the URL,
 *  so the same board reached by slug and by id simply caches twice rather than colliding. */
export const snapKey = {
  home: "home",
  board: (boardRef: string) => `board:${boardRef}`,
  card: (boardRef: string, num: number) => `card:${boardRef}:${num}`,
};

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
    if (k.startsWith("flock.snap.") && !k.startsWith(PREFIX)) s.removeItem(k);
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

/** The cached payload for a route, or null when there is nothing usable. */
export function readSnapshot<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Corrupt JSON, a hostile value, a store that throws on read: no cache is a valid answer.
    return null;
  }
}

/** Remember a payload for the next first paint. Never throws; failing to cache is not an error. */
export function writeSnapshot(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return;
  }
  if (raw.length > MAX_CHARS) {
    // Too big to be worth a frame, and a stale entry would be worse than none.
    try { s.removeItem(PREFIX + key); } catch { /* nothing to do */ }
    return;
  }
  try {
    s.setItem(PREFIX + key, raw);
  } catch {
    // Quota: the other routes' frames are worth less than this one, so drop them all and
    // retry once. Still failing (private mode, a blocked origin) is fine — the screen is
    // live either way and the next successful write will seed the next refresh.
    try {
      clearSnapshots();
      s.setItem(PREFIX + key, raw);
    } catch { /* nothing to do */ }
  }
}

/** Forget one route's frame — the board it belonged to is gone, or the entry is wrong. */
export function clearSnapshot(key: string): void {
  try {
    store()?.removeItem(PREFIX + key);
  } catch { /* nothing to do */ }
}

/** Every cached frame, gone. Used on a quota failure and by the tests. */
export function clearSnapshots(): void {
  try {
    const s = globalThis.localStorage;
    if (!s) return;
    for (const k of keysOf(s) ?? []) if (k.startsWith("flock.snap.")) s.removeItem(k);
  } catch { /* nothing to do */ }
}
