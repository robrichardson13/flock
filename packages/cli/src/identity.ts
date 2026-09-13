import { userInfo } from "node:os";
import { detectRuntime, normalizeRuntime, type Actor } from "@flock/core";
import { refineRunKey } from "@flock/harness/claude-code-self";
import { bool, str, type Parsed } from "./args.ts";

/**
 * Resolve the acting identity for one CLI invocation, including runtime metadata.
 * Precedence for harness/model/effort: explicit flag, then env var, then auto-detection
 * (Claude Code only today), then nothing. Never guess — an absent field renders as unknown.
 */
export function resolveActor(flags: Parsed["flags"]): Actor {
  const as = str(flags.as) ?? process.env.FLOCK_ACTOR;
  let kind: Actor["kind"] = as ? "agent" : "human";
  if (process.env.FLOCK_ACTOR_KIND === "human" || process.env.FLOCK_ACTOR_KIND === "agent") kind = process.env.FLOCK_ACTOR_KIND;
  if (bool(flags.human)) kind = "human";
  if (bool(flags.agent)) kind = "agent";
  let name = as;
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      name = "human";
    }
  }

  const detected = detectRuntime();
  const harness = str(flags.harness) ?? process.env.FLOCK_HARNESS ?? detected.harness;
  const model = str(flags.model) ?? process.env.FLOCK_MODEL ?? detected.model;
  const effort = str(flags.effort) ?? process.env.FLOCK_EFFORT ?? detected.effort;
  const explicitSession = str(flags.session) ?? process.env.FLOCK_SESSION;
  const session = explicitSession ?? refineSession(detected.session);
  const runtime = normalizeRuntime({ harness, model, effort, session });

  return { name, kind, ...runtime };
}

/**
 * ADR 0027: a detected Claude Code run key names the *parent* session even when the write comes
 * from a subagent, because the harness exposes no per-agent environment variable. `refineRunKey`
 * recovers the agent id from the subagent transcript Claude Code has already flushed, turning
 * `claude-code:<sid>` into `claude-code:<sid>#<agentId>` so telemetry reads the subagent's own
 * run and not the conductor's. Best effort: an unrecognisable layout leaves the key alone.
 */
function refineSession(detected: string | undefined): string | undefined {
  if (!detected) return undefined;
  return refineRunKey(detected, process.cwd(), process.argv.slice(2));
}

/** True when no `--as` or `FLOCK_ACTOR` was given, so the actor name fell back to the OS user. */
export function actorWasDefaulted(flags: Parsed["flags"]): boolean {
  return !(str(flags.as) ?? process.env.FLOCK_ACTOR);
}
