/**
 * The Claude Code `HarnessReader` (ADR 0026 §2, §4, §6). Resolves a run key to a transcript
 * path, reads it bounded, and computes liveness from pid + mtime. Never throws: a missing or
 * truncated transcript comes back as a `partial` reading with a reason, not an exception.
 */
import type { SessionReading } from "@flock/core";
import { defaultScanLimits, DEFAULT_FRESH_WINDOW_MS, type ScanLimits } from "./limits.ts";
import { isAlive, findPidFileForSession, procStartMatches } from "./claude-code-liveness.ts";
import {
  CLAUDE_CODE_FAMILY,
  claudeHome,
  contextMaxForModel,
  subagentTranscriptPath,
  transcriptPath,
} from "./claude-code-paths.ts";
import { scanTranscript, type TranscriptScan } from "./claude-code-parse.ts";
import { familyOf, type HarnessReader, type LivenessReading, type RunHint, type RunRef } from "./reader.ts";

export interface ClaudeCodeReaderOptions {
  /** `~/.claude` by default; overridable so tests never touch the real home directory. */
  home?: string;
  limits?: Partial<ScanLimits>;
  freshWindowMs?: number;
}

export class ClaudeCodeReader implements HarnessReader {
  readonly family = CLAUDE_CODE_FAMILY;
  private readonly home: string;
  private readonly limits: ScanLimits;
  private readonly freshWindowMs: number;

  constructor(opts: ClaudeCodeReaderOptions = {}) {
    this.home = claudeHome(opts.home);
    this.limits = defaultScanLimits(opts.limits);
    this.freshWindowMs = opts.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;
  }

  async resolve(hint: RunHint): Promise<RunRef | null> {
    if (familyOf(hint.key) !== this.family) return null;
    const parsed = parseRunKey(hint.key);
    if (!parsed || !hint.cwd) return null;
    const transcript = parsed.agentId
      ? subagentTranscriptPath(this.home, hint.cwd, parsed.sessionId, parsed.agentId)
      : transcriptPath(this.home, hint.cwd, parsed.sessionId);
    return { key: hint.key, family: this.family, sessionId: parsed.sessionId, agentId: parsed.agentId, cwd: hint.cwd, transcript };
  }

  async read(ref: RunRef): Promise<SessionReading | null> {
    if (ref.family !== this.family) return null;
    const observedAt = new Date().toISOString();
    if (!ref.transcript) return unavailable(ref, observedAt, "no-transcript-path");

    const scan = await scanTranscript(ref.transcript, this.limits);
    if (!scan) return unavailable(ref, observedAt, "missing-transcript");

    const contextMax = scan.lastAssistant?.model ? await contextMaxForModel(this.home, scan.lastAssistant.model) : undefined;
    const liveness = await this.livenessFrom(ref, scan);
    return readingFromScan(ref, scan, contextMax, liveness, observedAt);
  }

  async liveness(ref: RunRef): Promise<LivenessReading> {
    if (ref.family !== this.family || !ref.transcript) return { liveness: "unknown" };
    const scan = await scanTranscript(ref.transcript, this.limits);
    if (!scan) return { liveness: "unknown" };
    return this.livenessFrom(ref, scan);
  }

  /** Shared by `read()` (a full reading still wants a fresh liveness, per ADR 0026 §3 "recomputed
   * on every refresh") and `liveness()` (the cheap standalone poll). */
  private async livenessFrom(ref: RunRef, scan: TranscriptScan): Promise<LivenessReading> {
    if (scan.costState) return { liveness: "gone", endedReason: "clean", lastActivityAt: scan.mtime.toISOString() };
    return this.livenessFromPid(ref, scan);
  }

  private async livenessFromPid(ref: RunRef, scan: TranscriptScan): Promise<LivenessReading> {
    const lastActivityAt = scan.mtime.toISOString();
    const pidFile = await findPidFileForSession(this.home, ref.sessionId);
    if (!pidFile) return { liveness: "unknown", lastActivityAt };
    if (!isAlive(pidFile.pid)) return { liveness: "gone", endedReason: "absent", lastActivityAt, pid: pidFile.pid };

    const reused = pidFile.procStart ? (await procStartMatches(pidFile.pid, pidFile.procStart)) === false : false;
    if (reused) return { liveness: "gone", endedReason: "absent", lastActivityAt };

    const fresh = Date.now() - scan.mtime.getTime() <= this.freshWindowMs;
    return {
      liveness: fresh ? "running" : "idle",
      livenessNote: pidFile.status,
      lastActivityAt,
      pid: pidFile.pid,
    };
  }
}

function parseRunKey(key: string): { sessionId: string; agentId?: string } | null {
  const colon = key.indexOf(":");
  const rest = colon === -1 ? key : key.slice(colon + 1);
  const hash = rest.indexOf("#");
  if (hash === -1) return rest ? { sessionId: rest } : null;
  const sessionId = rest.slice(0, hash);
  const agentId = rest.slice(hash + 1);
  return sessionId && agentId ? { sessionId, agentId } : null;
}

function unavailable(ref: RunRef, observedAt: string, reason: string): SessionReading {
  return {
    key: ref.key,
    sessionId: ref.sessionId,
    agentId: ref.agentId,
    harness: CLAUDE_CODE_FAMILY,
    transcript: ref.transcript,
    cwd: ref.cwd,
    liveness: "unknown",
    partial: true,
    source: "reader",
    observedAt,
    extra: { unavailableReason: reason },
  };
}

function readingFromScan(ref: RunRef, scan: TranscriptScan, contextMax: number | undefined, liveness: LivenessReading, observedAt: string): SessionReading {
  const liveTokens = scan.lastAssistant?.usage;
  const finalTokens = combinedModelUsage(scan.costState?.tokensByModel);
  const tokens = finalTokens ?? liveTokens;
  const contextUsed = liveTokens ? liveTokens.inputTokens + liveTokens.cacheReadTokens + liveTokens.cacheWriteTokens : undefined;

  return {
    key: ref.key,
    sessionId: ref.sessionId,
    agentId: ref.agentId,
    harness: CLAUDE_CODE_FAMILY,
    transcript: ref.transcript,
    cwd: ref.cwd,
    model: scan.lastAssistant?.model,
    contextUsed,
    contextMax,
    costUsd: scan.costState?.totalCostUSD,
    costExact: scan.costState ? scan.costState.hasUnknownModelCost !== true : undefined,
    inputTokens: tokens?.inputTokens,
    outputTokens: tokens?.outputTokens,
    cacheReadTokens: tokens?.cacheReadTokens,
    cacheWriteTokens: tokens?.cacheWriteTokens,
    toolCalls: scan.toolCalls > 0 ? scan.toolCalls : undefined,
    tools: Object.keys(scan.tools).length > 0 ? scan.tools : undefined,
    startedAt: scan.startedAt,
    endedAt: scan.costState ? scan.mtime.toISOString() : undefined,
    durationMs: scan.costState?.totalDuration,
    apiMs: scan.costState?.totalAPIDuration,
    toolMs: scan.costState?.totalToolDuration,
    lastActivityAt: liveness.lastActivityAt ?? scan.mtime.toISOString(),
    liveness: liveness.liveness,
    livenessNote: liveness.livenessNote,
    endedReason: liveness.endedReason,
    pid: liveness.pid,
    partial: scan.partial,
    source: "reader",
    observedAt,
  };
}

/** Sum `cost-state.modelUsage` across every model into one session total (ADR 0026: "session
 * numbers are session numbers" — flock never splits, but it does sum across models it ran). */
function combinedModelUsage(byModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> | undefined) {
  if (!byModel || Object.keys(byModel).length === 0) return undefined;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const u of Object.values(byModel)) {
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.cacheReadTokens += u.cacheReadTokens;
    totals.cacheWriteTokens += u.cacheWriteTokens;
  }
  return totals;
}
