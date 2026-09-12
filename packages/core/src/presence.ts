export const PRESENCE_TTL_MS = 45_000;

/** A focused, visible window with no input in the last three minutes is not "looking" (ADR 0021). */
export const IDLE_MS = 180_000;

export interface LookingInputs {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** `document.hasFocus()`. Ignored on a foreground-only device. */
  focused: boolean;
  /** When the client last saw real user input. */
  lastInputAt: number;
  now: number;
  /**
   * The device shows exactly one app at a time and has no per-window focus: a phone or tablet.
   * There, `visible` already means "this is the foreground app in front of the user's face".
   */
  foregroundOnly: boolean;
}

/**
 * Is this client looking at its board right now? Pure, and the only definition of "looking" —
 * the web wiring supplies the inputs, the server never recomputes it.
 *
 * Desktop keeps ADR 0021's rule: visible **and** focused **and** touched inside `IDLE_MS`, because
 * a board merely visible on a second monitor beside a focused terminal is "might glance", and a
 * board left open while its owner walks away should not suppress anything.
 *
 * A foreground-only device has neither failure mode, and had two of its own (ADR 0021 amendment):
 * `document.hasFocus()` is unreliable in an iOS standalone web app, where there is no second window
 * to lose focus to, and reading a channel for three minutes without tapping is the ordinary way a
 * phone is used, not absence. There, visible is the whole rule; the OS screen-lock is the idle
 * timer, and `PRESENCE_TTL_MS` bounds any stale "looking" at 45s once the beat stops.
 */
export function clientIsLooking(inputs: LookingInputs): boolean {
  if (!inputs.visible) return false;
  if (inputs.foregroundOnly) return true;
  return inputs.focused && inputs.now - inputs.lastInputAt < IDLE_MS;
}

export interface PresenceReport {
  client: string;
  actor: string;
  boardId: string | null;
  looking: boolean;
}

interface PresenceEntry {
  actor: string;
  boardId: string | null;
  expiresAt: number;
}

/**
 * In-memory "who is looking at what board" tracker, keyed by client id (one
 * per page load). No clock reads: `now` is always passed in by the caller.
 */
export class Presence {
  #ttlMs: number;
  #byClient = new Map<string, PresenceEntry>();

  constructor(opts?: { ttlMs?: number }) {
    this.#ttlMs = opts?.ttlMs ?? PRESENCE_TTL_MS;
  }

  report(r: PresenceReport, now: number): void {
    this.#prune(now);
    if (!r.looking) {
      this.#byClient.delete(r.client);
      return;
    }
    this.#byClient.set(r.client, {
      actor: r.actor,
      boardId: r.boardId,
      expiresAt: now + this.#ttlMs,
    });
  }

  isLooking(actor: string, boardId: string, now: number): boolean {
    this.#prune(now);
    for (const entry of this.#byClient.values()) {
      if (entry.actor === actor && entry.boardId === boardId && entry.expiresAt > now) {
        return true;
      }
    }
    return false;
  }

  /** Live entries after pruning. For tests. */
  size(now: number): number {
    this.#prune(now);
    return this.#byClient.size;
  }

  #prune(now: number): void {
    for (const [client, entry] of this.#byClient) {
      if (entry.expiresAt <= now) {
        this.#byClient.delete(client);
      }
    }
  }
}
