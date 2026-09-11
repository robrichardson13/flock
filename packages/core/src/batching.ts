import { mergedNotification, notificationClass } from "./notify.ts";
import type { Event } from "./types.ts";
import type { NotificationPayload } from "./notify.ts";

export const BATCH_WINDOW_MS = 60_000;

export interface Dispatch {
  actor: string;
  boardId: string;
  payload: NotificationPayload;
}

export type IsLooking = (actor: string, boardId: string, now: number) => boolean;

interface BatchState {
  actor: string;
  boardId: string;
  /** Messages since the recipient last looked at this board. */
  count: number;
  /** Payload of the newest folded message, or null when nothing is pending. */
  latest: NotificationPayload | null;
  /** When the current window ends, or null when the key is quiet. */
  windowEndsAt: number | null;
}

/**
 * Leading-edge throttle over `message.posted` notifications, keyed by (recipient actor, board).
 * Asks and awaiting-human moves bypass this entirely: they are dispatched immediately by the
 * caller and never touch batch state. `isLooking` is injected so this has no dependency on
 * `Presence` and can be tested independently.
 */
export class NotificationBatcher {
  #isLooking: IsLooking;
  #windowMs: number;
  // Nested by actor then board so keys never need to be encoded/decoded from a joined string.
  #states = new Map<string, Map<string, BatchState>>();

  constructor(opts: { isLooking: IsLooking; windowMs?: number }) {
    this.#isLooking = opts.isLooking;
    this.#windowMs = opts.windowMs ?? BATCH_WINDOW_MS;
  }

  /**
   * Every event goes through here, so the author-seen reset (D9) applies even to events that
   * notify nobody. `payload`/`recipients` are only meaningful when the event notifies.
   */
  onEvent(
    event: Event,
    payload: NotificationPayload | null,
    recipients: readonly string[],
    now: number,
  ): Dispatch[] {
    const boardId = event.boardId;

    // The recipient's own write on this board is at least as strong a signal as looking at it:
    // reset the key for this board whose actor is the event's author.
    this.#reset(event.actor, boardId);

    if (!payload) return [];

    const cls = notificationClass(event);
    if (cls === "urgent") {
      // Asks and awaiting-human moves bypass batching and presence entirely, and never touch a
      // pending message-batch key.
      return recipients.map((actor) => ({ actor, boardId, payload }));
    }

    if (cls !== "chatter") return [];

    const dispatches: Dispatch[] = [];
    for (const actor of recipients) {
      if (this.#isLooking(actor, boardId, now)) {
        // Being seen resets the count and drops any pending batch (D9).
        this.#reset(actor, boardId);
        continue;
      }

      const state = this.#get(actor, boardId);
      state.count += 1;

      if (state.windowEndsAt === null || now >= state.windowEndsAt) {
        // Quiet: leading edge.
        const dispatchPayload = state.count === 1 ? payload : mergedNotification(payload, state.count, true);
        dispatches.push({ actor, boardId, payload: dispatchPayload });
        state.windowEndsAt = now + this.#windowMs;
        state.latest = null;
      } else {
        // Inside a window: fold, no dispatch.
        state.latest = payload;
      }
    }
    return dispatches;
  }

  /** Trailing flushes whose window has closed; drops keys whose actor is now looking. */
  due(now: number): Dispatch[] {
    const dispatches: Dispatch[] = [];
    for (const byBoard of this.#states.values()) {
      for (const state of byBoard.values()) {
        const { actor, boardId } = state;

        if (this.#isLooking(actor, boardId, now)) {
          this.#reset(actor, boardId);
          continue;
        }

        if (state.latest === null) continue; // quiet: nothing pending
        if (state.windowEndsAt === null || now < state.windowEndsAt) continue;

        dispatches.push({
          actor,
          boardId,
          payload: mergedNotification(state.latest, state.count, false),
        });
        state.windowEndsAt = now + this.#windowMs; // a flush opens the next window
        state.latest = null;
      }
    }
    return dispatches;
  }

  /** Earliest pending flush, or null. For tests. */
  nextDueAt(): number | null {
    let earliest: number | null = null;
    for (const byBoard of this.#states.values()) {
      for (const state of byBoard.values()) {
        if (state.latest === null || state.windowEndsAt === null) continue;
        if (earliest === null || state.windowEndsAt < earliest) earliest = state.windowEndsAt;
      }
    }
    return earliest;
  }

  #get(actor: string, boardId: string): BatchState {
    let byBoard = this.#states.get(actor);
    if (!byBoard) {
      byBoard = new Map();
      this.#states.set(actor, byBoard);
    }
    let state = byBoard.get(boardId);
    if (!state) {
      state = { actor, boardId, count: 0, latest: null, windowEndsAt: null };
      byBoard.set(boardId, state);
    }
    return state;
  }

  #reset(actor: string, boardId: string): void {
    this.#states.get(actor)?.delete(boardId);
  }
}
