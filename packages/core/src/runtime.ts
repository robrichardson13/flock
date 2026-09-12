import type { Runtime } from "./types.ts";

const MAX_LEN = 64;
// Matches telemetry-types.ts's MAX_KEY_LENGTH: a session run key can be a lot longer than a
// harness/model/effort label (a uuid plus a subagent id), so it gets its own, longer cap.
const MAX_SESSION_LEN = 200;

/**
 * Trim, lowercase, and cap each field at 64 characters; drop empty strings. Freeform on
 * purpose — harnesses disagree about the effort ladder, and a rejected value is worse than
 * an unfamiliar one. `session` is the exception: it is an opaque lookup key (ADR 0023), so it
 * is trimmed and length-capped but never lowercased — a reader matches it byte for byte against
 * a case-sensitive session/agent id.
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
  const session = r.session?.trim().slice(0, MAX_SESSION_LEN);
  if (session) out.session = session;
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

    // ADR 0023: the run key is `<family>:<session id>`, family not version, so it survives a
    // harness upgrade mid-run. Inside a subagent this is still the *parent's* session id — there
    // is no per-agent env var — which is a known, documented coarseness (ADR 0023 §2).
    const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
    if (sessionId) out.session = `claude-code:${sessionId}`;
  }

  return out;
}
