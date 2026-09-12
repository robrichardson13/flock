/**
 * Every bound a reader must respect (ADR 0023 §2 "Limits"). Transcripts are attacker-shaped
 * input in the sense that matters — unbounded, machine-written, occasionally malformed — so
 * nothing here reads without a cap. Values are conservative defaults a caller may override; none
 * of them are policy, all of them are "how much work is this reader allowed to do".
 */

/** Bytes read from the tail of a transcript when hunting for a `cost-state` line. */
export const DEFAULT_TAIL_SCAN_BYTES = 512 * 1024;

/** Bytes read from the head of a transcript when building the tool-call histogram and start
 * time. A file larger than this is marked `partial`. */
export const DEFAULT_HEAD_SCAN_BYTES = 2 * 1024 * 1024;

/** Lines parsed out of either scan window, on top of the byte cap — a defense against a file
 * that is small but absurdly line-dense. */
export const DEFAULT_MAX_LINES = 20_000;

/** Distinct tool names kept in a reader's own histogram before core's stricter bound applies. */
export const DEFAULT_MAX_TOOL_HISTOGRAM_ENTRIES = 64;

/** Directory entries considered when globbing the model-catalog cache or the sessions/pid
 * directory. Both are small in practice; this is a hard ceiling, not a tuning knob. */
export const DEFAULT_MAX_FILES_GLOBBED = 64;

/** Wall-clock budget for any filesystem stat/read in this package. */
export const DEFAULT_READ_TIMEOUT_MS = 2_000;

/** Wall-clock budget for a `ps` invocation used to guard against pid reuse. */
export const DEFAULT_PROC_CHECK_TIMEOUT_MS = 1_500;

/** How much clock drift between the pid file's `procStart` and `ps`'s own reading is tolerated
 * before the two are called mismatched. Both are second-precision, human-formatted timestamps. */
export const PROC_START_TOLERANCE_MS = 2_000;

/**
 * How long a transcript can go unmodified before a live pid is read as "idle" rather than
 * "running". ADR 0023 §4 calls this "generous" — a single long tool call is normal — and leaves
 * the final number to card 7's stall detector. This default is a placeholder for that decision.
 */
export const DEFAULT_FRESH_WINDOW_MS = 15 * 60 * 1000;

export interface ScanLimits {
  tailScanBytes: number;
  headScanBytes: number;
  maxLines: number;
  maxToolHistogramEntries: number;
}

export function defaultScanLimits(overrides: Partial<ScanLimits> = {}): ScanLimits {
  return {
    tailScanBytes: overrides.tailScanBytes ?? DEFAULT_TAIL_SCAN_BYTES,
    headScanBytes: overrides.headScanBytes ?? DEFAULT_HEAD_SCAN_BYTES,
    maxLines: overrides.maxLines ?? DEFAULT_MAX_LINES,
    maxToolHistogramEntries: overrides.maxToolHistogramEntries ?? DEFAULT_MAX_TOOL_HISTOGRAM_ENTRIES,
  };
}
