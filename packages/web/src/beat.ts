/**
 * A cadence-keeping timer that survives the three things that stopped the presence heartbeat on
 * an iOS home-screen app (card 91).
 *
 * 1. **A frozen clock.** `setInterval` in a hidden WebKit page is throttled to minutes, or frozen
 *    outright when the app is suspended. A `setTimeout` chain re-armed after every beat cannot
 *    drift into a permanent multi-interval hole the way a single long-lived interval can, and
 *    when it does fire late it can *say so*: `gapMsSince` reports any tick that arrives more than
 *    `GAP_FACTOR` cadences after the previous one.
 * 2. **A resume iOS never announced.** The page can come back to the front without a
 *    `visibilitychange` — the same asymmetry `dismiss.ts` was written around. So the chain is not
 *    the only thing that can fire a beat: `resume()` fires one immediately from any signal the
 *    caller trusts (visible, `pageshow`, `focus`, `online`, a reconnected stream, a finger on the
 *    glass) and re-arms the chain from there.
 * 3. **A failed POST.** A rejected beat schedules its own bounded retry *and* leaves the ordinary
 *    chain armed, so no single network blip can end the loop. Past the backoff table the retries
 *    stop and the cadence carries it, which is the bound.
 *
 * Everything is injectable — the clock included — so the whole thing is testable with a fake
 * timer and no DOM. It knows nothing about presence; `presence.ts` supplies the beat.
 */

/** A tick this many cadences late means the timer was throttled or frozen, not merely jittery. */
export const GAP_FACTOR = 2;

/** Retry delays after a failed beat, in order. Bounded: past the end, the cadence takes over. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** Two resume signals from one foregrounding (iOS fires `pageshow`, `focus` and `visibilitychange`
 *  together) must not become two beats. Mirrors `DISMISS_DEDUPE_MS` in `dismiss.ts`. */
export const RESUME_DEDUPE_MS = 1_500;

/** The slice of the platform this needs, so a test hands it a fake instead of a real timer. */
export interface BeatClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export const realBeatClock: BeatClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** Why a beat fired, and how long the client was silent first. */
export interface BeatContext {
  /** `"tick"` for an on-cadence beat; otherwise the resume signal's name, or `"retry"`. */
  reason: string;
  /** Silence before this beat, in ms, only when it exceeded `GAP_FACTOR` cadences. */
  gapMs: number | null;
  /** True for anything but an on-cadence tick: the caller should report even if nothing changed. */
  forced: boolean;
}

export interface BeatScheduler {
  /** Beat once now (reason `"start"`) and arm the chain. */
  start(): void;
  /** Beat once now for a named resume signal, unless one already fired inside the dedupe window. */
  resume(reason: string): void;
  /** Stop the chain and any pending retry. Idempotent. */
  stop(): void;
}

export interface BeatSchedulerOptions {
  cadenceMs: number;
  /** Runs one beat. A rejected promise (or a throw) triggers the bounded retry. */
  beat: (ctx: BeatContext) => Promise<void> | void;
  clock?: BeatClock;
  dedupeMs?: number;
}

/**
 * How long the client was silent, if that counts as a gap. `null` before the first tick, for a
 * clock that went backwards (an NTP step must not be read as a gap), and for any ordinary
 * interval — so a non-null result always means something froze.
 */
export function gapMsSince(lastTickAt: number | null, now: number, cadenceMs: number): number | null {
  if (lastTickAt === null) return null;
  const elapsed = now - lastTickAt;
  if (!Number.isFinite(elapsed) || elapsed < cadenceMs * GAP_FACTOR) return null;
  return elapsed;
}

/** The delay before retry `attempt` (0-based), or `null` once the table is exhausted. */
export function retryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= RETRY_BACKOFF_MS.length) return null;
  return RETRY_BACKOFF_MS[attempt];
}

export function createBeatScheduler(opts: BeatSchedulerOptions): BeatScheduler {
  const clock = opts.clock ?? realBeatClock;
  const dedupeMs = opts.dedupeMs ?? RESUME_DEDUPE_MS;
  const cadenceMs = Math.max(1, opts.cadenceMs);

  let chainHandle: number | null = null;
  let retryHandle: number | null = null;
  let lastTickAt: number | null = null;
  let attempt = 0;
  let stopped = true;

  const clearChain = () => {
    if (chainHandle !== null) clock.clearTimeout(chainHandle);
    chainHandle = null;
  };
  const clearRetry = () => {
    if (retryHandle !== null) clock.clearTimeout(retryHandle);
    retryHandle = null;
  };

  const arm = () => {
    clearChain();
    if (stopped) return;
    chainHandle = clock.setTimeout(onTick, cadenceMs);
  };

  const onFailure = () => {
    // The chain is already armed by `fire`, so the loop lives on regardless of what happens here;
    // the retry only shortens the wait for the first few failures.
    const delay = retryDelayMs(attempt);
    attempt += 1;
    if (delay === null) return;
    clearRetry();
    retryHandle = clock.setTimeout(() => {
      retryHandle = null;
      fire("retry");
    }, delay);
  };

  const fire = (reason: string) => {
    if (stopped) return;
    const now = clock.now();
    const gapMs = gapMsSince(lastTickAt, now, cadenceMs);
    lastTickAt = now;
    // Arm before running the beat, never after: a beat that throws synchronously must not be able
    // to leave the chain dead, which is the whole failure this module exists to prevent.
    arm();
    let result: Promise<void> | void;
    try {
      result = opts.beat({ reason, gapMs, forced: reason !== "tick" });
    } catch (err) {
      console.warn(`[beat] ${reason} threw`, err);
      onFailure();
      return;
    }
    if (!(result instanceof Promise)) {
      attempt = 0;
      clearRetry();
      return;
    }
    result.then(
      () => {
        attempt = 0;
        clearRetry();
      },
      (err: unknown) => {
        console.warn(`[beat] ${reason} failed; retrying with backoff`, err);
        onFailure();
      },
    );
  };

  function onTick(): void {
    chainHandle = null;
    fire("tick");
  }

  return {
    start() {
      stopped = false;
      lastTickAt = null;
      attempt = 0;
      fire("start");
    },
    resume(reason: string) {
      if (stopped) return;
      if (lastTickAt !== null && clock.now() - lastTickAt < dedupeMs) return;
      fire(reason);
    },
    stop() {
      stopped = true;
      clearChain();
      clearRetry();
    },
  };
}
