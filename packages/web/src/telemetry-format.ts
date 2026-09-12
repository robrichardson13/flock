/**
 * Pure formatting helpers for ADR 0023's web surfaces (card page Run block, actor totals
 * strip). Kept apart from `Telemetry.tsx` so the numbers can be unit-tested without a DOM.
 *
 * The one rule every function here obeys: a missing reading renders as the em dash `—`,
 * never as a zero or an empty string that could be mistaken for one. `$0.00` for a live
 * session (ADR 0023 §3: cost is unknown while a session runs, not zero) is exactly the bug
 * this file exists to prevent.
 */
import type { CardDuration, HarnessSessionTelemetry, Liveness } from "./api.ts";

export const UNKNOWN = "—";

/** `$4.34`, two decimals, or the dash when the harness has not reported a cost yet. */
export function formatCostUsd(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return UNKNOWN;
  return `$${usd.toFixed(2)}`;
}

/** `148K`, `41K`, `1M`, or a bare small number — the same compaction the context bar and
 *  the token counts share, so "182K / 1M" and "47 tools" read as one typographic family. */
export function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimDecimal(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(n / 1_000)}K`;
  return String(Math.round(n));
}

/** One decimal only when it is not a whole number, so `1.0M` reads as `1M`. */
function trimDecimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** `182K / 1M`. Either half missing collapses the whole reading to the dash: a used-without-
 *  max or max-without-used number reads as more certain than it is. */
export function formatContext(used: number | undefined, max: number | undefined): string {
  if (typeof used !== "number" || typeof max !== "number" || max <= 0) return UNKNOWN;
  return `${formatCompactNumber(used)} / ${formatCompactNumber(max)}`;
}

/** 0-100, or null when either half is missing — the bar and the "(15%)" label share this so
 *  neither ever shows a percentage the other declines to draw. */
export function contextPercent(used: number | undefined, max: number | undefined): number | null {
  if (typeof used !== "number" || typeof max !== "number" || max <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
}

/** `47 tools`, or the dash — never `0 tools`, since a session that has made no tool calls yet
 *  and one nobody has ever read look identical without the reading being marked unknown. */
export function formatToolCalls(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return UNKNOWN;
  return `${n} ${n === 1 ? "tool" : "tools"}`;
}

/** `21m`, `1h 5m`, `45s`, or the dash for a null/negative reading (clock skew, or a claim
 *  with no close yet and no live clock to fall back to). */
export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The card's own wall clock (ADR 0023 §3): closed cards read `duration.ms` verbatim; a
 *  `doing` card with a claim timestamp counts up against `nowMs` so the card page can tick
 *  it live. Neither half present (no claim recorded) is the dash, not zero. */
export function liveDurationMs(duration: CardDuration, nowMs: number): number | null {
  if (duration.ms !== null) return duration.ms;
  if (!duration.claimedAt) return null;
  return Math.max(0, nowMs - Date.parse(duration.claimedAt));
}

/** `12s ago`, `5m ago`, `3h ago` — finer-grained than the app's general `agoText` (App.tsx),
 *  because a liveness reading only means something at the resolution the 15s refresh TTL and
 *  the 30s UI tick actually operate at; "just now" would hide a 40-second-old dot as fresh. */
export function formatAgo(iso: string | undefined, nowMs: number): string {
  if (!iso) return UNKNOWN;
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const LIVENESS_LABEL: Record<Liveness, string> = {
  running: "running",
  idle: "idle",
  gone: "gone",
  unknown: "unknown",
};

/** The model chip's text: the observed model when the reader found one, the agent's own
 *  declared model otherwise — never blank, since a linked session with neither is not one
 *  this function is asked to describe (the caller checks `hasModel` first). */
export function resolvedModel(t: HarnessSessionTelemetry): string | undefined {
  return t.model ?? t.declaredModel;
}

/** True when the observed model (evidence) disagrees with what the agent declared — the
 *  case ADR 0023 §1 calls out for a tooltip rather than silently preferring one. */
export function modelDiffers(t: HarnessSessionTelemetry): boolean {
  return !!t.model && !!t.declaredModel && t.model !== t.declaredModel;
}

/** Total tokens (all four counters) across a set of sessions, or null when none of them has
 *  reported any — the actor totals strip's "tokens" figure, which core does not sum server
 *  side (ADR 0023's `ActorTelemetryTotals` only carries cost/cards/toolCalls/sessions). */
export function totalTokens(sessions: HarnessSessionTelemetry[]): number | null {
  let sum: number | null = null;
  for (const s of sessions) {
    const parts = [s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens].filter(
      (n): n is number => typeof n === "number",
    );
    if (parts.length === 0) continue;
    sum = (sum ?? 0) + parts.reduce((a, b) => a + b, 0);
  }
  return sum;
}

/** Total wall-clock time across a set of sessions' own `durationMs`, or null when none has
 *  one yet (all live). Distinct from the card page's `liveDurationMs`, which is flock's own
 *  claim-to-close clock rather than the harness's session clock. */
export function totalDurationMs(sessions: HarnessSessionTelemetry[]): number | null {
  const known = sessions.map((s) => s.durationMs).filter((n): n is number => typeof n === "number");
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

/** The top `limit` tools by call count, ties broken by name so the tooltip is stable across
 *  renders. Bounded: a histogram already caps at MAX_TOOL_HISTOGRAM_ENTRIES server-side, but
 *  the tooltip itself only ever wants the top three. */
export function topTools(tools: Record<string, number> | undefined, limit = 3): Array<[string, number]> {
  if (!tools) return [];
  return Object.entries(tools)
    .sort(([an, ac], [bn, bc]) => bc - ac || an.localeCompare(bn))
    .slice(0, limit);
}
