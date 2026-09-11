/**
 * Types for harness telemetry (ADR 0022): what a run cost, how full its context got, and
 * whether anyone is still there. Split out from `telemetry.ts` (the store) and
 * `telemetry-queries.ts` (the reads) purely to keep each file under the line budget — both
 * import from here.
 */

/** Liveness as the reader computes it (ADR 0022 §4); deliberately coarse. */
export type Liveness = "running" | "idle" | "gone" | "unknown";

/** How a session reading was collected. */
export type TelemetrySource = "hook" | "reader";

/** Longest `key` a caller may write, and the longest freeform string field. Defensive, not policy. */
export const MAX_KEY_LENGTH = 200;
export const MAX_STRING_LENGTH = 4096;
/** Distinct tool names kept in the histogram; a reader that saw more has already lost the tail. */
export const MAX_TOOL_HISTOGRAM_ENTRIES = 64;
/** Serialized `extra` JSON is a bounded escape hatch, not a second table. */
export const MAX_EXTRA_JSON_LENGTH = 4096;

/**
 * One reading of a harness session, as a reader (`packages/harness`) or the telemetry hook
 * produces it. Every field but `key`, `sessionId` and `observedAt` is nullable/absent on some
 * real run — that is the contract ADR 0005 set for `Runtime` and this table inherits it.
 */
export interface SessionReading {
  /** The same opaque run key `events.session`/`actors.session` carry. */
  key: string;
  harness?: string;
  sessionId: string;
  agentId?: string;
  /** Absolute path on this machine. Never its contents — core never reads it either. */
  transcript?: string;
  cwd?: string;
  /** Observed from the transcript, never the agent's own declared `Runtime.model`. */
  model?: string;
  contextUsed?: number;
  contextMax?: number;
  /** Null while the session is live, and null forever on a harness with no dollar figure. */
  costUsd?: number;
  /** False when the harness flagged an unknown-model cost. */
  costExact?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls?: number;
  /** Histogram by tool name, e.g. `{ Bash: 24, Edit: 18 }`. Capped at MAX_TOOL_HISTOGRAM_ENTRIES. */
  tools?: Record<string, number>;
  startedAt?: string;
  /** Set only when the harness says the session ended. */
  endedAt?: string;
  durationMs?: number;
  apiMs?: number;
  toolMs?: number;
  /** Transcript mtime / thread updated_at: the liveness clock. */
  lastActivityAt?: string;
  liveness?: Liveness;
  /** The harness's own raw word (busy/idle/shell/…), carried verbatim, never used as liveness. */
  livenessNote?: string;
  endedReason?: "clean" | "absent";
  pid?: number;
  /** True when a bounded read hit its size/line/time cap before finishing. */
  partial?: boolean;
  source?: TelemetrySource;
  /** When these numbers were read: the TTL clock a server-side refresh compares against. */
  observedAt: string;
  /** Harness-specific readings flock never filters, sorts or sums on. */
  extra?: Record<string, unknown>;
}

/** One session's telemetry as `sessionsForCard`/`sessionsForActor` return it: the stored row
 * plus what only a group-by over `events` can add — who ran it, what they declared, and what
 * else that session touched. */
export interface HarnessSessionTelemetry extends SessionReading {
  /** The actor whose events carried this session key here. */
  actor: string;
  /** `Runtime.model` as the agent declared it on its own writes; may differ from `model` above. */
  declaredModel?: string;
  /** Other card numbers this session wrote on, so a session total never reads as one card's own. */
  alsoWorked: number[];
}

/** flock's own card duration: claim to close, from the events table alone. Never needs a harness. */
export interface CardDuration {
  claimedAt: string | null;
  closedAt: string | null;
  /** `closedAt - claimedAt` in ms, or null when either end is missing. */
  ms: number | null;
}

/** The `harness_sessions` table, one field per column. */
export type HarnessSessionRow = {
  key: string;
  harness: string | null;
  session_id: string;
  agent_id: string | null;
  transcript: string | null;
  cwd: string | null;
  model: string | null;
  context_used: number | null;
  context_max: number | null;
  cost_usd: number | null;
  cost_exact: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  tool_calls: number | null;
  tools: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  api_ms: number | null;
  tool_ms: number | null;
  last_activity_at: string | null;
  liveness: string | null;
  liveness_note: string | null;
  ended_reason: string | null;
  pid: number | null;
  partial: number | null;
  source: string | null;
  observed_at: string;
  extra: string | null;
  updated_at: string;
};
