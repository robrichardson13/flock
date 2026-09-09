/**
 * Where flock keeps its own state on disk.
 *
 * This lives in its own module rather than in daemon.ts because the auto-update path (update.ts)
 * needs it on *every* CLI invocation, and importing daemon.ts would drag dev.ts and its checkout
 * resolution into the startup of `flock claim`. daemon.ts re-exports `flockHome` so its existing
 * importers are unaffected.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DB_DIRNAME } from "@flock/core";

/** `~/.flock`, or `FLOCK_HOME` when set. Everything flock writes outside a database lives under it. */
export function flockHome(): string {
  return process.env.FLOCK_HOME ? resolve(process.env.FLOCK_HOME) : join(homedir(), DB_DIRNAME);
}

/**
 * `~/.flock/skill.md` (`$FLOCK_HOME/skill.md` when set): the user's standing personalization of
 * the flock skill (see ADR 0014). Optional, and flock never writes or reads it itself — the skill
 * text tells the conductor to read it at run start. This function only computes the path so
 * `flock setup` can report whether it exists.
 */
export function personalizationPath(): string {
  return join(flockHome(), "skill.md");
}
