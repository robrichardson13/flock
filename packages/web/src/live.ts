/**
 * Live-update primitives. The board is driven by SSE; these hooks turn a stream of
 * events into a calm UI: bursts collapse into one refetch, new rows ease in, scroll
 * position is held unless the reader is already at the bottom, and the stream
 * resumes from the last seq it saw after the tab is backgrounded or the network drops.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { CardStatus, Event } from "./api.ts";
import { D_BASE, D_FLIP, EASE_OUT } from "./motion.ts";

/* ---------- coalesced refetch ---------- */

const DEBOUNCE_MS = 150;
/** Never let a steady drip of events starve the refetch for longer than this. */
const MAX_WAIT_MS = 600;

/**
 * Collapse a burst of triggers into one call of `fn`, and never run two at once.
 * A trigger arriving while a fetch is in flight marks the result dirty and refetches
 * once the current one lands. Returns a stable `trigger`.
 */
export function useCoalescedRefetch(fn: () => Promise<unknown>, delay = DEBOUNCE_MS): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef(0);
  const queuedAt = useRef(0);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const run = useCallback<() => Promise<void>>(async () => {
    if (!alive.current) return;
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    try {
      await fnRef.current();
    } catch {
      // The caller owns error state; a failed refetch must not wedge the queue.
    } finally {
      inFlight.current = false;
      if (dirty.current && alive.current) {
        dirty.current = false;
        void run();
      }
    }
  }, []);

  return useCallback(() => {
    const now = Date.now();
    if (!queuedAt.current) queuedAt.current = now;
    if (now - queuedAt.current >= MAX_WAIT_MS) {
      window.clearTimeout(timer.current);
      timer.current = 0;
      queuedAt.current = 0;
      void run();
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      queuedAt.current = 0;
      void run();
    }, delay);
  }, [run, delay]);
}

/* ---------- enter animation ---------- */

export type ItemId = string | number;

/** How long an id stays "new" — matches the `item-in` keyframe in styles.css, plus slack. */
const ENTER_MS = 320;

/**
 * The baseline to diff the current commit against, given whether `resetKey` changed since
 * the last time this hook's effect committed. An unchanged key leaves the running baseline
 * (`seen`) alone — the surface stayed mounted, diff normally. A changed key means the
 * surface this hook belongs to just (re)mounted under a new identity — the phone Cards pane
 * returning after a tab switch, most commonly — and the current commit becomes its own
 * baseline outright, so nothing on this pass reads as new or moved: that state is what the
 * mount entrance animation (`useEntranceIds`) already owns, and #9's whole point is that a
 * remount must not *also* replay a stale diff on top of it. `ready` false (data not in yet)
 * defers baselining exactly as an unmounted-then-remounted surface with no reset would have.
 * Pure — and generic over the baseline's shape (a `Set` for `useNewIds`, a `Map` for
 * `useMovedIds`) — so the remount rule is testable without a DOM.
 */
export function nextBaseline<S>(seen: S | null, ready: boolean, resetKey: unknown, lastReset: unknown, makeBaseline: () => S): S | null {
  if (lastReset !== resetKey) return ready ? makeBaseline() : null;
  return seen;
}

/**
 * The ids that appeared since the previous commit. Ids present on the first render are
 * never new, so an initial load and a refetch of unchanged items animate nothing.
 *
 * The diff runs during render so a brand-new row carries its class on its first paint
 * (a class added in an effect would show one un-animated frame first). The baseline is
 * only advanced in an effect, which keeps the result identical across StrictMode's
 * double render and across re-renders that change nothing about the list.
 *
 * `resetKey` (default a constant, i.e. never resets beyond the initial mount) opts a caller
 * into #9's remount rule: whenever it changes, `fresh` is cleared and the baseline snaps to
 * `ids` outright, so a surface that just remounted shows no stale arrivals — see
 * `nextBaseline`.
 */
export function useNewIds(ids: readonly ItemId[], ready = true, resetKey: unknown = true): ReadonlySet<ItemId> {
  const seen = useRef<Set<ItemId> | null>(null);
  const fresh = useRef(new Map<ItemId, number>());
  const lastReset = useRef<unknown>(Symbol("unset"));

  const now = Date.now();
  for (const [id, expires] of fresh.current) if (expires <= now) fresh.current.delete(id);
  if (lastReset.current !== resetKey) fresh.current.clear();
  const base = nextBaseline(seen.current, ready, resetKey, lastReset.current, () => new Set(ids));
  if (base && ready) {
    for (const id of ids) if (!base.has(id) && !fresh.current.has(id)) fresh.current.set(id, now + ENTER_MS);
  }

  const key = ids.join(" ");
  useEffect(() => {
    // Stay un-baselined until the data has arrived, so the empty list a component
    // renders while its first fetch is in flight is not read as "nothing was there",
    // which would animate the whole list in at once.
    if (ready) seen.current = new Set(ids);
    // `key` is the identity of the list; `ids` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  useEffect(() => {
    lastReset.current = resetKey;
  }, [resetKey]);

  const out = new Set<ItemId>();
  if (ready) for (const id of ids) if (fresh.current.has(id)) out.add(id);
  return out;
}

/** `className` for a row that should ease in when it is new. */
export const enterClass = (isNew: boolean) => (isNew ? " enter" : "");

/** Gap between one arriving row and the next, and how many of them keep their own place in
 *  the queue. Five rows landing together read as one block; five landing 30ms apart read as
 *  five. Past the cap the tail would just be waiting, so it lands with row eight. */
export const STAGGER_MS = 30;
export const STAGGER_CAP = 8;
/** The boards landing runs the same entrance 1.3x slower, stagger and duration together —
 *  the human's read of the original was "a little quick but nice". The duration half lives
 *  in styles.css as `calc(var(--d-base) * 1.3)`; this is the stagger half of the same 1.3.
 *  Only the landing is slowed: inside a board a stagger is what made the switch feel janky
 *  (see `useEntranceIds`), so there is nothing left there to slow down. */
export const STAGGER_SLOW_MS = Math.round(STAGGER_MS * 1.3);

/**
 * Where each new id sits in the queue of *new* rows, in the order the list renders them.
 * Rows that are not new are absent. Pure, so the stagger can be tested without a DOM.
 */
export function enterOrders(ids: readonly ItemId[], newIds: ReadonlySet<ItemId>): Map<ItemId, number> {
  const out = new Map<ItemId, number>();
  let n = 0;
  for (const id of ids) if (newIds.has(id)) out.set(id, n++);
  return out;
}

/** The `style` an arriving row wears to take its turn, or nothing for the first row and for
 *  rows that are not new. `stagger` lets one surface pace itself differently — the boards
 *  landing passes `STAGGER_SLOW_MS`; everything else takes the default. */
export function enterDelay(order: number | undefined, stagger = STAGGER_MS): CSSProperties | undefined {
  if (!order) return undefined;
  return { animationDelay: `${Math.min(order, STAGGER_CAP - 1) * stagger}ms` };
}

/**
 * The ids present the first time this hook runs for a given `resetKey` — typically what
 * identifies the screen currently on show. Held for `ENTER_MS` from that transition, then
 * empty for every render after, refetches included. Distinct from `useNewIds`, which marks
 * *arrivals after* a baseline: this marks the baseline itself, so a fresh screen's rows can
 * stagger in once when it appears and sit still through everything a later SSE refetch does
 * to it, then stagger in again the next time `resetKey` changes — a reader landing on the
 * screen again, or a component that simply remounts on its own (the default `resetKey` of
 * `true` is enough there: mount is the only time `lastKey` can differ from it).
 *
 * Only the boards landing uses this. It was applied to the in-board tabs too, and that is
 * what the human read as jank: a per-row stagger is by construction a promise to show the
 * reader nothing for as long as it runs, and inside a board it ran *under* the pane's own
 * `tab-pane-in` crossfade, so the two opacities multiplied and the pane was still blank
 * ~90ms after the tap and not settled for ~500ms. Worse in Channel and Activity, which are
 * pinned to the bottom: the rows on screen are the tail of the list, which is exactly what a
 * top-down stagger delays longest, and past `STAGGER_CAP` they all landed together as one
 * slab. A tab switch now crossfades the whole pane at once (`.tab-in-*`, styles.css) and
 * stages no rows at all. The landing keeps the stagger — it is a top-anchored list the
 * reader arrives at rather than flicks between, so the pacing reads as arrival, not lag —
 * at `STAGGER_SLOW_MS`.
 *
 * Mirrors `useNewIds`' `fresh` map, not a plain "have we committed this key yet" boolean,
 * for the same reason that hook uses one: a single click can cascade through several
 * synchronous renders of this component (a hash change, the route recomputing, a parent
 * re-render) with React flushing this hook's own effect in between them, so a boolean
 * gate flipped only in that effect can read as "already committed" before the row it
 * describes has ever reached the screen. Time, not commit count, is what a class flashing
 * in and back out again — or never appearing at all — cannot outrun: once an id lands in
 * `fresh` it stays there, and every render (however many happen) agrees, until its own
 * timer says otherwise.
 */
export function useEntranceIds<T extends ItemId>(ids: readonly T[], resetKey: unknown = true): ReadonlySet<T> {
  const lastKey = useRef<unknown>(Symbol("unset"));
  const fresh = useRef(new Map<T, number>());

  const now = Date.now();
  for (const [id, expires] of fresh.current) if (expires <= now) fresh.current.delete(id);
  if (lastKey.current !== resetKey) {
    for (const id of ids) fresh.current.set(id, now + ENTER_MS);
  }

  useEffect(() => {
    lastKey.current = resetKey;
  }, [resetKey]);

  const out = new Set<T>();
  for (const id of ids) if (fresh.current.has(id)) out.add(id);
  return out;
}

/* ---------- section moves ---------- */

/**
 * The ids whose section changed between two commits. An id absent from either side is an
 * arrival or a departure, not a move, and is left to the enter animation instead.
 *
 * Pure and exported so the move rule can be tested without a DOM.
 */
export function movedIds(prev: ReadonlyMap<ItemId, string> | null, next: ReadonlyMap<ItemId, string>): Set<ItemId> {
  const out = new Set<ItemId>();
  if (!prev) return out;
  for (const [id, section] of next) {
    const was = prev.get(id);
    if (was !== undefined && was !== section) out.add(id);
  }
  return out;
}

/** How long a moved card keeps its `.moved` class. It has to outlast both the FLIP flight
 *  (which asks the class whether to dip the card as it crosses) and the arrival animations
 *  in styles.css — `card-pop` at `--d-base` and the 300ms `card-moved` tint that follows it
 *  — and no longer: the class is also what tells the Needs-you heading a card has just
 *  landed in it. Derived from `D_BASE`, not a flat literal, so it can't quietly disagree
 *  with the CSS arrival it is timed to outlast again (that mismatch — 500 against a real
 *  520ms — is what B9 in critique #17 found). */
const MOVE_MS = D_BASE + 300;

/**
 * The ids that changed section since the previous commit, held for `MOVE_MS` so the
 * highlight outlives the render that noticed it. Mirrors `useNewIds`: the diff runs during
 * render so the class lands on the first paint, and the baseline advances in an effect,
 * which keeps StrictMode's double render idempotent.
 *
 * `resetKey` carries the same remount rule as `useNewIds`: a changed key snaps the baseline
 * to `entries` outright and drops anything still ticking down in `fresh`, so a card that
 * changed section while the surface was unmounted does not tint on return — see
 * `nextBaseline` and the design note at scratchpad/flock/8.md §1.1.
 */
export function useMovedIds(entries: readonly (readonly [ItemId, string])[], ready = true, resetKey: unknown = true): ReadonlySet<ItemId> {
  const seen = useRef<Map<ItemId, string> | null>(null);
  const fresh = useRef(new Map<ItemId, number>());
  const lastReset = useRef<unknown>(Symbol("unset"));

  const now = Date.now();
  for (const [id, expires] of fresh.current) if (expires <= now) fresh.current.delete(id);
  if (lastReset.current !== resetKey) fresh.current.clear();
  const next = new Map(entries);
  const base = nextBaseline(seen.current, ready, resetKey, lastReset.current, () => next);
  if (ready) for (const id of movedIds(base, next)) fresh.current.set(id, now + MOVE_MS);

  const key = entries.map(([id, s]) => `${id}:${s}`).join(" ");
  useEffect(() => {
    if (ready) seen.current = new Map(entries);
    // `key` is the identity of the list; `entries` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  useEffect(() => {
    lastReset.current = resetKey;
  }, [resetKey]);

  const out = new Set<ItemId>();
  if (ready) for (const [id] of entries) if (fresh.current.has(id)) out.add(id);
  return out;
}

/* ---------- quiet live signal ---------- */

/** The desktop pane surfaces that can grow while the reader is looking at a different one.
 *  Decisions already carries its own "has any at all" dot (BoardView.tsx); this is the
 *  other half — "grew since you last looked" — for the two panes that always have
 *  something in them and so can never use that rule. */
export type PaneKey = "channel" | "activity";

/**
 * Which panes grew since the last time each was the one showing. Pure, so the rule (grow
 * while elsewhere, clear on arrival) can be tested without a DOM.
 *
 * `prev` is `null` only before the first real count has landed, which must diff to nothing
 * — otherwise a cold snapshot's own message and event counts would light both dots on the
 * very first paint, exactly the "announces a change you did not cause" critique #17 B11
 * is about, aimed instead at a change that never happened.
 */
export function paneGrowth(counts: Readonly<Record<PaneKey, number>>, active: PaneKey | null, prev: Readonly<Record<PaneKey, number>> | null, grew: ReadonlySet<PaneKey>): Set<PaneKey> {
  const out = new Set(grew);
  if (active) out.delete(active);
  if (prev) for (const k of Object.keys(counts) as PaneKey[]) if (k !== active && counts[k] > prev[k]) out.add(k);
  return out;
}

/**
 * `usePaneGrowth` mirrors `useNewIds`: the diff (and the immediate clear for the pane now
 * showing) runs during render so the dot's first paint is already correct, and the count
 * baseline only advances in an effect, which keeps StrictMode's double render idempotent.
 */
export function usePaneGrowth(counts: Readonly<Record<PaneKey, number>>, active: PaneKey | null, ready = true): ReadonlySet<PaneKey> {
  const seen = useRef<Record<PaneKey, number> | null>(null);
  const grew = useRef<Set<PaneKey>>(new Set());

  if (ready) grew.current = paneGrowth(counts, active, seen.current, grew.current);

  const key = `${active}:${counts.channel}:${counts.activity}`;
  useEffect(() => {
    if (ready) seen.current = counts;
    // `key` is the identity of (active pane, both counts); `counts` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  return grew.current;
}

/* ---------- FLIP ---------- */

/** `--d-flip`, mirrored via `motion.ts`: long enough to read as travel between sections,
 *  short enough not to feel slow. Set on an inline style rather than a class because the
 *  FLIP computes its own start transform per node. */
const FLIP_MS = D_FLIP;
/** `--ease-out`, mirrored via `motion.ts`, for the same reason. */
const FLIP_EASE = EASE_OUT;

/**
 * FLIP over a container: every `[data-flip]` descendant that ends a commit somewhere other
 * than it started glides there from its old place.
 *
 * Positions are keyed by the `data-flip` attribute, not by node identity, because a card
 * that changes status unmounts from one section and mounts in another — the node is new,
 * the card is not. They are measured relative to the container's own scrolled content, so
 * scrolling is not mistaken for movement.
 *
 * Returns a callback ref, so it re-binds when the container is replaced by a tab switch.
 */
/** The translation a node is currently rendered with, or zero. */
function offsetOf(node: HTMLElement): { x: number; y: number } {
  if (!node.style.transform) return { x: 0, y: 0 };
  const t = getComputedStyle(node).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  try {
    const m = new DOMMatrixReadOnly(t);
    return { x: m.m41, y: m.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * Whether a batch of moves should actually animate. False for a hidden tab — Chrome pauses
 * rAF there, so the release that undoes the FLIP inversion (see `useFlip`) would never run
 * and a later commit could strand a card mid-flight. Pure so it can be tested without a DOM,
 * mirroring `shouldRepin`.
 */
export function shouldAnimateFlip(args: { enabled: boolean; reduced: boolean; hidden: boolean; moveCount: number }): boolean {
  const { enabled, reduced, hidden, moveCount } = args;
  return enabled && !reduced && !hidden && moveCount > 0;
}

/**
 * The FLIP deltas for this commit: for every id present in both `prev` and `now`, how far it
 * moved. `remounted` suppresses the diff entirely regardless of what `prev` holds — a
 * container remount (the phone Cards pane returning after a tab switch, which unmounts and
 * remounts the `[data-flip]` container along with it) means `prev`'s positions belonged to a
 * container that is gone. Diffing against them would fly cards from wherever they sat the
 * last time the surface was visible rather than from anywhere the reader actually saw, which
 * is the accidental half-replay #9 exists to remove — see the design note at
 * scratchpad/flock/8.md §1.2. Pure so the remount rule is testable without a DOM; the ≥1px
 * slop mirrors what the caller already tolerates as "did not actually move".
 */
export function flipDeltas(
  prev: ReadonlyMap<string, { x: number; y: number }> | null,
  now: ReadonlyMap<string, { x: number; y: number }>,
  remounted: boolean,
): { id: string; dx: number; dy: number }[] {
  if (remounted || !prev) return [];
  const out: { id: string; dx: number; dy: number }[] = [];
  for (const [id, at] of now) {
    const before = prev.get(id);
    if (!before) continue;
    const dx = before.x - at.x;
    const dy = before.y - at.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    out.push({ id, dx, dy });
  }
  return out;
}

export function useFlip(key: unknown, enabled = true): (el: HTMLElement | null) => void {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const prev = useRef(new Map<string, { x: number; y: number }>());
  // The container node this hook last measured against. A tab switch unmounts and remounts
  // the whole `[data-flip]` container (it sits inside a pane keyed on `tab`), so a fresh
  // identity here is the signal that `prev` is stale, not a diffable baseline — see
  // `flipDeltas`.
  const mountedBox = useRef<HTMLElement | null>(null);
  const timers = useRef(new Map<string, number>());
  // Nodes currently holding an inverted transform + `.flipping` that has not yet been
  // released. Anything left in here when the tab hides, the effect re-runs, or the hook
  // unmounts must be released explicitly — see the note on `release` below.
  const inverted = useRef(new Map<string, HTMLElement>());

  const release = useCallback((id: string, node: HTMLElement) => {
    node.style.transition = "";
    node.style.transform = "";
    node.classList.remove("flipping");
    if (inverted.current.get(id) === node) inverted.current.delete(id);
  }, []);

  const releaseAll = useCallback(() => {
    for (const [id, node] of inverted.current) release(id, node);
  }, [release]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) window.clearTimeout(id);
      t.clear();
      releaseAll();
    };
  }, [releaseAll]);

  // A tab going hidden mid-flight is exactly the case rAF cannot be trusted to release, so
  // release proactively rather than leaving it stranded until some later commit's cleanup.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [releaseAll]);

  useLayoutEffect(() => {
    if (!box) return;
    // A new container identity — the very first mount, or one that replaced an earlier node
    // that unmounted while this hook stayed alive — means `prev` and any pending inversions
    // belong to a mount that is gone. Forget the bookkeeping; `flipDeltas` below is what
    // actually suppresses the diff for this pass.
    const remounted = mountedBox.current !== box;
    if (remounted) {
      inverted.current.clear();
      for (const t of timers.current.values()) window.clearTimeout(t);
      timers.current.clear();
      mountedBox.current = box;
    }
    const nodes = Array.from(box.querySelectorAll<HTMLElement>("[data-flip]"));
    const origin = box.getBoundingClientRect();
    const now = new Map<string, { x: number; y: number }>();
    const nodeById = new Map<string, HTMLElement>();
    for (const node of nodes) {
      const id = node.dataset.flip;
      if (!id) continue;
      const r = node.getBoundingClientRect();
      // Subtract any transform still running, so a node caught mid-flight is measured at
      // its resting place rather than wherever this frame of its animation has it.
      const t = offsetOf(node);
      const at = { x: r.left - origin.left + box.scrollLeft - t.x, y: r.top - origin.top + box.scrollTop - t.y };
      now.set(id, at);
      nodeById.set(id, node);
    }
    const deltas = flipDeltas(prev.current, now, remounted);
    prev.current = now;
    const moves = deltas.flatMap(({ id, dx, dy }) => {
      const node = nodeById.get(id);
      return node ? [{ node, id, dx, dy }] : [];
    });
    // A hidden tab cannot be trusted to run the rAF release, so it simply snaps to the new
    // layout instead of starting an inversion nothing will undo.
    if (!shouldAnimateFlip({ enabled, reduced: reducedMotion(), hidden: document.visibilityState === "hidden", moveCount: moves.length })) return;

    for (const { node, id, dx, dy } of moves) {
      const pending = timers.current.get(id);
      if (pending) window.clearTimeout(pending);
      // A node still holding a previous, un-released inversion for this id (the same-frame
      // race two commits can hit) is released before it is re-inverted.
      const stranded = inverted.current.get(id);
      if (stranded && stranded !== node) release(id, stranded);
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      node.classList.add("flipping");
      inverted.current.set(id, node);
    }
    // Two frames: one for the browser to take the inverted position as the start.
    let started = false;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        started = true;
        for (const { node, id } of moves) {
          node.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
          node.style.transform = "";
          // A card that changed status dips as it crosses, so it reads as leaving one
          // section and arriving in another rather than sliding across the page. Its
          // neighbours, which only reflowed, stay solid. `moved` is set by the caller.
          if (node.classList.contains("moved")) {
            node.animate([{ opacity: 1 }, { opacity: 0.3, offset: 0.45 }, { opacity: 1 }], { duration: FLIP_MS, easing: "ease-in-out" });
          }
          timers.current.set(
            id,
            window.setTimeout(() => {
              timers.current.delete(id);
              release(id, node);
            }, FLIP_MS + 40),
          );
        }
      });
    });
    // If this effect is cleaned up before the inner rAF has run — a hidden tab pausing rAF,
    // then a later `key` change — the inversion must still be released here, not just have
    // its frame cancelled, or the node is left stranded mid-flight. Once the inner rAF has
    // fired, the transition is under way and its own timer will release it as before —
    // cancelling that here would cut a visible animation short.
    return () => {
      cancelAnimationFrame(raf);
      if (started) return;
      for (const { node, id } of moves) {
        const pending = timers.current.get(id);
        if (pending) {
          window.clearTimeout(pending);
          timers.current.delete(id);
        }
        if (inverted.current.get(id) === node) release(id, node);
      }
    };
  }, [key, box, enabled, release]);

  return setBox;
}

/* ---------- replay on return (#10) ---------- */

/**
 * The minimal "while you were away" replay from the design note at scratchpad/flock/8.md §8:
 * on returning to the phone Cards pane after remote changes landed elsewhere, paint the frame
 * the pane last showed for one beat, then advance to the live one, so the existing FLIP flight
 * and moved/new tint — not a second animation system — carry each changed card from where the
 * reader left it to where it is now. Deliberately *not* the design note's rejected full
 * ordered stepwise replay: a frame is diffed against a frame, never against the event log, so
 * "todo -> doing -> done" while away is one net move for free, with no domain rules (core's
 * status transitions) duplicated in the web package.
 *
 * The pure decisions below (what changed, whether to replay at all, and whether to compress to
 * a tint) are exported and tested without a DOM; `BoardView` owns the stateful shell — the
 * timer that holds the old frame for `REPLAY_HOLD_MS` before swapping, and aborting on a live
 * event or user input — because that shell is tightly coupled to its own remount signal
 * (`cardsMountKey`, #9) and container (`useFlip`'s box identity), not something this module can
 * own generically.
 */

/** The placement frame a surface last painted: which status each card was showing under, and
 *  when. Kept in module scope (see `saveReplayFrame` below), not component state, because it
 *  must survive the phone Cards pane unmounting on a tab switch while `BoardView` itself stays
 *  mounted — and must NOT survive a reload, which a module-level (not persisted) map already
 *  gives for free. */
export interface ReplayFrame {
  /** The snapshot seq in effect when this frame was painted — the watermark that events are
   *  diffed against for the own-writes gate, distinct from the live stream's own seq. */
  seq: number;
  at: number;
  placements: ReadonlyMap<ItemId, CardStatus>;
  /** Set once the document went hidden at any point since this frame was saved — an app
   *  backgrounding, not a tab switch, per the design note's recommendation (§5, §8) to replay
   *  only for the latter. */
  backgrounded: boolean;
}

const replayFrames = new Map<string, ReplayFrame>();

/** Record the frame a surface just painted, keyed by whatever identifies it to the caller
 *  (a board ref is enough here — the surface this ships for, the phone Cards pane, only ever
 *  shows one board at a time). Call this continuously while the surface is mounted and visible;
 *  the last call before it stops is what a later `peekReplayFrame`/`takeReplayFrame` sees. */
export function saveReplayFrame(key: string, seq: number, placements: ReadonlyMap<ItemId, CardStatus>): void {
  replayFrames.set(key, { seq, at: Date.now(), placements: new Map(placements), backgrounded: false });
}

/** Mark whatever frame is currently saved for `key` as having lived through a backgrounding.
 *  A no-op if nothing is saved — nothing to invalidate. */
export function markReplayBackgrounded(key: string): void {
  const e = replayFrames.get(key);
  if (e) e.backgrounded = true;
}

/** The saved frame for `key`, or null if the surface has never painted one (first load) or it
 *  was already consumed. Does not clear it — used by a planner that may run more than once
 *  against the same frame before the caller decides to consume it. */
export function peekReplayFrame(key: string): ReplayFrame | null {
  return replayFrames.get(key) ?? null;
}

/** Consume the saved frame for `key`: once a remount has planned its replay off it, the frame
 *  must not be replayed again by a second remount (board -> Home -> board, or a second tab
 *  round trip) without a fresh absence to justify it. */
export function takeReplayFrame(key: string): ReplayFrame | null {
  const e = replayFrames.get(key) ?? null;
  replayFrames.delete(key);
  return e;
}

/** Types whose `data` can change a card's section (see the design note §2). Everything else —
 *  comments, messages, decisions, `card.updated` — never moves a card and so is irrelevant to
 *  both the "anything changed" and "own writes only" gates below. */
const REPLAY_PLACEMENT_EVENTS = new Set(["card.created", "card.moved", "card.closed", "card.claimed", "card.released", "card.asked", "card.answered"]);

export type ReplayEventLike = Pick<Event, "seq" | "type" | "actor">;

/** How long the pane holds the pre-absence frame before advancing to the live one — the #5
 *  pane crossfade's own duration, so the swap lands just as the crossfade has settled rather
 *  than mid-fade. */
export const REPLAY_HOLD_MS = D_BASE;
/** How long a compressed tint (the over-budget case) holds — mirrors `.moved`'s own
 *  `card-moved` half without the `card-pop` spring, since nothing travelled. */
export const REPLAY_TINT_MS = 300;
/** More cards than this and the reader is watching a machine, not reading a board — compress
 *  to a tint instead (design note §4). */
export const REPLAY_MAX_CARDS = 3;
/** Absences longer than this are "the board is simply the board" (design note §5) — coming
 *  back after lunch should never replay. */
export const REPLAY_MAX_ABSENCE_MS = 5 * 60 * 1000;
/** Under the card's own 1.5s ceiling (design note §4): the hold costs a paint before the FLIP
 *  clock even starts. */
export const REPLAY_MAX_TOTAL_MS = 1200;

/** A rough cost estimate for the "would this take too long" cap: the hold, one FLIP flight and
 *  the moved tint (which run together, not staggered, for the cards in one beat), plus the same
 *  per-card slack the arrival stagger already charges for a burst — a defensive second cap
 *  alongside `REPLAY_MAX_CARDS`, since a beat is one simultaneous flight rather than the design
 *  note's rejected sequential replay. */
export function replayEstimatedMs(changedCount: number): number {
  if (changedCount <= 0) return 0;
  return REPLAY_HOLD_MS + D_FLIP + MOVE_MS + STAGGER_MS * (changedCount - 1);
}

/**
 * The ids whose status differs between two placement frames, or that are new in `after` (a
 * card `before` never saw — created while the reader was away). A card absent from `after`
 * (deleted, or filtered out of the snapshot entirely) is not counted; there is nothing to
 * replay for it.
 *
 * Pure, and the one place the design note's "coalesce per card" rule (§4) actually lives: a
 * card that moved `todo -> doing -> done` while the pane was away is diffed as one change, not
 * two, for free, because this only ever compares two frames, never the event log in between.
 */
export function replayChangedCards(before: ReadonlyMap<ItemId, CardStatus>, after: ReadonlyMap<ItemId, CardStatus>): Set<ItemId> {
  const out = new Set<ItemId>();
  for (const [id, status] of after) {
    const was = before.get(id);
    if (was === undefined || was !== status) out.add(id);
  }
  return out;
}

/**
 * Whether every placement-changing event since `sinceSeq` was authored by the reader
 * themselves. Replaying a reader's own move back at them is the single most annoying version
 * of this feature and also the most likely one: tap a card, move it, flick back to Cards.
 * `events` need only be a tail that covers `(sinceSeq, ...]` — anything older or irrelevant
 * (a different type, an equal-or-earlier seq) is filtered out here, so a caller can hand over
 * its whole in-memory event list without pre-filtering it.
 */
export function replayIsOwnWritesOnly(events: readonly ReplayEventLike[], sinceSeq: number, actorName: string): boolean {
  const relevant = events.filter((e) => e.seq > sinceSeq && REPLAY_PLACEMENT_EVENTS.has(e.type));
  return relevant.length > 0 && relevant.every((e) => e.actor === actorName);
}

export type ReplayPlan =
  | { kind: "none" }
  | { kind: "tint"; ids: ReadonlySet<ItemId> }
  | { kind: "beat"; ids: ReadonlySet<ItemId>; before: ReadonlyMap<ItemId, CardStatus> };

export interface PlanReplayArgs {
  /** The frame the pane last painted, or null on a first load / a board that just navigated
   *  to — either way, nothing to diff against. */
  before: ReplayFrame | null;
  /** The live snapshot's placements, as of the remount. */
  after: ReadonlyMap<ItemId, CardStatus>;
  now: number;
  /** `prefers-reduced-motion: reduce` — no replay, and no compressed tint either (design note
   *  §5): a tint the reader did not ask for is still an announcement. */
  reduced: boolean;
  /** The events covering `(before.seq, ...]`; only used for the own-writes gate. */
  events: readonly ReplayEventLike[];
  actorName: string;
}

/**
 * What the Cards pane should do on remount, given the frame it last painted and the live
 * snapshot it is remounting onto. Pure — no DOM, no timers — so every gate and the coalescing
 * rule are unit-testable on their own; the stateful shell (the hold timer, the abort listeners)
 * belongs to `BoardView`, which is what actually owns the remount and the container FLIP
 * measures.
 */
export function planReplay({ before, after, now, reduced, events, actorName }: PlanReplayArgs): ReplayPlan {
  if (!before) return { kind: "none" };
  if (reduced) return { kind: "none" };
  if (before.backgrounded) return { kind: "none" };
  if (now - before.at > REPLAY_MAX_ABSENCE_MS) return { kind: "none" };

  const changed = replayChangedCards(before.placements, after);
  if (changed.size === 0) return { kind: "none" };
  if (replayIsOwnWritesOnly(events, before.seq, actorName)) return { kind: "none" };

  if (changed.size > REPLAY_MAX_CARDS || replayEstimatedMs(changed.size) > REPLAY_MAX_TOTAL_MS) {
    return { kind: "tint", ids: changed };
  }
  return { kind: "beat", ids: changed, before: before.placements };
}

/**
 * The cards a surface should paint for one commit of a replay beat: everything the frame knew
 * about, wearing the status it had then, in the same order the live list has them; a card the
 * frame never saw (created while the reader was away) is left out entirely, so it plays its
 * ordinary `.enter` arrival once the beat swaps to the live frame instead of popping into an
 * old section it was never in. `frame` null means "no replay in progress" and returns `cards`
 * unchanged — the common case on every render that is not the one or two commits of a beat.
 *
 * Pure and generic over the card shape so it is testable without the web app's full `Card`
 * type.
 */
export function applyReplayFrame<C extends { id: ItemId; status: CardStatus }>(cards: readonly C[], frame: ReadonlyMap<ItemId, CardStatus> | null): C[] {
  if (!frame) return cards as C[];
  const out: C[] = [];
  for (const c of cards) {
    const was = frame.get(c.id);
    if (was === undefined) continue;
    out.push(was === c.status ? c : ({ ...c, status: was } as C));
  }
  return out;
}

/* ---------- stick to bottom ---------- */

const BOTTOM_SLACK_PX = 80;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A smooth scroll is considered finished once this long passes with no scroll event. */
const SETTLE_MS = 120;

/**
 * Whether a content-growth event (e.g. a ResizeObserver callback) should re-pin the pane to
 * the bottom. Pure so the guard matrix — the exact property the scroll fix depends on — can
 * be tested without a DOM: never touch the pane unless the reader was already stuck to the
 * bottom and we are not mid-animation (the settle handler owns that case), and even then only
 * if the pane is actually short of the bottom by more than a pixel of slop.
 */
export function shouldRepin(args: { stuck: boolean; animating: boolean; scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  const { stuck, animating, scrollTop, scrollHeight, clientHeight } = args;
  if (!stuck || animating) return false;
  return scrollHeight - scrollTop - clientHeight > 1;
}

/**
 * Whether a scroll event is the echo of a pin we just performed rather than the reader
 * moving. Assigning `scrollTop` dispatches a scroll event asynchronously, and it can be
 * delivered *after* content has grown underneath it (a "Show more" toggle appearing once
 * its clamp is measured, a late image). The handler would then read a large distance from
 * a position it set itself, conclude the reader had scrolled away, and refuse the re-pin
 * that the growth was supposed to trigger — leaving the pane short of the bottom. Pure so
 * the guard can be tested without a DOM, mirroring `shouldRepin`.
 */
export function isSelfScroll(args: { expected: number; scrollTop: number }): boolean {
  return args.expected >= 0 && args.scrollTop === args.expected;
}

export interface StickToBottom<T extends HTMLElement> {
  ref: RefObject<T>;
  onScroll: () => void;
  /** Items appended while the reader was scrolled away from the bottom. */
  pending: number;
  toBottom: () => void;
  /** Claim the bottom regardless of where the reader was scrolled to, and land there
   *  instantly (never the smooth `toBottom` flight) — for an own optimistic send (#31),
   *  which always jumps the reader down rather than counting itself into `pending`.
   *  Call it before the row that earns the jump is added to `ids`, so the layout effect
   *  that runs once it lands sees `stuck` already true. */
  stick: () => void;
  /** Whether the reader is currently within `slack` of the bottom — the same notion this
   *  hook already tracks internally to decide whether to re-pin on growth, exposed as a
   *  ref (rather than state) so a scroll-rate consumer (`useScrollCollapse`, #4) can read it
   *  every frame without forcing a React re-render. */
  atBottom: RefObject<boolean>;
}

/**
 * Keep a transcript pane pinned to the bottom only while the reader is already there.
 * Otherwise hold their position and count what arrived, so the caller can offer a
 * "N new" affordance instead of yanking the view.
 *
 * Takes the item ids rather than a count: both panes cap their list, so once a channel
 * passes its message limit the length stops changing while items keep arriving.
 *
 * Following an append is always an instant scroll. A smooth one would feed its own
 * scroll handler, read as the reader scrolling away, and aim at a scrollHeight that is
 * already stale by the time it lands. Only the explicit "N new" tap animates, and that
 * one suppresses the handler until it settles and then lands on the real bottom.
 */
export function useStickToBottom<T extends HTMLElement>(ids: readonly ItemId[], slack = BOTTOM_SLACK_PX): StickToBottom<T> {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const first = useRef(true);
  const seen = useRef<Set<ItemId>>(new Set());
  const animating = useRef(false);
  const settleTimer = useRef(0);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  // The scrollTop of the last pin we performed ourselves, or -1 once its echo is consumed.
  const selfScroll = useRef(-1);
  const [pending, setPending] = useState(0);

  /** Pin to the bottom and remember where we landed, so the echoing scroll event is known. */
  const pinToBottom = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    selfScroll.current = el.scrollTop;
  }, []);

  const settle = useCallback(() => {
    animating.current = false;
    const el = ref.current;
    if (!el) return;
    // Anything that arrived mid-flight moved the target; land on where the bottom is now.
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) pinToBottom(el);
    stuck.current = true;
    setPending(0);
  }, [pinToBottom]);

  const armSettle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, SETTLE_MS);
  }, [settle]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (animating.current) {
      // Our own scroll, not the reader's. Every frame pushes the settle check out.
      armSettle();
      return;
    }
    if (isSelfScroll({ expected: selfScroll.current, scrollTop: el.scrollTop })) {
      // Our own pin coming back to us. Consume it once and leave `stuck` alone; the
      // ResizeObserver re-pins onto whatever the content grew to.
      selfScroll.current = -1;
      return;
    }
    selfScroll.current = -1;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuck.current = distance <= slack;
    if (stuck.current) setPending(0);
  }, [slack, armSettle]);

  useEffect(() => {
    return () => {
      window.clearTimeout(settleTimer.current);
      resizeObserver.current?.disconnect();
    };
  }, []);

  // Content (e.g. a late-sizing image) can grow the pane after the initial pin. Re-pin
  // only while the reader is still stuck and we are not mid-animation, so a reader who
  // has scrolled up is never yanked down.
  const repinOnGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (!shouldRepin({ stuck: stuck.current, animating: animating.current, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })) return;
    pinToBottom(el);
  }, [pinToBottom]);

  // Keyed on the last id: with a capped list the length goes still, but the tail moves.
  const tail = ids.length ? ids[ids.length - 1] : null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let added = 0;
    for (const id of ids) if (!seen.current.has(id)) added++;
    seen.current = new Set(ids);

    // Re-observe: the container for shrinkage (e.g. composer growing) and its direct
    // children for growth (e.g. an image sizing up) so newly rendered messages are covered.
    // This runs even while an "N new" smooth scroll is animating — a message that lands
    // mid-animation still needs to be watched, since `.pane-scroll` is a scroll container
    // whose own content-box does not grow with content. One observer lives for the whole
    // mount; only its target list changes here. Only the pin itself is gated on `animating`.
    if (typeof ResizeObserver !== "undefined") {
      if (!resizeObserver.current) resizeObserver.current = new ResizeObserver(repinOnGrow);
      const ro = resizeObserver.current;
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    }

    if (animating.current) return; // The settle handler will land on the true bottom.
    if (stuck.current) {
      pinToBottom(el);
      first.current = false;
      setPending(0);
    } else if (added > 0 && !first.current) {
      setPending((p) => p + added);
    }
    // `tail` is the identity of the list's end; `ids` is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail]);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = true;
    setPending(0);
    if (reducedMotion()) {
      pinToBottom(el);
      return;
    }
    animating.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    armSettle();
  }, [armSettle, pinToBottom]);

  const stick = useCallback(() => {
    stuck.current = true;
    animating.current = false;
    setPending(0);
    const el = ref.current;
    if (el) pinToBottom(el);
  }, [pinToBottom]);

  return { ref, onScroll, pending, toBottom, stick, atBottom: stuck };
}

/* ---------- minimize the composer while scrolling toward older content ---------- */

/** Distance, in px, scrolled away from the bottom over which collapse progress saturates.
 *  Measured from the first pixel of scroll rather than from the far side of a dead zone
 *  (#6: "it seems like the effect doesn't start until x amount of scrolling happens"), so
 *  this is the whole travel, not the second half of it. 120px puts a little under half a
 *  pixel of composer height on every pixel of drag — the first 20px of a thumb move is
 *  already ~9px of visible change, and a short drag finishes the morph. */
const SCROLL_COLLAPSE_RANGE_PX = 120;

/** How close to the bottom still counts as "at the bottom" for forcing the composer full.
 *  Deliberately tiny (#6). `useStickToBottom`'s own 80px slack is the right band for
 *  deciding whether to *re-pin on growth*, but using it here meant the first 80px of every
 *  scroll away from the bottom did nothing at all. This only has to absorb sub-pixel scroll
 *  positions and rounding; the mapping below covers everything past it. */
const AT_BOTTOM_EPS_PX = 4;

/** Where the *structural* flip fires (attach button and mode row unmounting,
 *  `.line-composer`'s mobile flex-wrap flipping to `nowrap`) — the "snap the wrap late" the
 *  human chose on #4. Both ends sit at the very end of the range, so `collapsed` is a pure
 *  function of progress (`>= 1`) and the flip therefore happens at the identical position
 *  scrolling either way. `ON` is 1 rather than a few percent short (#6) because the
 *  continuous rules are shaped so that at progress exactly 1 the composer already *is* the
 *  resting look to the pixel — same height, send on the same row at the same size, attach
 *  scaled to nothing — so flipping there moves nothing at all.
 *
 *  There is deliberately no hysteresis band any more (#7). The band it used to carry (0.9)
 *  froze the composer at its resting height for the last 12px of scroll on the way *out*
 *  and then stepped ~5px, which is an asymmetry between the two directions for no
 *  benefit — the flicker it guarded against needed a noise source, and the only one there
 *  ever was (the composer's own resize feeding back into `scrollHeight`) is gone by
 *  construction since #6 froze the feed's reservation. Progress is now a clean function of
 *  scroll position, so a threshold on it is stable on its own. */
const NEAR_COLLAPSE_ON = 1;
const NEAR_COLLAPSE_OFF = 1;

/** Discrete-toggle threshold, in px past the last flip point, used only under
 *  `prefers-reduced-motion` — the original anchor-based hysteresis from #2's first pass. */
const SCROLL_COLLAPSE_PX = 24;

export interface ScrollCollapse {
  /** True once collapse progress has crossed `NEAR_COLLAPSE_ON`; false again once it has
   *  dropped back below `NEAR_COLLAPSE_OFF`. Feeds `LineComposer`'s `compact` prop — the
   *  structural (non-continuous) part of the collapse. Always false while `enabled` is
   *  false. */
  collapsed: boolean;
  /** Feed every scroll event on the same element `scrollRef` points at (alongside whatever
   *  else that container's `onScroll` already does — this does not replace it). rAF-throttled
   *  internally, and writes straight to `cssTarget`'s `--composer-collapse` custom property
   *  rather than React state, so a scroll frame never re-renders React. */
  onScroll: () => void;
  /** Told whenever `LineComposer`'s own expanded/collapsed state changes (focus, or
   *  non-empty draft text/staged attachments) via its `onExpandedChange`. While expanded for
   *  that reason, collapse progress is pinned at 0 (full size) regardless of scroll —
   *  `LineComposer` already forces its *structural* expansion in that case; this keeps the
   *  continuous CSS var in step with it. */
  setExpandedOverride: (expanded: boolean) => void;
}

/**
 * Drives the channel composer's scroll-to-minimize (mobile only): a continuous 0..1 progress
 * — 0 the full composer, 1 the card-detail composer's resting look — set as a CSS custom
 * property (`--composer-collapse`) on `cssTarget` directly (not React state), so scrolling
 * slowly morphs the chin at the same rate the reader scrolls, and scrolling back morphs it
 * straight back, without a React re-render on every frame. Progress saturates over
 * `SCROLL_COLLAPSE_RANGE_PX` of distance scrolled away from the bottom.
 *
 * Pinned-to-bottom (`atBottom`, the same notion `useStickToBottom` already tracks) always
 * forces progress to 0, regardless of scroll direction or history — arriving back at the
 * newest messages (including via a programmatic pin: an own send, the "N new" jump,
 * `useStickToBottom`'s re-pin on growth) always shows the full composer.
 *
 * The structural bits that cannot be a scalar — the attach button and mode row unmounting,
 * the mobile `.line-composer` flex-wrap flip — stay a discrete toggle (`collapsed`), flipped
 * only in the last few percent of progress (`NEAR_COLLAPSE_ON`/`OFF`), same as the card-detail
 * composer's own focus-driven compact/expanded flip already does for that boundary.
 *
 * Under `prefers-reduced-motion`, falls back to the original discrete anchor-based hysteresis
 * from #2: `--composer-collapse` jumps straight between 0 and 1 rather than tracking scroll
 * continuously.
 */
export function useScrollCollapse<T extends HTMLElement>(
  scrollRef: RefObject<T>,
  enabled: boolean,
  atBottom: RefObject<boolean>,
  cssTarget: RefObject<HTMLElement>,
): ScrollCollapse {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  collapsedRef.current = collapsed;
  const anchor = useRef(0);
  const override = useRef(false);
  const raf = useRef(0);

  const applyVar = useCallback(
    (value: number) => {
      cssTarget.current?.style.setProperty("--composer-collapse", String(value));
    },
    [cssTarget],
  );

  /** Publish the chin's *resting* height so the feed reserves that much for the whole
   *  collapse instead of following it down. Only called from the two places the composer is
   *  known to be at full height — pinned to the bottom, or held open by focus/draft — so the
   *  live `--composer-h` is the resting height by definition. `--composer-space` in
   *  styles.css takes `max()` of the two, so a value briefly left short during the composer's
   *  own re-expansion just falls through to the live height rather than clipping. */
  const learnRestingHeight = useCallback(() => {
    const el = cssTarget.current;
    if (!el) return;
    const h = el.style.getPropertyValue("--composer-h");
    if (h) el.style.setProperty("--composer-h-rest", h);
  }, [cssTarget]);

  const recompute = useCallback(() => {
    raf.current = 0;
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    if (override.current) {
      anchor.current = el.scrollTop;
      // Focus or a non-empty draft: the composer is definitely at its full height here, so
      // this is the moment to re-learn what "resting" measures (a staged image or a grown
      // draft makes it taller than it was).
      learnRestingHeight();
      applyVar(0);
      if (collapsedRef.current) setCollapsed(false);
      return;
    }

    if (reducedMotion()) {
      if (atBottom.current) {
        anchor.current = el.scrollTop;
        applyVar(0);
        if (collapsedRef.current) setCollapsed(false);
        return;
      }
      const delta = el.scrollTop - anchor.current;
      if (delta < -SCROLL_COLLAPSE_PX && !collapsedRef.current) {
        anchor.current = el.scrollTop;
        applyVar(1);
        setCollapsed(true);
      } else if (delta > SCROLL_COLLAPSE_PX && collapsedRef.current) {
        anchor.current = el.scrollTop;
        applyVar(0);
        setCollapsed(false);
      }
      return;
    }

    // Absolute distance from the bottom of the feed — not an anchor-relative delta (#5). An
    // anchor snapshot gets refreshed every time you are at the bottom or touch the field, so
    // progress measured against it tracks *accumulated movement since that moment* rather
    // than where the feed actually is: focus the composer two thousand px up in history,
    // blur, and it is fully expanded again with a whole range to scroll before it collapses.
    // That was the "isn't attached to the scroll" the human reported.
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    // At the bottom the composer is always full, whatever the history (#4) — including
    // arriving there programmatically (an own send, the "N new" jump, `useStickToBottom`'s
    // re-pin on growth), which lands exactly at `fromBottom === 0`. `reservedFull` can only
    // grow here: this branch also runs during the re-expansion that being here triggers, and
    // latching the half-grown height would leave the mapping permanently short.
    if (fromBottom <= AT_BOTTOM_EPS_PX) {
      anchor.current = el.scrollTop;
      learnRestingHeight();
      applyVar(0);
      if (collapsedRef.current) setCollapsed(false);
      return;
    }

    // Plain distance from the bottom, with no correction term — the scroll metric is not
    // self-referential any more because the feed's reservation no longer follows the
    // collapse. `--composer-h-rest` (published above, consumed by `--composer-space` in
    // styles.css) holds `.pane-scroll`'s trailing padding at the chin's resting height for
    // the whole range, so `scrollHeight` is constant across a collapse and this is a pure
    // function of where the reader is. #5 got the same invariance by subtracting the live
    // `--composer-h`, but that put the composer's entire height in front of the zero point:
    // the first ~120px of every scroll did nothing, which is what the human felt (#6).
    const distance = Math.max(0, fromBottom - AT_BOTTOM_EPS_PX);
    const progress = Math.min(1, distance / SCROLL_COLLAPSE_RANGE_PX);
    applyVar(progress);
    if (!collapsedRef.current && progress >= NEAR_COLLAPSE_ON) setCollapsed(true);
    else if (collapsedRef.current && progress < NEAR_COLLAPSE_OFF) setCollapsed(false);
  }, [enabled, scrollRef, atBottom, applyVar, learnRestingHeight]);

  useEffect(() => {
    if (!enabled) {
      setCollapsed(false);
      applyVar(0);
      cssTarget.current?.style.removeProperty("--composer-h-rest");
      return;
    }
    anchor.current = scrollRef.current?.scrollTop ?? 0;
    // Mounts pinned to the bottom with the composer full, so this is the resting height.
    learnRestingHeight();
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    if (!enabled) return;
    if (raf.current) return;
    raf.current = requestAnimationFrame(recompute);
  }, [enabled, recompute]);

  const setExpandedOverride = useCallback(
    (expanded: boolean) => {
      override.current = expanded;
      if (expanded) applyVar(0);
      else recompute();
    },
    [applyVar, recompute],
  );

  return { collapsed, onScroll, setExpandedOverride };
}

/* ---------- hold position when content lands above the viewport ---------- */

/**
 * Keep whatever the reader is looking at under their eyes when rows are inserted above it.
 * Anchors on the topmost item still visible in `ref` and re-applies its offset after commit.
 * Items are found by `[data-anchor]`, falling back to the container's direct children.
 * No-ops at the very top of the scroll, where growth above is what the reader wants to see.
 *
 * Returns a callback ref rather than taking one, so it re-binds whenever the element
 * changes. The panes it guards are mounted and unmounted by tab switches, and a listener
 * bound once would be left on a detached node after the first round trip.
 */
export function useAnchorScroll(key: unknown): (el: HTMLElement | null) => void {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const anchor = useRef<{ el: HTMLElement; offset: number; scrollTop: number } | null>(null);

  const topOf = (el: HTMLElement, within: HTMLElement) =>
    el.getBoundingClientRect().top - within.getBoundingClientRect().top + within.scrollTop;

  const capture = useCallback(() => {
    if (!box || box.scrollTop <= 0) {
      anchor.current = null;
      return;
    }
    const found = box.querySelectorAll<HTMLElement>("[data-anchor]");
    const items: HTMLElement[] = found.length ? Array.from(found) : (Array.from(box.children) as HTMLElement[]);
    for (const item of items) {
      const top = topOf(item, box);
      if (top + item.offsetHeight > box.scrollTop) {
        anchor.current = { el: item, offset: top, scrollTop: box.scrollTop };
        return;
      }
    }
    anchor.current = null;
  }, [box]);

  useEffect(() => {
    if (!box) return;
    box.addEventListener("scroll", capture, { passive: true });
    return () => box.removeEventListener("scroll", capture);
  }, [box, capture]);

  useLayoutEffect(() => {
    const a = anchor.current;
    // A stale anchor from a previous element fails `contains` and is simply dropped.
    if (box && a && box.contains(a.el)) {
      const shift = topOf(a.el, box) - a.offset;
      if (shift !== 0) box.scrollTop = a.scrollTop + shift;
    }
    capture();
  }, [key, capture, box]);

  // `setBox` is stable, so React binds it once and calls it with null on unmount.
  return setBox;
}

/* ---------- resilient event stream ---------- */

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
/** Only runs while the stream is down, and only while the page is visible. */
const POLL_MS = 10000;
/** A blip is not worth telling anyone about; a real outage is. */
const DOWN_NOTICE_MS = 4000;

export interface LiveStream {
  /** True once the stream has been down long enough to be worth a quiet indicator. */
  down: boolean;
  /** Tell the stream about a seq learned elsewhere, e.g. a snapshot's `lastSeq`. */
  noteSeq: (seq: number) => void;
}

export interface LiveStreamOptions {
  /** SSE path, e.g. `/api/stream`. Null suspends the stream. */
  path: string | null;
  /** SSE event names to listen for. */
  types: readonly string[];
  /** Called once per event, in seq order, never twice for the same seq. */
  onEvent: (e: Event) => void;
  /** Called after any batch of events, and after waking, to trigger a coalesced refetch. */
  onWake: () => void;
  /** Fetch events after `since`; used to catch up when the stream was down. */
  fetchSince: (since: number) => Promise<Event[]>;
}

/**
 * An EventSource that survives iOS backgrounding: it resumes from the last seq it saw,
 * refetches on visibilitychange/pageshow/online, reconnects with backoff when the browser
 * gives up, and polls quietly only while it is not connected.
 */
export function useLiveStream({ path, types, onEvent, onWake, fetchSince }: LiveStreamOptions): LiveStream {
  const [down, setDown] = useState(false);
  const seq = useRef(0);
  const cbs = useRef({ onEvent, onWake, fetchSince });
  cbs.current = { onEvent, onWake, fetchSince };
  const typeKey = types.join(",");

  const noteSeq = useCallback((n: number) => {
    if (n > seq.current) seq.current = n;
  }, []);

  useEffect(() => {
    if (!path) return;
    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer = 0;
    let downTimer = 0;
    let pollTimer = 0;

    const markUp = () => {
      attempt = 0;
      window.clearTimeout(downTimer);
      downTimer = 0;
      setDown(false);
      stopPolling();
    };
    const markDown = () => {
      if (!downTimer) downTimer = window.setTimeout(() => setDown(true), DOWN_NOTICE_MS);
      startPolling();
    };
    const stopPolling = () => {
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = 0;
    };
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") void catchUp();
      }, POLL_MS);
    };

    const deliver = (list: Event[]) => {
      let got = false;
      for (const e of list) {
        if (!e || typeof e.seq !== "number" || e.seq <= seq.current) continue;
        seq.current = e.seq;
        cbs.current.onEvent(e);
        got = true;
      }
      if (got) cbs.current.onWake();
    };

    const catchUp = async () => {
      // Before the first `ready` we have no seq, so asking for everything since 0 would
      // replay the whole table. A plain refetch is enough.
      if (seq.current === 0) {
        cbs.current.onWake();
        return;
      }
      try {
        deliver(await cbs.current.fetchSince(seq.current));
      } catch {
        // Offline. The next revive or poll tick tries again.
      }
    };

    const connect = () => {
      if (closed) return;
      const url = seq.current > 0 ? `${path}?since=${seq.current}` : path;
      const source = new EventSource(url);
      es = source;
      const onMessage = (ev: MessageEvent) => {
        try {
          deliver([JSON.parse(ev.data) as Event]);
        } catch {}
      };
      for (const t of types) source.addEventListener(t, onMessage as EventListener);
      source.addEventListener("ready", (ev) => {
        markUp();
        try {
          noteSeq(Number((JSON.parse((ev as MessageEvent).data) as { since: number }).since));
        } catch {}
      });
      source.onopen = markUp;
      source.onerror = () => {
        markDown();
        // readyState 2 means the browser has given up; anything else is its own retry.
        if (source.readyState !== 2) return;
        source.close();
        if (es === source) es = null;
        const wait = RECONNECT_BACKOFF_MS[Math.min(attempt++, RECONNECT_BACKOFF_MS.length - 1)];
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, wait);
      };
    };

    const revive = () => {
      if (closed) return;
      void catchUp();
      cbs.current.onWake();
      if (es && es.readyState !== 2) return;
      es?.close();
      es = null;
      attempt = 0;
      window.clearTimeout(retryTimer);
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") revive();
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", revive);
    window.addEventListener("online", revive);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", revive);
      window.removeEventListener("online", revive);
      window.clearTimeout(retryTimer);
      window.clearTimeout(downTimer);
      stopPolling();
      es?.close();
      es = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, typeKey, noteSeq]);

  return { down, noteSeq };
}

export const BOARD_EVENT_TYPES = [
  "board.created", "board.updated", "card.created", "card.updated", "card.claimed", "card.released", "card.moved",
  "card.closed", "card.blocked", "card.unblocked", "card.asked", "card.answered", "comment.posted", "message.posted",
  "decision.recorded",
] as const;

/**
 * The index shows per-board counts, last activity and who is live, so every event that
 * moves any of those has to wake it — the same list a board view watches. Bursts are
 * bounded by `useCoalescedRefetch`, so this costs one `/api/boards` call, not thirty.
 */
export const GLOBAL_EVENT_TYPES = BOARD_EVENT_TYPES;
