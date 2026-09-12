import { FlockError, type Event } from "./types.ts";
import type { NotifyContext } from "./notify.ts";

// ADR 0024: notification levels, declared by the agent and filtered by the human. Split out of
// notify.ts (which already covers push subscriptions and payload shaping) to keep both files
// under the 300-line limit.

/**
 * The three levels a post can carry, ordered `needs-me > review > info` for presentation only —
 * delivery treats them as independent toggles (`deliversAt`), not a threshold. `settled` is
 * deliberately not here: it is not a property of a post, see `packages/core/src/settled.ts`
 * (card 74).
 */
export type NotifyLevel = "needs-me" | "review" | "info";

/** What `say`/`comment` may declare. `needs-me` is refused by `assertDeclarableLevel` below. */
export type DeclaredNotifyLevel = "review" | "info";

/** Resolved, always-concrete settings for one (actor, board) pair — every inherit already applied. */
export interface NotifySettings {
  needsMe: boolean;
  review: boolean;
  info: boolean;
  settled: boolean;
  settledAfterMs: number;
}

/**
 * One stored row's fields as `Flock` reads/writes them: `null` means "inherit" (from the global
 * row, or, on the global row itself, from `DEFAULT_NOTIFY_SETTINGS`). Never has a default baked
 * in — that is `resolveNotifySettingsFields`'s job.
 */
export interface NotifySettingsFields {
  needsMe: boolean | null;
  review: boolean | null;
  info: boolean | null;
  settled: boolean | null;
  settledAfterMs: number | null;
}

/** ADR 0024: needs-me on, review on, everything (info) off, settled off, threshold 20 minutes. */
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  needsMe: true,
  review: true,
  info: false,
  settled: false,
  settledAfterMs: 20 * 60_000,
};

/** The settled threshold is clamped to this range: below the batch window, or past a day. */
export const SETTLED_THRESHOLD_MIN_MS = 5 * 60_000;
export const SETTLED_THRESHOLD_MAX_MS = 24 * 60 * 60_000;

/** Clamps a candidate threshold into `[SETTLED_THRESHOLD_MIN_MS, SETTLED_THRESHOLD_MAX_MS]`. */
export function clampSettledThreshold(ms: number): number {
  const truncated = Math.trunc(ms);
  return Math.min(SETTLED_THRESHOLD_MAX_MS, Math.max(SETTLED_THRESHOLD_MIN_MS, truncated));
}

/** A GitHub pull-request URL, anywhere in the text — the one text pattern specific enough to match on. */
const PULL_REQUEST_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;

/**
 * The level this event carries, or `null` when it is not a level-bearing event at all (anything
 * outside `card.asked`, `card.moved` → awaiting-human, `message.posted`, `comment.posted`).
 * `ctx` is accepted for symmetry with `notificationFor` — same value, same call site — and is
 * unused today; nothing in the ADR's precedence chain needs board or card context.
 *
 * Precedence, first match wins:
 * 1. Intrinsic: `card.asked` and `card.moved` → awaiting-human are always `needs-me`, never
 *    downgradable by anything in `data`.
 * 2. The author's declaration: `event.data.level` when it is `"review"` or `"info"`.
 * 3. Heuristics: an image-bearing `comment.posted`, or a `message.posted`/`comment.posted` body
 *    containing a GitHub pull-request URL, is `review`.
 * 4. Default: `info`.
 */
export function levelFor(event: Event, ctx: NotifyContext): NotifyLevel | null {
  void ctx;
  if (event.type === "card.asked") return "needs-me";
  if (event.type === "card.moved" && event.data.to === "awaiting-human") return "needs-me";
  if (event.type !== "message.posted" && event.type !== "comment.posted") return null;

  const declared = event.data.level;
  if (declared === "review" || declared === "info") return declared;

  if (event.type === "comment.posted") {
    const attachments = typeof event.data.attachments === "number" ? event.data.attachments : 0;
    if (attachments > 0) return "review";
  }

  const body = typeof event.data.body === "string" ? event.data.body : "";
  if (PULL_REQUEST_URL.test(body)) return "review";

  return "info";
}

/** Whether a post at this level reaches the human under these settings. Independent toggles, no ordering. */
export function deliversAt(level: NotifyLevel, settings: NotifySettings): boolean {
  if (level === "needs-me") return settings.needsMe;
  if (level === "review") return settings.review;
  return settings.info;
}

/**
 * Validates a level an author is declaring on `say`/`comment`. `undefined` (nothing declared)
 * passes through as `undefined`. `"needs-me"` is refused: it is a claim that the board has
 * something the human can act on and close, which only `flock ask` can make. Anything else
 * unrecognised is refused too, so a typo fails loudly instead of silently landing as `info`.
 */
export function assertDeclarableLevel(level: string | undefined): DeclaredNotifyLevel | undefined {
  if (level === undefined) return undefined;
  if (level === "review" || level === "info") return level;
  if (level === "needs-me") {
    throw new FlockError("needs-me can't be declared on a message or comment — use `flock ask` to put it on a card", "invalid");
  }
  throw new FlockError(`unknown notification level "${level}"; use "review" or "info"`, "invalid");
}

/**
 * Merges a global row and a per-board override into concrete settings: the board's non-null
 * value wins, else the global row's non-null value, else the built-in default. A board row with
 * every field `null` reads identically to no override at all — that is what "Same as all
 * boards" writes.
 */
export function resolveNotifySettingsFields(global: NotifySettingsFields | null, board: NotifySettingsFields | null): NotifySettings {
  const pick = <K extends keyof NotifySettingsFields>(key: K): NotifySettingsFields[K] => board?.[key] ?? global?.[key] ?? null;
  return {
    needsMe: pick("needsMe") ?? DEFAULT_NOTIFY_SETTINGS.needsMe,
    review: pick("review") ?? DEFAULT_NOTIFY_SETTINGS.review,
    info: pick("info") ?? DEFAULT_NOTIFY_SETTINGS.info,
    settled: pick("settled") ?? DEFAULT_NOTIFY_SETTINGS.settled,
    settledAfterMs: pick("settledAfterMs") ?? DEFAULT_NOTIFY_SETTINGS.settledAfterMs,
  };
}
