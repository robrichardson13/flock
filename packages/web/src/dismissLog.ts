/**
 * What the last foreground sweep actually did, so the *server* log can say which link of the
 * dismissal chain broke (card 70).
 *
 * PR 51 left four indistinguishable failures behind a single silent `void dismissAllNotifications()`:
 * the sweep never fired; it fired and the page's `getNotifications()` came back empty; the
 * `flock:close-all` message never reached an active worker; or the worker got it and its own
 * `getNotifications()` came back empty. On a phone none of the console lines that would tell
 * them apart are readable. This module is the read-out that rides along on the presence beat
 * (`packages/web/src/presence.ts`), which is the one channel from the home-screen app that
 * reaches a terminal.
 *
 * Everything here is a fixed number of small fields — no arrays, no history, one clamped error
 * string — so a page left open for a week cannot grow it.
 */

/** Longest error string ever recorded, including the name prefix. */
export const MAX_ERR_CHARS = 120;
/** Longest service-worker state string ever recorded. */
export const MAX_SW_STATE_CHARS = 64;
/** How long the worker gets to answer `flock:close-all` before the ack is recorded as a timeout. */
export const ACK_TIMEOUT_MS = 3_000;

/** Why a sweep ran. `mount` is the cold Home Screen launch, which fires none of the events. */
export type SweepReason = "mount" | "visible" | "pageshow" | "focus" | "resume" | "poll";

/** Did the worker answer the page's `flock:close-all`? */
export type WorkerAck = "pending" | "yes" | "timeout" | "no-worker" | "unsupported";

/** The bounded read-out. Every field is null/absent until something has set it. */
export interface DismissReport {
  /** ms since the last sweep started, or null when none has. Relative, not absolute: a phone's
   *  clock and the server's need not agree, and the age is the only part anyone reads. */
  sweepAgeMs: number | null;
  sweepReason: SweepReason | null;
  /** Sweeps since this page loaded. A cold launch that dismisses nothing still shows `1`, which
   *  is how "the sweep never fired" is told apart from "the sweep found nothing". */
  sweepCount: number;
  /** `<script tail>@<state>,ctl<0|1>,wait<0|1>` — or `none` when there is no registration. */
  swState: string | null;
  /** What the *page* saw and closed on the last sweep. */
  notifsSeen: number | null;
  notifsClosed: number | null;
  workerAck: WorkerAck | null;
  /** What the *worker* reported seeing and closing, once it acks. */
  workerSeen: number | null;
  workerClosed: number | null;
  /** What the worker's `activate` sweep saw, carried on the ack: notifications belonging to a
   *  previous registration would show up here and nowhere else. */
  activateSeen: number | null;
  activateClosed: number | null;
  /** The last error either route caught, clamped. */
  err: string | null;
}

/** A never-swept report. */
export function emptyReport(): DismissReport {
  return {
    sweepAgeMs: null,
    sweepReason: null,
    sweepCount: 0,
    swState: null,
    notifsSeen: null,
    notifsClosed: null,
    workerAck: null,
    workerSeen: null,
    workerClosed: null,
    activateSeen: null,
    activateClosed: null,
    err: null,
  };
}

/** The inputs a service-worker registration gives us, so `formatSwState` stays pure. */
export interface SwStateInputs {
  scriptURL: string | null;
  state: string | null;
  hasController: boolean;
  hasWaiting: boolean;
}

/**
 * Pure. A terse, log-safe summary of which worker is actually in charge — the question behind
 * "the notification belongs to a previous registration". No spaces, so it survives a
 * `key=value` log line whole.
 */
export function formatSwState(s: SwStateInputs | null): string {
  if (!s) return "none";
  const tail = s.scriptURL ? (s.scriptURL.split("/").pop() || s.scriptURL) : "-";
  const out = `${tail}@${s.state ?? "-"},ctl${s.hasController ? 1 : 0},wait${s.hasWaiting ? 1 : 0}`;
  return out.slice(0, MAX_SW_STATE_CHARS);
}

/** `Error` -> `"TypeError: boom"`, anything else -> its string form. Always clamped. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.slice(0, MAX_ERR_CHARS);
}

/** The recorder's surface. One instance per page; `createDismissRecorder` makes testable ones. */
export interface DismissRecorder {
  /** A sweep is starting: clears the per-sweep fields and bumps the count. */
  begin(reason: SweepReason): void;
  swState(state: string): void;
  pageResult(seen: number, closed: number): void;
  ack(ack: WorkerAck, counts?: { seen?: number; closed?: number; activateSeen?: number; activateClosed?: number }): void;
  error(err: unknown): void;
  /** The current read-out, with `sweepAgeMs` computed against `now`. */
  read(): DismissReport;
}

export function createDismissRecorder(now: () => number = Date.now): DismissRecorder {
  let sweepAt: number | null = null;
  let r = emptyReport();
  // `-1` is a real reading — "we could not even ask" — and must survive the clamp; anything
  // below it is nonsense and is pinned there.
  const clampCount = (n: number | undefined): number | null =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(-1, Math.min(Math.round(n), 9_999)) : null;

  return {
    begin(reason) {
      const count = r.sweepCount + 1;
      r = { ...emptyReport(), sweepCount: Math.min(count, 999_999), sweepReason: reason };
      sweepAt = now();
    },
    swState(state) {
      r.swState = state.slice(0, MAX_SW_STATE_CHARS);
    },
    pageResult(seen, closed) {
      r.notifsSeen = clampCount(seen);
      r.notifsClosed = clampCount(closed);
    },
    ack(ack, counts) {
      // A late reply must never overwrite a newer sweep's answer with an older one, but "pending"
      // must never overwrite a real answer either.
      if (ack === "pending" && r.workerAck !== null) return;
      if (ack === "timeout" && r.workerAck === "yes") return;
      r.workerAck = ack;
      if (!counts) return;
      r.workerSeen = clampCount(counts.seen);
      r.workerClosed = clampCount(counts.closed);
      r.activateSeen = clampCount(counts.activateSeen);
      r.activateClosed = clampCount(counts.activateClosed);
    },
    error(err) {
      r.err = describeError(err);
    },
    read() {
      const age = sweepAt === null ? null : Math.max(0, now() - sweepAt);
      return { ...r, sweepAgeMs: age };
    },
  };
}

/** The page's one recorder. `push.ts` writes it; `presence.ts` reads it onto every beat. */
export const dismissRecorder: DismissRecorder = createDismissRecorder();

/** The wire form of the read-out: the same fields, nulls dropped so an untouched page adds
 *  nothing to the beat body. Pure, so the mapping is testable without a browser. */
export function dismissBeatFields(r: DismissReport): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const num = (k: string, v: number | null) => { if (v !== null) out[k] = v; };
  const str = (k: string, v: string | null) => { if (v !== null) out[k] = v; };
  num("sweepAgeMs", r.sweepAgeMs);
  str("sweepReason", r.sweepReason);
  if (r.sweepCount > 0) out.sweepCount = r.sweepCount;
  str("swState", r.swState);
  num("notifsSeen", r.notifsSeen);
  num("notifsClosed", r.notifsClosed);
  str("workerAck", r.workerAck);
  num("workerSeen", r.workerSeen);
  num("workerClosed", r.workerClosed);
  num("activateSeen", r.activateSeen);
  num("activateClosed", r.activateClosed);
  str("dismissErr", r.err);
  return out;
}
