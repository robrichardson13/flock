/**
 * `flock setup`: writes the Claude Code skill onto disk and starts the daemon. See ADR 0012
 * (card F). Two independent effects, both idempotent:
 *
 *  - Copy the embedded `SKILL.md` (from runtime.ts — a real file on disk in a checkout, an
 *    embedded one in a compiled binary) to `~/.claude/skills/flock/SKILL.md`, via a temp file
 *    and rename so a reader never sees a half-written file. A destination that is itself a
 *    symlink (a contributor pointing the skill at a checkout) is left alone: `flock setup`
 *    refuses to clobber it and says so on stderr, exit 0.
 *  - `flock up`, unless `--no-start` or `--skill-only`.
 *
 * `~/.flock/skill.json` records what was written ({version, sha256, writtenAt, path}). It is a
 * record, not a cache: "identical" is decided by hashing the destination file itself, so a
 * SKILL.md that was hand-edited or half-written gets repaired rather than trusted.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { flockHome } from "./daemon.ts";
import { skillPath, version } from "./runtime.ts";

export interface SetupOptions {
  json: boolean;
  noStart?: boolean;
  skillOnly?: boolean;
}

export interface SkillRecord {
  version: string;
  sha256: string;
  writtenAt: string;
  path: string;
}

/**
 * `~/.claude/skills`, or `CLAUDE_SKILLS_DIR` when set. `$HOME` itself is the test hook, read
 * directly so it is explicit that a reassigned `HOME` moves the destination — `homedir()` is only
 * the fallback for the case where `HOME` is unset at all.
 */
export function claudeSkillsDir(): string {
  if (process.env.CLAUDE_SKILLS_DIR) return process.env.CLAUDE_SKILLS_DIR;
  return join(process.env.HOME ?? homedir(), ".claude", "skills");
}

/** Where `flock setup` would write the skill: `<claudeSkillsDir>/flock/SKILL.md`. */
export function skillDestPath(): string {
  return join(claudeSkillsDir(), "flock", "SKILL.md");
}

export const skillJsonPath = () => join(flockHome(), "skill.json");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** True when `path`, or its containing `flock` directory, is a symlink — never write through it. */
function isSymlinked(path: string): boolean {
  const dir = dirname(path);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return true;
  return existsSync(path) && lstatSync(path).isSymbolicLink();
}

function readSkillRecord(): SkillRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    if (raw && typeof raw.sha256 === "string") return raw as SkillRecord;
  } catch {
    // no record yet, or it's junk — treat as "never written"
  }
  return undefined;
}

/** Stamp `~/.flock/skill.json` with what is now on disk at `dest`. */
function recordSkill(hash: string, dest: string): void {
  mkdirSync(flockHome(), { recursive: true });
  const next: SkillRecord = { version: version(), sha256: hash, writtenAt: new Date().toISOString(), path: dest };
  writeFileSync(skillJsonPath(), JSON.stringify(next, null, 2) + "\n");
}

export type SkillResult = { action: "symlink-preserved" | "up-to-date" | "written"; dest: string };

/**
 * Writes `~/.claude/skills/flock/SKILL.md` from the embedded copy, unless the destination is a
 * contributor's symlink. Idempotent: an identical hash already recorded is a no-op.
 */
export function writeSkill(): SkillResult {
  const dest = skillDestPath();
  if (isSymlinked(dest)) {
    console.error(`flock setup: ${dirname(dest)} is a symlink (a contributor checkout), leaving it alone`);
    return { action: "symlink-preserved", dest };
  }

  const content = readFileSync(skillPath, "utf8");
  const hash = sha256(content);
  // The destination file itself is the source of truth, not skill.json: a hand-edited, truncated or
  // half-written SKILL.md must be repaired by the next `setup`, and trusting a recorded hash would
  // leave it broken forever. It is a few KB — hashing it every time is cheaper than being wrong.
  const onDisk = existsSync(dest) ? sha256(readFileSync(dest, "utf8")) : undefined;
  if (onDisk === hash) {
    // Right content, but the record may still name an older release (an upgrade whose SKILL.md did
    // not change) or a stale path. Keep skill.json honest about which version last vouched for it.
    const record = readSkillRecord();
    if (record?.sha256 !== hash || record.version !== version() || record.path !== dest) {
      recordSkill(hash, dest);
    }
    return { action: "up-to-date", dest };
  }

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.SKILL.md.tmp-${process.pid}`);
  writeFileSync(tmp, content);
  renameSync(tmp, dest);
  recordSkill(hash, dest);

  return { action: "written", dest };
}

/** `flock setup`: write the skill, then `flock up` unless `--no-start`/`--skill-only`. */
export async function setupCommand(opts: SetupOptions): Promise<void> {
  const skill = writeSkill();

  if (opts.json) {
    console.log(JSON.stringify({ skill: skill.action, dest: skill.dest }));
  } else if (skill.action === "up-to-date") {
    console.log(`skill up to date: ${skill.dest}`);
  } else if (skill.action === "written") {
    console.log(`wrote skill: ${skill.dest}`);
  }

  if (opts.skillOnly || opts.noStart) return;

  const { daemonCommand } = await import("./daemon.ts");
  await daemonCommand("up", { json: opts.json });
}
