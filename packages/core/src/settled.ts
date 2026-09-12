import type { Event } from "./types.ts";
import { clampSettledThreshold } from "./notify-levels.ts";

// ADR 0024: the "settled" toggle. Not a property of any post — it is the *absence* of posts — so
// it is synthesized here, on the leaseholder's existing tick (ADR 0023), rather than derived from
// an event the way `levelFor` (notify-levels.ts) derives the other three. `isLooking` is injected
// the same way `NotificationBatcher` (batching.ts) takes it, so this has no dependency on
// presence.ts and can be driven by a stub clock and a stub predicate in tests.

export type SettledIsLooking = (actor: string, boardId: string) => boolean;

/** Resolves the (already-precedence-resolved) settled threshold for one (actor, board) pair. */
export type ThresholdFor = (actor: string, boardId: string) => number;

export const SETTLED_MAX_KEYS = 200;

export interface SettledFire {
  actor: string;
  boardId: string;
  /** How long the board was quiet before this fired, in ms — for the notification body. */
  quietMs: number;
}

interface KeyState {
  actor: string;
  boardId: string;
  /** When this key was last armed (an event landed, or a fresh onEvent re-armed it). */
  armedAt: number;
  /** Whether a fire has already gone out for the current arm; cleared only by a fresh arm. */
  fired: boolean;
}

/**
 * Tracks, per (recipient actor, board), how long a board has gone quiet for that recipient, and
 * decides when it has been quiet long enough to say so. Pure: no timers, no DB, nothing persisted
 * — a restart drops all state, which is the cheapest possible loss for a check-in (see the ADR's
 * "Consequences").
 *
 * Usage: `onEvent` on every event the pump processes (with the board's settled-subscribed
 * recipients), `tick` on the pump's existing interval.
 */
export class SettledTracker {
  #isLooking: SettledIsLooking;
  #thresholdFor: ThresholdFor;
  #clock: () => number;
  #maxKeys: number;
  // Nested by actor then board, matching NotificationBatcher, so keys never need to be
  // encoded/decoded from a joined string.
  #states = new Map<string, Map<string, KeyState>>();

  constructor(opts: { isLooking: SettledIsLooking; thresholdFor: ThresholdFor; clock?: () => number; maxKeys?: number }) {
    this.#isLooking = opts.isLooking;
    this.#thresholdFor = opts.thresholdFor;
    this.#clock = opts.clock ?? Date.now;
    this.#maxKeys = opts.maxKeys ?? SETTLED_MAX_KEYS;
  }

  /**
   * Arms every recipient in `recipients` for this event's board, except the event's own author —
   * a person's own last word is not a board going quiet on them. Arming clears the fired flag, so
   * a board that already fired this quiet period re-arms and can fire again after the next quiet
   * stretch. Recipients are passed in (rather than inferred) because the tracker has no notion of
   * who is settled-subscribed to a board; that lives in resolved notify settings, upstream.
   */
  onEvent(event: Event, recipients: readonly string[]): void {
    const now = this.#clock();
    for (const actor of recipients) {
      if (actor === event.actor) continue;
      this.#arm(actor, event.boardId, now);
    }
  }

  /**
   * Returns every (actor, board) whose quiet period has elapsed since it was last armed and that
   * has not already fired for this arm, marking each as fired. A key whose recipient is currently
   * looking at the board is left armed and unfired — suppressed, not dropped, so it fires as soon
   * as they look away and the tick after that finds it still quiet.
   */
  tick(now: number): SettledFire[] {
    const fires: SettledFire[] = [];
    for (const byBoard of this.#states.values()) {
      for (const state of byBoard.values()) {
        if (state.fired) continue;
        if (this.#isLooking(state.actor, state.boardId)) continue;

        const threshold = clampSettledThreshold(this.#thresholdFor(state.actor, state.boardId));
        const quietMs = now - state.armedAt;
        if (quietMs < threshold) continue;

        state.fired = true;
        fires.push({ actor: state.actor, boardId: state.boardId, quietMs });
      }
    }
    return fires;
  }

  /** Number of (actor, board) keys currently tracked. For tests. */
  size(): number {
    let total = 0;
    for (const byBoard of this.#states.values()) total += byBoard.size;
    return total;
  }

  #arm(actor: string, boardId: string, now: number): void {
    let byBoard = this.#states.get(actor);
    if (!byBoard) {
      byBoard = new Map();
      this.#states.set(actor, byBoard);
    }

    const existing = byBoard.get(boardId);
    if (existing) {
      existing.armedAt = now;
      existing.fired = false;
      return;
    }

    this.#evictIfFull();
    byBoard.set(boardId, { actor, boardId, armedAt: now, fired: false });
  }

  /** Evicts the least-recently-armed key so a brand-new key never pushes past `#maxKeys`. */
  #evictIfFull(): void {
    if (this.size() < this.#maxKeys) return;

    let oldestActor: string | null = null;
    let oldestBoard: string | null = null;
    let oldestArmedAt = Infinity;
    for (const byBoard of this.#states.values()) {
      for (const state of byBoard.values()) {
        if (state.armedAt < oldestArmedAt) {
          oldestArmedAt = state.armedAt;
          oldestActor = state.actor;
          oldestBoard = state.boardId;
        }
      }
    }
    if (oldestActor !== null && oldestBoard !== null) {
      this.#states.get(oldestActor)?.delete(oldestBoard);
    }
  }
}
