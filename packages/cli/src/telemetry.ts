/**
 * `flock telemetry` (ADR 0026 §2, §5): the human's terminal surface for harness telemetry.
 * Thin: core stores and queries (`recordSessionReading`, `sessionsForCard`, `sessionsForActor`,
 * `cardDuration`); `@flock/harness` reads a transcript on demand. This file only wires them
 * together and formats the result. There is no hook-facing path: flock never installs or relies
 * on Claude Code hooks (ADR 0026, d10) — every reading comes from reading the transcript when
 * something asks to see it.
 */
import type { Flock, HarnessSessionTelemetry } from "@flock/core";
import { isSessionFinal } from "@flock/core";
import { createRegistry, type HarnessRegistry } from "@flock/harness/registry";
import { ClaudeCodeReader } from "@flock/harness/claude-code";

/** A card's or actor's session count is normally 1-3; this bounds a pathological board. */
const MAX_SESSIONS_TO_REFRESH = 20;
const REFRESH_TIMEOUT_MS = 3_000;

let registry: HarnessRegistry | undefined;

/** One process-wide registry, built lazily so a command that never touches telemetry pays nothing. */
function defaultRegistry(): HarnessRegistry {
  if (!registry) registry = createRegistry([new ClaudeCodeReader()]);
  return registry;
}

// ---------------------------------------------------------------------------------------------
// flock telemetry [card] [--refresh] [--json]
// ---------------------------------------------------------------------------------------------

export interface TelemetryCardResult {
  card: number;
  duration: { claimedAt: string | null; closedAt: string | null; ms: number | null };
  telemetry: HarnessSessionTelemetry[];
}

export interface TelemetryActorResult {
  actor: string;
  telemetry: HarnessSessionTelemetry[];
  totals: { costUsd: number | null; toolCalls: number | null; cards: number[] };
}

/** `flock telemetry <card>`: a card's sessions plus flock's own claim→close duration. */
export async function telemetryForCard(flock: Flock, board: string, cardNum: number, opts: { refresh: boolean; cwd: string | null }): Promise<TelemetryCardResult> {
  const duration = flock.cardDuration(board, cardNum);
  const telemetry = await refreshAll(flock, flock.sessionsForCard(board, cardNum), opts);
  return { card: cardNum, duration, telemetry };
}

/** `flock telemetry` with no card: the sessions `--as`/`FLOCK_ACTOR` ran on this board. */
export async function telemetryForActor(flock: Flock, board: string, actorName: string, opts: { refresh: boolean; cwd: string | null }): Promise<TelemetryActorResult> {
  const telemetry = await refreshAll(flock, flock.sessionsForActor(board, actorName), opts);
  return { actor: actorName, telemetry, totals: totalsOf(telemetry) };
}

function totalsOf(telemetry: HarnessSessionTelemetry[]): TelemetryActorResult["totals"] {
  const withCost = telemetry.filter((t) => t.costUsd !== undefined);
  const costUsd = withCost.length ? withCost.reduce((sum, t) => sum + t.costUsd!, 0) : null;
  const withTools = telemetry.filter((t) => t.toolCalls !== undefined);
  const toolCalls = withTools.length ? withTools.reduce((sum, t) => sum + t.toolCalls!, 0) : null;
  const cards = [...new Set(telemetry.flatMap((t) => t.alsoWorked))].sort((a, b) => a - b);
  return { costUsd, toolCalls, cards };
}

/**
 * Refresh a card's/actor's sessions when asked, or when a session is not yet final (ADR 0026
 * §2 "Level 1"; `isSessionFinal` — cost lands retroactively, so a session without cost is kept
 * re-read until it has cost, its transcript is gone, or it is simply too old to keep checking).
 * Bounded: at most MAX_SESSIONS_TO_REFRESH reads, each with its own timeout, and a reader that
 * cannot resolve a session (no cwd hint) is left as-is rather than failing the call.
 */
async function refreshAll(flock: Flock, telemetry: HarnessSessionTelemetry[], opts: { refresh: boolean; cwd: string | null }): Promise<HarnessSessionTelemetry[]> {
  const now = Date.now();
  const due = telemetry.filter((t) => opts.refresh || !isSessionFinal(t, now)).slice(0, MAX_SESSIONS_TO_REFRESH);
  if (due.length === 0) return telemetry;
  const entries = await Promise.all(due.map(async (t) => [t.key, await refreshOne(flock, t, opts.cwd)] as const));
  const refreshed = new Map(entries);
  return telemetry.map((t) => refreshed.get(t.key) ?? t);
}

async function refreshOne(flock: Flock, entry: HarnessSessionTelemetry, cwd: string | null): Promise<HarnessSessionTelemetry> {
  try {
    const reader = defaultRegistry().readerForHint({ key: entry.key, cwd: entry.cwd ?? cwd ?? undefined });
    if (!reader) return entry;
    return await withTimeout(async () => {
      const ref = await reader.resolve({ key: entry.key, cwd: entry.cwd ?? cwd ?? undefined });
      if (!ref) return entry;
      const reading = await reader.read(ref);
      if (!reading) return entry;
      flock.recordSessionReading(reading);
      return { ...entry, ...reading };
    }, REFRESH_TIMEOUT_MS);
  } catch (err) {
    console.error(`flock telemetry: could not refresh ${entry.key}: ${errMessage(err)}`);
    return entry;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bounds an async operation to `timeoutMs`; rejects rather than hanging a CLI call. */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Best-effort read on `done`/`release` (ADR 0026 §2 "The CLI, on done and release")
// ---------------------------------------------------------------------------------------------

/**
 * One read of the acting session's own telemetry, swallowed on any failure. Called after a
 * `done`/`release` write when the actor carried a session key; never allowed to fail the command
 * that triggered it, so it neither throws nor is awaited-and-checked by its caller.
 */
export async function bestEffortRefresh(flock: Flock, session: string | undefined, cwd: string): Promise<void> {
  if (!session) return;
  try {
    const reader = defaultRegistry().readerForHint({ key: session, cwd });
    if (!reader) return;
    await withTimeout(async () => {
      const ref = await reader.resolve({ key: session, cwd });
      if (!ref) return;
      const reading = await reader.read(ref);
      if (!reading) return;
      flock.recordSessionReading(reading);
    }, REFRESH_TIMEOUT_MS);
  } catch (err) {
    console.error(`flock: best-effort telemetry read skipped (${errMessage(err)})`);
  }
}

// ---------------------------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------------------------

const LIVENESS_DOT: Record<string, string> = { running: "●", idle: "◐", gone: "○", unknown: "?" };

export function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export function fmtCost(usd: number | undefined): string {
  return usd === undefined ? "—" : `$${usd.toFixed(2)}`;
}

export function fmtContext(used: number | undefined, max: number | undefined): string {
  if (used === undefined) return "—";
  if (max === undefined) return String(used);
  const pct = Math.round((used / max) * 100);
  return `${Math.round(used / 1000)}K/${Math.round(max / 1000)}K (${pct}%)`;
}

function fmtSession(t: HarnessSessionTelemetry): string {
  const model = t.model ?? t.declaredModel ?? "unknown model";
  const tools = t.toolCalls !== undefined ? `${t.toolCalls} tools` : "";
  const dot = LIVENESS_DOT[t.liveness ?? "unknown"] ?? "?";
  const activity = t.lastActivityAt ? ` (${t.lastActivityAt})` : "";
  const also = t.alsoWorked.length ? `  also: #${t.alsoWorked.join(", #")}` : "";
  const bits = [t.key, t.actor, model, fmtCost(t.costUsd), fmtContext(t.contextUsed, t.contextMax), tools, `${dot} ${t.liveness ?? "unknown"}${activity}`, also];
  return bits.filter(Boolean).join("  ");
}

export function printTelemetryCard(r: TelemetryCardResult): void {
  console.log(`#${r.card} duration: ${fmtDuration(r.duration.ms)}${r.duration.closedAt ? "" : " (still open)"}`);
  if (r.telemetry.length === 0) return console.log("No harness telemetry for this card.");
  for (const t of r.telemetry) console.log(fmtSession(t));
}

export function printTelemetryActor(r: TelemetryActorResult): void {
  if (r.telemetry.length === 0) return console.log(`No harness telemetry for ${r.actor}.`);
  console.log(`${r.actor}: ${fmtCost(r.totals.costUsd ?? undefined)}  ${r.totals.toolCalls ?? "—"} tools  cards: ${r.totals.cards.length ? `#${r.totals.cards.join(", #")}` : "—"}`);
  for (const t of r.telemetry) console.log(fmtSession(t));
}
