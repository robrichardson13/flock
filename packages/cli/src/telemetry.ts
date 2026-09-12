/**
 * `flock telemetry` (ADR 0023 §2, §5): the human's terminal surface for harness telemetry, and
 * the hook-facing `flock telemetry record` that a Claude Code `SessionEnd`/`SubagentStop` hook
 * invokes. Both are thin: core stores and queries (`recordSessionReading`, `sessionsForCard`,
 * `sessionsForActor`, `cardDuration`); `@flock/harness` reads a transcript. This file only wires
 * them together and formats the result.
 *
 * `telemetryRecordCommand` must never throw and must never be noisy on success: a telemetry hook
 * that could interrupt somebody's Claude Code session would be worse than no telemetry at all
 * (ADR 0023 §2 "Cheap and quiet"). Every failure is logged to stderr with context and swallowed.
 */
import type { Flock, HarnessSessionTelemetry } from "@flock/core";
import { resolveDbPath } from "@flock/core";
import { createRegistry, type HarnessRegistry } from "@flock/harness/registry";
import type { RunRef } from "@flock/harness/reader";
import { ClaudeCodeReader } from "@flock/harness/claude-code";
import { CLAUDE_CODE_FAMILY } from "@flock/harness/claude-code-paths";
import { openForCli } from "./schema-policy.ts";

/** A hook payload is a few hundred bytes of JSON; this is a hard ceiling against a hook someone
 * misconfigured to pipe something else in, not a realistic size. */
const MAX_HOOK_STDIN_BYTES = 256 * 1024;
/** Wall-clock budget for the whole record: read stdin, resolve, read the transcript, write the row. */
const HOOK_TIMEOUT_MS = 5_000;
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
 * Refresh a card's/actor's sessions when asked, or when a session has not ended yet (ADR 0023
 * §2 "Level 1"). Bounded: at most MAX_SESSIONS_TO_REFRESH reads, each with its own timeout, and
 * a reader that cannot resolve a session (no cwd hint) is left as-is rather than failing the call.
 */
async function refreshAll(flock: Flock, telemetry: HarnessSessionTelemetry[], opts: { refresh: boolean; cwd: string | null }): Promise<HarnessSessionTelemetry[]> {
  const due = telemetry.filter((t) => opts.refresh || !t.endedAt).slice(0, MAX_SESSIONS_TO_REFRESH);
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

// ---------------------------------------------------------------------------------------------
// flock telemetry record — hook-facing, reads the hook's JSON payload on stdin
// ---------------------------------------------------------------------------------------------

export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
}

export interface TelemetryRecordOptions {
  dbPath?: string;
}

/** Never throws. Every failure is logged to stderr with context; the process still exits 0. */
export async function telemetryRecordCommand(opts: TelemetryRecordOptions): Promise<void> {
  try {
    await recordFromHook(opts);
  } catch (err) {
    console.error(`flock telemetry record: ${errMessage(err)}`);
  }
}

async function recordFromHook(opts: TelemetryRecordOptions): Promise<void> {
  await withTimeout(async () => {
    const raw = await readStdinBounded(MAX_HOOK_STDIN_BYTES);
    const payload = parseHookPayload(raw);
    if (!payload) return;

    const { flock } = openForCli(resolveDbPath(opts.dbPath).path);
    try {
      const key = runKeyFor(payload);
      const ref: RunRef = {
        key,
        family: CLAUDE_CODE_FAMILY,
        sessionId: payload.session_id,
        agentId: payload.agent_id,
        cwd: payload.cwd,
        transcript: payload.transcript_path,
      };
      const reader = defaultRegistry().readerFor(CLAUDE_CODE_FAMILY);
      if (!reader) return;
      const reading = await reader.read(ref);
      if (!reading) return;
      flock.recordSessionReading({ ...reading, source: "hook" });
    } finally {
      flock.close();
    }
  }, HOOK_TIMEOUT_MS);
}

export function runKeyFor(payload: HookPayload): string {
  return payload.agent_id ? `${CLAUDE_CODE_FAMILY}:${payload.session_id}#${payload.agent_id}` : `${CLAUDE_CODE_FAMILY}:${payload.session_id}`;
}

/** `stdin`, capped at `maxBytes` — a hook payload is small JSON; a larger stream is refused
 * rather than buffered without bound. */
async function readStdinBounded(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`stdin payload exceeded ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const MAX_HOOK_STRING = 4096;

/** Parses and validates the hook JSON. Returns undefined (logging why) on anything malformed —
 * this is attacker-shaped input in the same sense a transcript is (ADR 0023 §2). */
export function parseHookPayload(raw: string): HookPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    console.error("flock telemetry record: empty stdin, nothing to record");
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    console.error(`flock telemetry record: stdin was not valid JSON (${errMessage(err)})`);
    return undefined;
  }
  if (!json || typeof json !== "object") {
    console.error("flock telemetry record: stdin JSON was not an object");
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  const sessionId = typeof obj.session_id === "string" ? obj.session_id.trim().slice(0, MAX_HOOK_STRING) : "";
  if (!sessionId) {
    console.error("flock telemetry record: hook payload had no session_id");
    return undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_HOOK_STRING) : undefined);
  return { session_id: sessionId, transcript_path: str(obj.transcript_path), cwd: str(obj.cwd), agent_id: str(obj.agent_id) };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bounds an async operation to `timeoutMs`; rejects rather than hanging a hook or a CLI call. */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Best-effort read on `done`/`release` (ADR 0023 §2 "The CLI, on done and release")
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
