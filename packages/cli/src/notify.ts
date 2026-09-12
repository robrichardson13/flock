import { FlockError, type NotifySettings, type NotifySettingsFields } from "@flock/core";
import { str, type Parsed } from "./args.ts";

// ADR 0024: `flock notify settings`/`flock notify set` read and write the per-actor,
// per-board-overridable settings core stores in `notify_settings`. This module holds the pure
// parsing/formatting so `main.ts`'s command dispatch stays a thin call into it.

/** One toggle's CLI flag name, the field it writes on `NotifySettingsFields`, and its label for
 *  human output. Ordered urgent-to-chatty, same as the ADR's settings sheet. */
export const NOTIFY_TOGGLES = [
  { flag: "needs-me", field: "needsMe", label: "needs-me" },
  { flag: "review", field: "review", label: "review" },
  { flag: "everything", field: "info", label: "everything" },
  { flag: "settled", field: "settled", label: "settled" },
] as const satisfies readonly { flag: string; field: keyof NotifySettingsFields; label: string }[];

/** "on"/"off" (case-insensitive) to a boolean. Anything else is a usage error naming the flag. */
export function parseOnOff(value: string, flagName: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "on") return true;
  if (v === "off") return false;
  throw new FlockError(`--${flagName} must be "on" or "off", got "${value}"`, "invalid");
}

/** "30m", "2h", or a bare number of minutes ("30") to milliseconds. Range clamping is core's job
 *  (`clampSettledThreshold`); this only parses the shape. */
export function parseThreshold(value: string): number {
  const m = /^(\d+)\s*(m|h)?$/i.exec(value.trim());
  if (!m) throw new FlockError(`--threshold must look like "30m" or "2h", got "${value}"`, "invalid");
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return unit === "h" ? n * 60 * 60_000 : n * 60_000;
}

/** Milliseconds back to the compact form `parseThreshold` accepts, for round-tripping in output. */
export function formatThreshold(ms: number): string {
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Builds the patch `Flock.putNotifySettings` takes from `flock notify set`'s flags. Only flags the
 * caller actually passed appear in the result — an absent flag must leave the stored value alone,
 * never overwrite it with a default. Throws on an unparseable `on`/`off` or threshold.
 */
export function buildNotifyPatch(flags: Parsed["flags"]): Partial<NotifySettingsFields> {
  const patch: Partial<NotifySettingsFields> = {};
  for (const t of NOTIFY_TOGGLES) {
    const raw = str(flags[t.flag]);
    if (raw === undefined) continue;
    patch[t.field] = parseOnOff(raw, t.flag);
  }
  const threshold = str(flags.threshold);
  if (threshold !== undefined) patch.settledAfterMs = parseThreshold(threshold);
  return patch;
}

/** True when `buildNotifyPatch` would find nothing to change — the "you passed no flags" guard. */
export function isEmptyPatch(patch: Partial<NotifySettingsFields>): boolean {
  return Object.keys(patch).length === 0;
}

type Source = "board" | "global" | "default";

/** Where one field's effective value came from: a board override, the actor's global row, or the
 *  built-in default. Mirrors `resolveNotifySettingsFields`'s own precedence. */
function sourceOf(field: keyof NotifySettingsFields, board: NotifySettingsFields | null, global: NotifySettingsFields | null): Source {
  if (board?.[field] != null) return "board";
  if (global?.[field] != null) return "global";
  return "default";
}

/**
 * Human-readable lines for `flock notify settings`. `boardId` `""` means the global row itself —
 * there is no board override to report, so every field's source is `global` or `default`.
 */
export function formatNotifySettings(opts: {
  boardId: string;
  boardLabel: string;
  resolved: NotifySettings;
  board: NotifySettingsFields | null;
  global: NotifySettingsFields | null;
}): string[] {
  const { boardId, boardLabel, resolved, board, global } = opts;
  const lines = [`Notify settings — ${boardLabel}:`];
  for (const t of NOTIFY_TOGGLES) {
    const value = resolved[t.field];
    const source = boardId === "" ? (global?.[t.field] != null ? "global" : "default") : sourceOf(t.field, board, global);
    const shown = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
    lines.push(`  ${t.label.padEnd(11)} ${shown.padEnd(4)} (${source})`);
  }
  const thresholdSource = boardId === "" ? (global?.settledAfterMs != null ? "global" : "default") : sourceOf("settledAfterMs", board, global);
  lines.push(`  ${"threshold".padEnd(11)} ${formatThreshold(resolved.settledAfterMs).padEnd(4)} (${thresholdSource})`);
  return lines;
}
