import type { Runtime } from "./types.ts";

const MAX_LEN = 64;

/**
 * Trim, lowercase, and cap each field at 64 characters; drop empty strings. Freeform on
 * purpose — harnesses disagree about the effort ladder, and a rejected value is worse than
 * an unfamiliar one.
 */
export function normalizeRuntime(r: Runtime): Runtime {
  const clean = (v: string | undefined): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const trimmed = v.trim().toLowerCase().slice(0, MAX_LEN);
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const out: Runtime = {};
  const harness = clean(r.harness);
  const model = clean(r.model);
  const effort = clean(r.effort);
  if (harness !== undefined) out.harness = harness;
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  return out;
}

/**
 * Detect what we can from the environment. Never guesses the model: no environment variable
 * exposed by any known harness names it, so leaving it undefined is more honest than a wrong
 * default. Claude Code is the only detector shipped today.
 */
export function detectRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const out: Runtime = {};

  const aiAgent = env.AI_AGENT;
  if (env.CLAUDECODE === "1" || (aiAgent && aiAgent.startsWith("claude-code"))) {
    let harness = "claude-code";
    if (aiAgent) {
      // "claude-code_2-1-261_agent" -> version segment "2-1-261" -> "2.1.261"
      const match = aiAgent.match(/^claude-code_([0-9]+(?:-[0-9]+)*)_/);
      if (match) harness = `claude-code@${match[1].replace(/-/g, ".")}`;
    }
    if (harness === "claude-code" && env.CLAUDE_CODE_EXECPATH) {
      // Fall back to the trailing path segment, e.g. ".../versions/2.1.261" -> "2.1.261".
      const segment = env.CLAUDE_CODE_EXECPATH.split("/").filter(Boolean).pop();
      if (segment && /^[0-9]+(\.[0-9]+)*$/.test(segment)) harness = `claude-code@${segment}`;
    }
    out.harness = harness;
    if (env.CLAUDE_EFFORT) out.effort = env.CLAUDE_EFFORT;
  }

  return out;
}
