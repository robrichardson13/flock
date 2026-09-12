/**
 * Bounded line-by-line parsing of one Claude Code transcript (ADR 0026
 * "What the harnesses actually leave on disk" and "Limits"). Every read here is capped by bytes
 * and by line count; a malformed line is skipped and counted, never thrown from.
 */
import { stat } from "node:fs/promises";
import { defaultScanLimits, type ScanLimits } from "./limits.ts";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LastAssistant {
  model?: string;
  usage?: UsageTotals;
}

export interface CostState {
  totalCostUSD?: number;
  totalDuration?: number;
  totalAPIDuration?: number;
  totalToolDuration?: number;
  hasUnknownModelCost?: boolean;
  /** Per-model split, summed for the session's token totals. */
  tokensByModel: Record<string, UsageTotals>;
}

export interface TranscriptScan {
  /** First timestamp seen in the file (head scan only). */
  startedAt?: string;
  lastAssistant?: LastAssistant;
  /** Tool-call histogram, bounded to `limits.maxToolHistogramEntries` distinct names. */
  tools: Record<string, number>;
  toolCalls: number;
  costState?: CostState;
  /** True when the head scan, the tail scan, or the tool histogram hit a bound before finishing. */
  partial: boolean;
  /** File mtime: the liveness clock (ADR 0026 — "the only per-subagent liveness signal"). */
  mtime: Date;
}

/** Scan a transcript for everything a session reading needs, or null if the file cannot even be
 * stat'd (missing, permission denied, not a file). Never throws. */
export async function scanTranscript(path: string, limits: ScanLimits = defaultScanLimits()): Promise<TranscriptScan | null> {
  let mtime: Date;
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    mtime = st.mtime;
    size = st.size;
  } catch {
    return null;
  }

  const headPartial = size > limits.headScanBytes;
  const head = await readWindow(path, 0, Math.min(size, limits.headScanBytes));
  // The tail window: reuse `head` when it already covers the whole file, otherwise read the
  // file's actual tail (falling back to a full re-read when the file fits within the tail
  // budget even though it did not fit within the smaller head budget).
  const tail = !headPartial ? head : await readWindow(path, Math.max(0, size - limits.tailScanBytes), size);

  const headLines = boundLines(head.lines, limits.maxLines, headPartial);
  const tailLines = tail === head ? headLines : boundLines(tail.lines, limits.maxLines, size > limits.tailScanBytes);

  const { startedAt } = firstTimestamp(headLines.lines);
  const { tools, toolCalls, partial: toolsPartial } = toolHistogram(headLines.lines, limits.maxToolHistogramEntries);
  const lastAssistant = lastAssistantOf(tailLines.lines);
  const costState = lastCostStateOf(tailLines.lines);

  return {
    startedAt,
    lastAssistant,
    tools,
    toolCalls,
    costState,
    partial: headPartial || headLines.truncated || tailLines.truncated || toolsPartial,
    mtime,
  };
}

/** Read `[start, end)` bytes of a file and split into complete lines (the leading partial line
 * from a byte-offset tail read is dropped since it cannot be a whole JSON object). */
async function readWindow(path: string, start: number, end: number): Promise<{ lines: string[] }> {
  if (end <= start) return { lines: [] };
  const text = await Bun.file(path).slice(start, end).text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (start > 0 && lines.length > 0) lines.shift();
  return { lines };
}

function boundLines(lines: string[], maxLines: number, alreadyPartial: boolean): { lines: string[]; truncated: boolean } {
  if (lines.length <= maxLines) return { lines, truncated: alreadyPartial };
  return { lines: lines.slice(-maxLines), truncated: true };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstTimestamp(lines: string[]): { startedAt?: string } {
  for (const line of lines) {
    const obj = parseLine(line);
    if (obj && typeof obj.timestamp === "string") return { startedAt: obj.timestamp };
  }
  return {};
}

/** One pass over `assistant.message.content[]`, counting `tool_use` blocks by name, capped at
 * `maxEntries` distinct tool names — a reader that saw more has already lost the tail. */
function toolHistogram(lines: string[], maxEntries: number): { tools: Record<string, number>; toolCalls: number; partial: boolean } {
  const counts = new Map<string, number>();
  let toolCalls = 0;
  let partial = false;
  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj || obj.type !== "assistant") continue;
    for (const name of toolUseNames(obj)) {
      toolCalls++;
      if (!counts.has(name) && counts.size >= maxEntries) {
        partial = true;
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return { tools: Object.fromEntries(counts), toolCalls, partial };
}

function toolUseNames(assistantLine: Record<string, unknown>): string[] {
  const message = assistantLine.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const names: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") names.push(block.name);
  }
  return names;
}

/** The last `assistant` line's model and context-usage triple: `input + cache_read +
 * cache_creation`, exactly what Claude Code's own statusline sums (ADR 0026). */
function lastAssistantOf(lines: string[]): LastAssistant | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseLine(lines[i]);
    if (!obj || obj.type !== "assistant" || !isRecord(obj.message)) continue;
    const message = obj.message;
    const model = typeof message.model === "string" ? message.model : undefined;
    const usage = isRecord(message.usage) ? usageOf(message.usage) : undefined;
    return { model, usage };
  }
  return undefined;
}

function usageOf(usage: Record<string, unknown>): UsageTotals {
  return {
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cacheReadTokens: numberOr(usage.cache_read_input_tokens, 0),
    cacheWriteTokens: numberOr(usage.cache_creation_input_tokens, 0),
  };
}

/** `cost-state` can appear more than once and is not always the last line: take the last one
 * seen, and it is absent while the session is live. */
function lastCostStateOf(lines: string[]): CostState | undefined {
  let found: CostState | undefined;
  for (const line of lines) {
    const obj = parseLine(line);
    if (obj && obj.type === "cost-state") found = costStateOf(obj);
  }
  return found;
}

function costStateOf(obj: Record<string, unknown>): CostState {
  return {
    totalCostUSD: numberOrUndefined(obj.totalCostUSD),
    totalDuration: numberOrUndefined(obj.totalDuration),
    totalAPIDuration: numberOrUndefined(obj.totalAPIDuration),
    totalToolDuration: numberOrUndefined(obj.totalToolDuration),
    hasUnknownModelCost: typeof obj.hasUnknownModelCost === "boolean" ? obj.hasUnknownModelCost : undefined,
    tokensByModel: modelUsageOf(obj.modelUsage),
  };
}

function modelUsageOf(modelUsage: unknown): Record<string, UsageTotals> {
  if (!isRecord(modelUsage)) return {};
  const out: Record<string, UsageTotals> = {};
  for (const [model, v] of Object.entries(modelUsage)) {
    if (!isRecord(v)) continue;
    out[model] = {
      inputTokens: numberOr(v.inputTokens, 0),
      outputTokens: numberOr(v.outputTokens, 0),
      cacheReadTokens: numberOr(v.cacheReadInputTokens, 0),
      cacheWriteTokens: numberOr(v.cacheCreationInputTokens, 0),
    };
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
