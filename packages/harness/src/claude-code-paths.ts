/**
 * Path derivation for the Claude Code reader (ADR 0026 §"What the harnesses actually leave on
 * disk"). Every path here is a lookup key, not a round trip: the cwd encoding is lossy
 * (`.atlas` and `-atlas` collide), so a resolved path is a best-effort guess to try, never a
 * guarantee the file exists.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_FILES_GLOBBED } from "./limits.ts";

export const CLAUDE_CODE_FAMILY = "claude-code";

/** `~/.claude` by default; overridable so tests never touch the real home directory. */
export function claudeHome(override?: string): string {
  return override ?? join(homedir(), ".claude");
}

/** The cwd encoding: every non-alphanumeric character becomes `-`. Verified against 118 real
 * project directories on disk (card 4's research); no other characters survive. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function projectDir(home: string, cwd: string): string {
  return join(home, "projects", encodeCwd(cwd));
}

export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return join(projectDir(home, cwd), `${sessionId}.jsonl`);
}

/** A subagent's own transcript. `agentId` may or may not already carry the `agent-` prefix the
 * ADR's example run key shows (`#agent-6f2c…`); normalized once here so either form resolves. */
export function subagentTranscriptPath(home: string, cwd: string, sessionId: string, agentId: string): string {
  return join(projectDir(home, cwd), sessionId, "subagents", `agent-${normalizeAgentId(agentId)}.jsonl`);
}

/** A run key's `#<agentId>` suffix, normalized to the bare id (no `agent-` prefix). */
export function normalizeAgentId(agentId: string): string {
  return agentId.startsWith("agent-") ? agentId.slice("agent-".length) : agentId;
}

/**
 * The model-catalog cache files, newest first, bounded by `limit`. The filename is
 * content-hashed and the file expires weekly, so this must glob rather than hardcode a name.
 * Never throws: a missing/unreadable directory reads as no files.
 */
export async function findModelCatalogFiles(home: string, limit = DEFAULT_MAX_FILES_GLOBBED): Promise<string[]> {
  const dir = join(home, "cache", "model-catalog");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = names.filter((n) => n.startsWith("published-") && n.endsWith(".json")).slice(0, limit);
  const withMtime = await statAll(dir, candidates);
  return withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

async function statAll(dir: string, names: string[]): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = await stat(path);
      out.push({ path, mtimeMs: st.mtimeMs });
    } catch {
      // Vanished between readdir and stat, or unreadable: skip, never throw.
    }
  }
  return out;
}

/** `runtime.max_input_tokens` for `model` out of the newest catalog file, or undefined when the
 * catalog is missing, unparsable, or does not know the model. ADR 0026's consequence: never
 * guess a maximum — render the number without a bar rather than a fabricated ceiling. */
export async function contextMaxForModel(home: string, model: string, limit = DEFAULT_MAX_FILES_GLOBBED): Promise<number | undefined> {
  const files = await findModelCatalogFiles(home, limit);
  if (files.length === 0) return undefined;
  try {
    const text = await readFile(files[0], "utf8");
    return maxInputTokensFor(JSON.parse(text), model);
  } catch {
    return undefined;
  }
}

/** Type-guarded walk of `document.surfaces.cc.model_selector_config[0].models[]`. */
function maxInputTokensFor(catalog: unknown, model: string): number | undefined {
  const models = modelEntries(catalog);
  for (const entry of models) {
    if (isRecord(entry) && entry.id === model && isRecord(entry.runtime) && typeof entry.runtime.max_input_tokens === "number") {
      return entry.runtime.max_input_tokens;
    }
  }
  return undefined;
}

function modelEntries(catalog: unknown): unknown[] {
  if (!isRecord(catalog)) return [];
  const surfaces = isRecord(catalog.document) ? catalog.document.surfaces : undefined;
  const cc = isRecord(surfaces) ? surfaces.cc : undefined;
  const configs = isRecord(cc) ? cc.model_selector_config : undefined;
  const first = Array.isArray(configs) ? configs[0] : undefined;
  const models = isRecord(first) ? first.models : undefined;
  return Array.isArray(models) ? models : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
