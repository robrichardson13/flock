/**
 * ADR 0026's web surfaces: the card page's "Run" block (one row per session that worked the
 * card) and the actor page's totals strip. Every number here comes straight off the card/
 * actor payload the caller already fetched — no polling of its own beyond the existing
 * SSE-coalesced refetch, except a light 30s tick so the live duration and "last heard" text
 * keep moving while a card is `doing`. That tick is local to `RunBlock` and is cleared on
 * unmount; it never fires a network request.
 *
 * `telemetry-format.ts` carries every pure number-to-string function; this file is only the
 * markup around them. Every reading is optional per ADR 0026 (a session an agent never linked
 * writes nulls), so nothing here assumes a field exists.
 */
import { useEffect, useState } from "react";
import type { CardDuration, CardStatus, HarnessSessionTelemetry } from "./api.ts";
import {
  alsoWorkedAcross,
  contextPercent,
  formatAgo,
  formatContext,
  formatCostUsd,
  formatDurationMs,
  formatToolCalls,
  hasReadings,
  LIVENESS_LABEL,
  liveDurationMs,
  modelDiffers,
  resolvedModel,
  topTools,
  totalDurationMs,
  totalTokens,
  UNKNOWN,
} from "./telemetry-format.ts";

/** How often the card page's own clock and "last heard" text repaint while a card is
 *  `doing`. Bounded and cleared on unmount by the one `useEffect` that owns it below —
 *  nothing here ever refetches on this tick, it only reformats numbers already in hand. */
const LIVE_TICK_MS = 30_000;

/** Ticks `Date.now()` every `LIVE_TICK_MS` while `active`, otherwise holds still. A card
 *  that is `done`/`wontfix` needs no clock at all: its duration and last-heard times are
 *  frozen, so re-rendering them on a timer would just burn a tick for the same string. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The model chip: the observed model when the reader found one, in a tooltip that says so
 *  when it disagrees with what the agent declared (ADR 0026 §1). Renders nothing without
 *  a model either way — a session with neither has nothing this chip can say. */
function ModelChip({ t }: { t: HarnessSessionTelemetry }) {
  const model = resolvedModel(t);
  if (!model) return <span className="run-model muted">{UNKNOWN}</span>;
  const title = modelDiffers(t) ? `declared: ${t.declaredModel}` : t.harness;
  return <span className="run-model" title={title}>{model}</span>;
}

/** The context bar: a point-in-time reading (ADR 0026 §3 — a compaction resets it), so the
 *  percentage describes the window now, not the run. Renders the dash, no bar at all, when
 *  either half is unknown. */
function ContextBar({ used, max }: { used: number | undefined; max: number | undefined }) {
  const pct = contextPercent(used, max);
  if (pct === null) return <span className="run-context muted">{UNKNOWN}</span>;
  return (
    <span className="run-context" title="Context used now — resets on compaction">
      <span className="run-context-bar"><span className="run-context-fill" style={{ width: `${pct}%` }} /></span>
      <span className="run-context-label">{formatContext(used, max)} ({pct}%)</span>
    </span>
  );
}

/** The liveness dot and its "last heard" caption. Colour is a token per state (styles.css),
 *  so the four states hold the contrast gate the same way every other status dot does. */
function LivenessDot({ t, nowMs }: { t: HarnessSessionTelemetry; nowMs: number }) {
  const state = t.liveness ?? "unknown";
  const label = LIVENESS_LABEL[state];
  const heard = formatAgo(t.lastActivityAt, nowMs);
  return (
    <span className="run-liveness" title={t.livenessNote ? `${label} (${t.livenessNote})` : label}>
      <span className={`run-dot run-dot-${state}`} aria-hidden />
      {label}{heard !== UNKNOWN ? ` · last heard ${heard}` : ""}
    </span>
  );
}

/** The tool-call count, with the top-three breakdown as its tooltip (ADR 0026 §5). */
function ToolCount({ t }: { t: HarnessSessionTelemetry }) {
  const top = topTools(t.tools);
  const title = top.length > 0 ? top.map(([name, count]) => `${name}: ${count}`).join(", ") : undefined;
  return <span className="run-tools" title={title}>{formatToolCalls(t.toolCalls)}</span>;
}

/** "also worked #6, #7" — on the card page, said once for the whole block over every session
 *  in it, rather than repeated on each row where two sessions usually name the same other
 *  cards. The actor page has no "this card" to be *also* relative to, so it says "worked". */
function AlsoWorked({ cards, label = "also worked" }: { cards: number[]; label?: string }) {
  if (cards.length === 0) return null;
  return <span className="run-also muted small">{label} {cards.map((n) => `#${n}`).join(", ")}</span>;
}

/** One session's row on the card page: model, cost, context, the card's own wall clock,
 *  tool count and liveness. `cardDurationMs` is flock's claim-to-close clock — the same for
 *  every row on a given card — with the session's own harness-reported duration in the
 *  tooltip, exactly as ADR 0026 §5 draws it. */
function RunRow({ t, cardDurationMs, nowMs }: { t: HarnessSessionTelemetry; cardDurationMs: number | null; nowMs: number }) {
  return (
    <div className="run-row">
      <ModelChip t={t} />
      <span className="run-cost">{formatCostUsd(t.costUsd)}</span>
      <ContextBar used={t.contextUsed} max={t.contextMax} />
      <span className="run-duration" title={`session: ${formatDurationMs(t.durationMs ?? null)}`}>
        {formatDurationMs(cardDurationMs)}
      </span>
      <ToolCount t={t} />
      <LivenessDot t={t} nowMs={nowMs} />
    </div>
  );
}

/**
 * The card page's Run block: one row per session that worked this card. Renders nothing at
 * all when `telemetry` is empty, so an unlinked board looks exactly as it did before this
 * feature (ADR 0026 §5).
 */
export function RunBlock({ telemetry, duration, status }: { telemetry: HarnessSessionTelemetry[]; duration: CardDuration; status: CardStatus }) {
  const nowMs = useNow(status === "doing");
  if (telemetry.length === 0) return null;
  // A session flock linked but could not read renders as a line of em dashes. Drop those rows
  // when a session with real readings is there to show, and keep them when they are all there
  // is — the block still says "something ran here", it just does not say it twice.
  const withReadings = telemetry.filter(hasReadings);
  const rows = withReadings.length > 0 ? withReadings : telemetry;
  const alsoWorked = alsoWorkedAcross(telemetry);
  const cardDurationMs = liveDurationMs(duration, nowMs);
  return (
    <div className="run-block" role="group" aria-label="Run">
      <h2>Run</h2>
      {rows.map((t) => (
        <RunRow key={t.key} t={t} cardDurationMs={cardDurationMs} nowMs={nowMs} />
      ))}
      <AlsoWorked cards={alsoWorked} />
    </div>
  );
}

/** The actor page's totals strip: cost, tokens, tool calls, session count and total time
 *  across distinct sessions — never re-summing a session that touched several cards. The
 *  strip only appears with two or more sessions; with one it would restate the single row
 *  beneath it, mostly in em dashes.
 *
 *  Card 97: this renders inside the actor sheet, whose own content width is already inset
 *  by the sheet's padding — a second boxed container here (`.run-block`'s border/fill/
 *  radius/shadow, the card page's `RunBlock` idiom) sat narrower than that inset on the
 *  phone sheet and read as clipped. So this strip carries only `.actor-telemetry`, never
 *  `.run-block`: full-bleed to the sheet's own edges, hairline dividers (the same `--line`
 *  token `.run-row` already draws its inter-row borders with) standing in for the box. */
export function ActorTelemetryStrip({
  telemetry,
  totals,
}: {
  telemetry: HarnessSessionTelemetry[];
  totals: { sessions: number; costUsd: number | null; costExact: boolean; toolCalls: number | null };
}) {
  if (telemetry.length === 0) return null;
  const nowMs = Date.now();
  const tokens = totalTokens(telemetry);
  const time = totalDurationMs(telemetry);
  return (
    <div className="actor-telemetry" role="group" aria-label="Run totals">
      {telemetry.length > 1 ? (
        <div className="actor-totals">
          <span title={totals.costExact ? undefined : "at least one session's cost is inexact"}>
            {formatCostUsd(totals.costUsd ?? undefined)}{!totals.costExact && totals.costUsd !== null ? "+" : ""}
          </span>
          <span>{tokens === null ? UNKNOWN : tokens.toLocaleString()} tokens</span>
          <span>{formatToolCalls(totals.toolCalls ?? undefined)}</span>
          <span>{totals.sessions} {totals.sessions === 1 ? "session" : "sessions"}</span>
          <span>{formatDurationMs(time)}</span>
        </div>
      ) : null}
      {telemetry.map((t) => (
        <div className="run-row actor-run-row" key={t.key}>
          <ModelChip t={t} />
          <span className="run-cost">{formatCostUsd(t.costUsd)}</span>
          <ContextBar used={t.contextUsed} max={t.contextMax} />
          <span className="run-duration" title="session duration">{formatDurationMs(t.durationMs ?? null)}</span>
          <ToolCount t={t} />
          <LivenessDot t={t} nowMs={nowMs} />
          <AlsoWorked cards={t.alsoWorked} label="worked" />
        </div>
      ))}
    </div>
  );
}
