import { userInfo } from "node:os";
import { detectRuntime, normalizeRuntime, type Actor } from "@flock/core";
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
  const runtime = normalizeRuntime({ harness, model, effort });

  return { name, kind, ...runtime };
}
