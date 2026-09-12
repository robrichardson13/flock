/**
 * Harness telemetry (ADR 0026): what a run cost, how full its context got, and whether anyone
 * is still there. Core stores numbers a reader already computed and never touches the
 * filesystem itself — `packages/harness` reads transcripts, `recordSessionReading` just upserts.
 *
 * This file is the store: types, the row shape, and the upsert. `telemetry-queries.ts` holds the
 * group-by reads (`sessionsForCard`, `sessionsForActor`, `cardDuration`) so this file stays a
 * write path. `Flock` methods are thin wrappers over both.
 */
import type { Database } from "bun:sqlite";
import { FlockError } from "./types.ts";
import {
  MAX_EXTRA_JSON_LENGTH,
  MAX_KEY_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TOOL_HISTOGRAM_ENTRIES,
  type HarnessSessionRow,
  type Liveness,
  type SessionReading,
  type TelemetrySource,
} from "./telemetry-types.ts";

export type { Liveness, TelemetrySource, SessionReading, HarnessSessionTelemetry, CardDuration, HarnessSessionRow } from "./telemetry-types.ts";
export { MAX_KEY_LENGTH, MAX_TOOL_HISTOGRAM_ENTRIES, MAX_EXTRA_JSON_LENGTH } from "./telemetry-types.ts";

/** Cap a tool histogram to the top MAX_TOOL_HISTOGRAM_ENTRIES entries by count. Defensive: a
 * malformed or huge reading must never grow a row without bound. */
function boundTools(tools: Record<string, number> | undefined): string | null {
  if (!tools) return null;
  const entries = Object.entries(tools)
    .slice(0, 10_000) // never iterate an unbounded object even once, before sorting
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOOL_HISTOGRAM_ENTRIES);
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
}

function boundString(s: string | undefined, max = MAX_STRING_LENGTH): string | null {
  if (s === undefined) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function boundExtra(extra: Record<string, unknown> | undefined): string | null {
  if (!extra) return null;
  const json = JSON.stringify(extra);
  return json.length > MAX_EXTRA_JSON_LENGTH ? null : json;
}

/**
 * Upsert one session reading. Every column but `key`/`session_id`/`observed_at`/`updated_at` is
 * COALESCEd against the existing row: a later, partial reading (e.g. a liveness-only poll) never
 * erases a number an earlier, fuller reading already knew. `key` and its length are the only
 * things validated here — everything else is a reader's honest best effort, and core stores it
 * as given.
 */
export function upsertSessionReading(db: Database, r: SessionReading): void {
  validateReading(r);
  db.query(UPSERT_SESSION_SQL).run(...bindValuesFor(r));
}

function validateReading(r: SessionReading): void {
  const key = (r.key ?? "").trim();
  if (!key) throw new FlockError("a session reading needs a key");
  if (key.length > MAX_KEY_LENGTH) throw new FlockError(`a session key is at most ${MAX_KEY_LENGTH} characters`);
  if (!r.sessionId?.trim()) throw new FlockError("a session reading needs a sessionId");
  if (!r.observedAt) throw new FlockError("a session reading needs observedAt");
}

const SESSION_COLUMNS = [
  "key",
  "harness",
  "session_id",
  "agent_id",
  "transcript",
  "cwd",
  "model",
  "context_used",
  "context_max",
  "cost_usd",
  "cost_exact",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "tool_calls",
  "tools",
  "started_at",
  "ended_at",
  "duration_ms",
  "api_ms",
  "tool_ms",
  "last_activity_at",
  "liveness",
  "liveness_note",
  "ended_reason",
  "pid",
  "partial",
  "source",
  "observed_at",
  "extra",
  "updated_at",
] as const;

/** Every column but `key`/`session_id`/`observed_at`/`updated_at` is COALESCEd against the
 * existing row on conflict: a later, partial reading never erases a number an earlier, fuller
 * reading already knew (see the doc comment on `upsertSessionReading`). */
const UPSERT_SESSION_SQL = `INSERT INTO harness_sessions (${SESSION_COLUMNS.join(", ")})
   VALUES (${SESSION_COLUMNS.map(() => "?").join(", ")})
   ON CONFLICT(key) DO UPDATE SET
${SESSION_COLUMNS.filter((c) => !["key", "session_id", "observed_at", "updated_at"].includes(c))
  .map((c) => `     ${c} = COALESCE(excluded.${c}, harness_sessions.${c})`)
  .join(",\n")},
     session_id = excluded.session_id,
     observed_at = excluded.observed_at,
     updated_at = excluded.updated_at`;

/** Bind values in `SESSION_COLUMNS` order, each bounded/normalized for storage. */
function bindValuesFor(r: SessionReading): (string | number | null)[] {
  return [
    r.key.trim(),
    boundString(r.harness),
    r.sessionId,
    boundString(r.agentId),
    boundString(r.transcript),
    boundString(r.cwd),
    boundString(r.model),
    r.contextUsed ?? null,
    r.contextMax ?? null,
    r.costUsd ?? null,
    r.costExact === undefined ? null : r.costExact ? 1 : 0,
    r.inputTokens ?? null,
    r.outputTokens ?? null,
    r.cacheReadTokens ?? null,
    r.cacheWriteTokens ?? null,
    r.toolCalls ?? null,
    boundTools(r.tools),
    boundString(r.startedAt),
    boundString(r.endedAt),
    r.durationMs ?? null,
    r.apiMs ?? null,
    r.toolMs ?? null,
    boundString(r.lastActivityAt),
    boundString(r.liveness),
    boundString(r.livenessNote),
    boundString(r.endedReason),
    r.pid ?? null,
    r.partial === undefined ? null : r.partial ? 1 : 0,
    boundString(r.source),
    r.observedAt,
    boundExtra(r.extra),
    new Date().toISOString(),
  ];
}

/** The identity/text half of a row's fields, everything but the numeric and enum-ish ones. */
function readingIdentity(row: HarnessSessionRow): Pick<SessionReading, "key" | "sessionId" | "harness" | "agentId" | "transcript" | "cwd" | "model" | "startedAt" | "endedAt" | "lastActivityAt"> {
  return {
    key: row.key,
    sessionId: row.session_id,
    ...(row.harness ? { harness: row.harness } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.transcript ? { transcript: row.transcript } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.last_activity_at ? { lastActivityAt: row.last_activity_at } : {}),
  };
}

/** The numbers, the liveness/source enums, and the two JSON columns. */
function readingMetrics(row: HarnessSessionRow): Omit<SessionReading, "key" | "sessionId" | "harness" | "agentId" | "transcript" | "cwd" | "model" | "startedAt" | "endedAt" | "lastActivityAt"> {
  return {
    ...(row.context_used !== null ? { contextUsed: row.context_used } : {}),
    ...(row.context_max !== null ? { contextMax: row.context_max } : {}),
    ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
    ...(row.cost_exact !== null ? { costExact: row.cost_exact === 1 } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cacheReadTokens: row.cache_read_tokens } : {}),
    ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
    ...(row.tool_calls !== null ? { toolCalls: row.tool_calls } : {}),
    ...(row.tools ? { tools: JSON.parse(row.tools) } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.api_ms !== null ? { apiMs: row.api_ms } : {}),
    ...(row.tool_ms !== null ? { toolMs: row.tool_ms } : {}),
    ...(row.liveness ? { liveness: row.liveness as Liveness } : {}),
    ...(row.liveness_note ? { livenessNote: row.liveness_note } : {}),
    ...(row.ended_reason ? { endedReason: row.ended_reason as "clean" | "absent" } : {}),
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.partial !== null ? { partial: row.partial === 1 } : {}),
    ...(row.source ? { source: row.source as TelemetrySource } : {}),
    observedAt: row.observed_at,
    ...(row.extra ? { extra: JSON.parse(row.extra) } : {}),
  };
}

/** The inverse of the INSERT above: a `harness_sessions` row back to the value shape callers use. */
export function rowToReading(row: HarnessSessionRow): SessionReading {
  return { ...readingIdentity(row), ...readingMetrics(row) };
}
