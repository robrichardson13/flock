/**
 * The seam ADR 0026 §6 describes: every harness reader behind one interface. This package
 * imports types only from `@flock/core` and never touches the database — core exposes
 * `recordSessionReading`/`sessionsForCard`/`sessionsForActor` and never touches the filesystem.
 * Adding a harness is one file plus one registry line; core never names a reader.
 */
import type { Liveness, SessionReading } from "@flock/core";

/**
 * What a flock write already knew when it wants to resolve a run: the opaque run key
 * (`Runtime.session`, e.g. `claude-code:<uuid>` or `claude-code:<uuid>#<agentId>`) and the cwd
 * the write happened from, since the transcript path is derived from `(cwd, session id)`.
 */
export interface RunHint {
  key: string;
  cwd?: string;
}

/** A resolved run: enough for `read`/`liveness` to find the transcript with no further lookup. */
export interface RunRef {
  key: string;
  family: string;
  sessionId: string;
  agentId?: string;
  cwd?: string;
  transcript?: string;
}

/** The cheap check: mtime and a process check, nothing else. What a liveness poll calls. */
export interface LivenessReading {
  liveness: Liveness;
  /** The harness's own raw word (busy/idle/shell/…), carried verbatim, never used to decide. */
  livenessNote?: string;
  lastActivityAt?: string;
  pid?: number;
  endedReason?: "clean" | "absent";
}

export interface HarnessReader {
  /** The key prefix this reader owns: "claude-code", "codex". */
  readonly family: string;
  /** Find a run from what a flock write knew. Null when this reader cannot place the hint. */
  resolve(hint: RunHint): Promise<RunRef | null>;
  /**
   * Full read: the numbers. Bounded by time and size; marks `partial` rather than throwing.
   * Never rejects — a missing or truncated transcript comes back as a `SessionReading` with
   * `partial: true` and the reason in `extra.unavailableReason`, not as an exception or `null`.
   * `null` is reserved for a `ref` this reader cannot make sense of at all (wrong family).
   */
  read(ref: RunRef): Promise<SessionReading | null>;
  /** Cheap read: mtime and process check only. Never rejects. */
  liveness(ref: RunRef): Promise<LivenessReading>;
}

/** The family prefix of a run key, e.g. "claude-code" out of "claude-code:<uuid>#<agentId>". */
export function familyOf(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}
