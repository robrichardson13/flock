/**
 * `flock setup --hooks` / `--no-hooks` / `--remove-hooks` (ADR 0023 §2 "Is mutating
 * ~/.claude/settings.json acceptable?"). Writes a marked `SessionEnd` + `SubagentStop` hook entry
 * that invokes `flock telemetry record`, on the same terms `path-setup.ts` already established
 * for the PATH line it writes into a shell rc: never silent, marked, additive, opt-out-able
 * before the fact (`FLOCK_NO_HOOKS`), undoable after it (`--remove-hooks`), and a parse failure
 * means flock writes nothing rather than guessing at a file it does not understand.
 *
 * `flock setup`'s default (opt-in vs opt-out) is decided by the caller in setup.ts; this module
 * only knows how to install, detect, and remove one marked entry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The fixed marker identifying flock's hook entries, read back to decide idempotency and to
 * find exactly what to remove. Never change this string. */
export const HOOKS_MARKER = "harness-telemetry";

/** `~/.claude/settings.json`, or `CLAUDE_SETTINGS_PATH` when set (the test hook, mirroring
 * `CLAUDE_SKILLS_DIR` in setup.ts). `$HOME` is read directly so a reassigned HOME in a test moves
 * the destination without this module needing a parameter threaded through every caller. */
export function claudeSettingsPath(): string {
  if (process.env.CLAUDE_SETTINGS_PATH) return process.env.CLAUDE_SETTINGS_PATH;
  return join(process.env.HOME || homedir(), ".claude", "settings.json");
}

/** The hook command flock installs: `hookCommand()` so a test can assert on it without
 * hardcoding the binary name twice. */
function hookCommand(): string {
  return "flock telemetry record";
}

/** One flock-marked hook entry, in the shape Claude Code's settings.json expects under
 * `hooks.<EventName>`: an array of matcher groups, each an array of hook commands. */
function markedEntry(): { _flock: string; matcher: string; hooks: { type: "command"; command: string }[] } {
  return { _flock: HOOKS_MARKER, matcher: "*", hooks: [{ type: "command", command: hookCommand() }] };
}

type SettingsJson = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

/** `FLOCK_NO_HOOKS=1` (or any non-empty, non-`0`/`false` value) opts out, matching
 * `isNoModifyPath`'s fail-closed rule: an unwanted install costs more than a missed opt-out. */
export function isNoHooks(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

export type HooksResult =
  | { action: "installed" | "already-installed" | "removed" | "nothing-to-remove"; path: string }
  | { action: "parse-error"; path: string; message: string };

/** True when an array of hook matcher groups already carries flock's marked entry. */
function hasMarkedEntry(group: unknown[] | undefined): boolean {
  return Array.isArray(group) && group.some((g) => g && typeof g === "object" && (g as { _flock?: string })._flock === HOOKS_MARKER);
}

type ReadResult = { ok: true; settings: SettingsJson } | { ok: false; message: string };

function readSettings(path: string): ReadResult {
  if (!existsSync(path)) return { ok: true, settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "top-level JSON was not an object" };
    return { ok: true, settings: parsed as SettingsJson };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Writes `settings` to `path` via temp-file-and-rename, so a reader never sees a half-written file. */
function writeSettings(path: string, settings: SettingsJson): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, path);
}

const HOOK_EVENTS = ["SessionEnd", "SubagentStop"] as const;

/** Installs the marked `SessionEnd`/`SubagentStop` entries into `~/.claude/settings.json`.
 * Idempotent: an entry already present for an event is left untouched, not duplicated. A file
 * that fails to parse is never written to — flock reports the reason and touches nothing. */
export function installHooks(): HooksResult {
  const path = claudeSettingsPath();
  const read = readSettings(path);
  if (!read.ok) return { action: "parse-error", path, message: read.message };
  const settings = read.settings;

  const hooks: Record<string, unknown[]> = { ...(settings.hooks ?? {}) };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (hasMarkedEntry(existing)) continue;
    hooks[event] = [...existing, markedEntry()];
    changed = true;
  }
  if (!changed) return { action: "already-installed", path };

  writeSettings(path, { ...settings, hooks });
  return { action: "installed", path };
}

/** Removes exactly flock's marked entries, byte for byte, leaving every other hook and setting
 * untouched. An event array left empty after removal is deleted rather than kept as `[]`. */
export function removeHooks(): HooksResult {
  const path = claudeSettingsPath();
  const read = readSettings(path);
  if (!read.ok) return { action: "parse-error", path, message: read.message };
  const settings = read.settings;
  if (!settings.hooks) return { action: "nothing-to-remove", path };

  const hooks: Record<string, unknown[]> = { ...settings.hooks };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const existing = hooks[event];
    if (!Array.isArray(existing)) continue;
    const kept = existing.filter((g) => !(g && typeof g === "object" && (g as { _flock?: string })._flock === HOOKS_MARKER));
    if (kept.length === existing.length) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!changed) return { action: "nothing-to-remove", path };

  const next: SettingsJson = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  writeSettings(path, next);
  return { action: "removed", path };
}

export function reportHooksResult(result: HooksResult, json: boolean): void {
  if (json) return;
  switch (result.action) {
    case "installed":
      console.log(`flock: installed the harness-telemetry hooks in ${result.path}`);
      return;
    case "already-installed":
      console.log(`flock: harness-telemetry hooks already installed in ${result.path}`);
      return;
    case "removed":
      console.log(`flock: removed the harness-telemetry hooks from ${result.path}`);
      return;
    case "nothing-to-remove":
      console.log(`flock: no harness-telemetry hooks found in ${result.path}`);
      return;
    case "parse-error":
      console.error(`flock: could not parse ${result.path} (${result.message}); left it untouched. Not installing hooks.`);
      return;
  }
}
