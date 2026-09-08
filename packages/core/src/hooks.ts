import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DB_DIRNAME } from "./db.ts";
import type { Actor } from "./types.ts";

/** Error codes a hook failure can carry; the server maps these to HTTP status. */
export type HookErrorCode = "hook_failed" | "hook_timeout" | "hook_output_invalid" | "hook_unsafe";

export class HookError extends Error {
  constructor(
    message: string,
    public code: HookErrorCode,
  ) {
    super(message);
    this.name = "HookError";
  }
}

/** `~/.flock/hooks`, or `FLOCK_HOOKS_DIR` when set (tests, a second profile). */
export function hooksDir(): string {
  if (process.env.FLOCK_HOOKS_DIR) return resolve(process.env.FLOCK_HOOKS_DIR);
  return join(homedir(), DB_DIRNAME, "hooks");
}

export interface HookRef {
  path: string;
}

/** Hook names are file names, never paths: an event reaching here from an HTTP route must not traverse. */
const EVENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Owner-only-writable and owned by us. `what` names the thing for the error message. */
function assertNotWritableByOthers(st: { uid: number; mode: number }, what: string, uid: number | undefined): void {
  if (uid !== undefined && st.uid !== uid) {
    throw new HookError(`${what} is not owned by the current user; refusing to run it`, "hook_unsafe");
  }
  if (st.mode & 0o002) throw new HookError(`${what} is world-writable; refusing to run it`, "hook_unsafe");
  if (st.mode & 0o020) throw new HookError(`${what} is group-writable; refusing to run it`, "hook_unsafe");
}

/**
 * Resolve the executable for `event` under `hooksDir()` (or `opts.hooksDir`).
 *
 * Returns `null` when no such file exists — a hook is simply not installed, not an error. The same
 * for a directory or a dangling symlink at the path: there is nothing runnable there, and refusing
 * loudly would be noise. When the file exists but is unsafe to run this throws `HookError` with
 * code `hook_unsafe`, which is a distinct signal from "not installed": the file is present, and
 * someone should fix its permissions or ownership.
 *
 * Unsafe means any of:
 * - the containing directory is not owned by us, or is group/world writable — anyone who can write
 *   the directory can replace the hook with their own file, so the file's own bits prove nothing;
 * - a symlink at the hook path whose *link* is not ours (the link decides what runs);
 * - the resolved file is not owned by us, or is group/world writable;
 * - the resolved file has no owner-execute bit (the opt-in, per ADR 0008).
 *
 * Ownership is strict: ADR 0008 says "owned by the running user", so even a root-owned hook is
 * refused rather than special-cased.
 *
 * Only the immediate hooks directory is checked, not every ancestor. A world-writable `$HOME` or
 * `/` is a compromise this guard cannot meaningfully paper over, and walking to the root would
 * refuse to run on machines whose `/tmp`-rooted `FLOCK_HOOKS_DIR` is perfectly fine.
 */
export function findHook(event: string, opts?: { hooksDir?: string }): HookRef | null {
  if (!EVENT_NAME.test(event)) {
    throw new HookError(`"${event}" is not a valid hook name; refusing to look for it`, "hook_unsafe");
  }
  const dir = opts?.hooksDir ?? hooksDir();
  const path = join(dir, event);
  const uid = currentUid();

  // The directory first: its writability decides who gets to choose the file.
  let dirSt: ReturnType<typeof statSync>;
  try {
    dirSt = statSync(dir);
  } catch {
    return null; // no hooks directory at all: nothing is installed
  }
  if (!dirSt.isDirectory()) return null;

  // A symlink at the hook path is allowed (`ln -s ~/bin/my-hook ~/.flock/hooks/board-create` is a
  // reasonable way to install one) but the link itself must be ours: whoever owns the link chooses
  // the target. Its own mode bits are meaningless (always 0777), so only ownership is checked here.
  let linkSt: ReturnType<typeof lstatSync>;
  try {
    linkSt = lstatSync(path);
  } catch {
    return null;
  }
  if (linkSt.isSymbolicLink()) {
    assertNotWritableByOthers({ uid: linkSt.uid, mode: 0 }, `hook "${event}" (the symlink at ${path})`, uid);
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path); // follows the symlink; the target is what actually runs
  } catch {
    return null; // dangling symlink
  }
  if (!st.isFile()) return null;

  assertNotWritableByOthers(dirSt, `the hooks directory ${dir}`, uid);
  assertNotWritableByOthers(st, `hook "${event}"`, uid);
  if (!(st.mode & 0o100)) {
    throw new HookError(`hook "${event}" is not executable (owner execute bit is not set); refusing to run it`, "hook_unsafe");
  }
  if (linkSt.isSymbolicLink()) {
    // The target's own directory is as swappable as ours was; check it too.
    let targetDir: ReturnType<typeof statSync>;
    const real = realpathSync(path);
    try {
      targetDir = statSync(dirname(real));
    } catch {
      return null;
    }
    assertNotWritableByOthers(targetDir, `the directory holding hook "${event}" (${dirname(real)})`, uid);
  }

  return { path };
}

export type HookMode = "describe" | "create";

export interface HookPayload {
  event: string;
  actor?: Actor;
  title?: string;
  /** Declared-field values; a checkbox is a boolean, everything else a string. */
  inputs?: Record<string, string | boolean | number>;
  dbPath?: string;
}

export interface HookResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS: Record<HookMode, number> = { create: 60_000, describe: 5_000 };
const KILL_GRACE_MS = 2_000;
/** After the hook exits, how long we keep reading pipes a surviving grandchild may still hold open. */
const READER_GRACE_MS = 1_000;
const STDERR_TAIL_BYTES = 4096;
const STDERR_TAIL_LINES = 20;
/** Kept from the *end* of each stream, so the last-non-empty-line contract survives a chatty hook. */
const STDOUT_TAIL_BYTES = 256 * 1024;
const STDERR_BUFFER_BYTES = 64 * 1024;
/** A single env value larger than this is dropped from the mirror; stdin JSON still carries it. */
const MAX_ENV_VALUE_BYTES = 32 * 1024;
/** At most this many `FLOCK_INPUT_*` entries, so a caller cannot blow the exec environment (E2BIG). */
const MAX_ENV_INPUTS = 100;

/** Every control variable the mirror owns. Set or deleted on every run so the parent's env cannot leak in. */
const CONTROL_ENV_KEYS = ["FLOCK_EVENT", "FLOCK_HOOK_VERSION", "FLOCK_TITLE", "FLOCK_ACTOR", "FLOCK_ACTOR_KIND", "FLOCK_DB"] as const;

/** `repo` -> `FLOCK_INPUT_REPO`; non-alphanumerics become `_`. Null when the name has nothing to key on. */
function inputEnvKey(name: string): string | null {
  const suffix = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (!/[A-Z0-9]/.test(suffix)) return null;
  return `FLOCK_INPUT_${suffix}`;
}

function tailStderr(text: string): string {
  const tail = text.length > STDERR_TAIL_BYTES ? text.slice(-STDERR_TAIL_BYTES) : text;
  const lines = tail.split("\n");
  return lines.length > STDERR_TAIL_LINES ? lines.slice(-STDERR_TAIL_LINES).join("\n") : tail;
}

/**
 * Read a child pipe to EOF, keeping only the last `maxBytes`, and give up when `signal` aborts.
 * Both bounds matter: a hook that prints gigabytes must not be buffered whole, and a hook whose
 * grandchildren inherit the pipe and outlive it must not hold the request open forever.
 */
async function drainTail(stream: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
      total += value.length;
      while (chunks.length > 1 && total - chunks[0]!.length >= maxBytes) {
        total -= chunks.shift()!.length;
      }
    }
  } catch {
    // cancelled, or the pipe broke: whatever we have is the answer
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const tail = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined;
  return new TextDecoder().decode(tail);
}

function resolveTimeout(mode: HookMode, explicit?: number): number {
  const candidates = [explicit, process.env.FLOCK_HOOK_TIMEOUT_MS === undefined ? undefined : Number(process.env.FLOCK_HOOK_TIMEOUT_MS)];
  for (const c of candidates) {
    if (c !== undefined && Number.isFinite(c) && c > 0) return c;
  }
  return DEFAULT_TIMEOUT_MS[mode];
}

/**
 * Spawn `path` with argv `[mode]`, the payload as stdin JSON, and an env mirror
 * (`FLOCK_EVENT`, `FLOCK_HOOK_VERSION`, `FLOCK_TITLE`, `FLOCK_ACTOR`, `FLOCK_ACTOR_KIND`,
 * `FLOCK_DB`, `FLOCK_INPUT_<KEY>` per declared input). Never throws for a hook that fails,
 * times out or writes garbage — that is `result.ok` / `result.timedOut`, so the caller decides
 * what HTTP status or CLI exit code it becomes.
 *
 * Nothing is interpolated into a shell: argv is exactly `[path, mode]` and every value the caller
 * supplies travels as an environment entry or as stdin JSON. `FLOCK_INPUT_*` names are prefixed, so
 * an input called `event`, `title` or `db` becomes `FLOCK_INPUT_EVENT` and cannot shadow a control
 * variable; the control variables and any inherited `FLOCK_INPUT_*` are set or deleted on every
 * run, so a server started with `FLOCK_ACTOR`/`FLOCK_DB` in its own environment does not leak them
 * into a hook whose payload omitted them.
 *
 * Timeout: `opts.timeoutMs`, else `FLOCK_HOOK_TIMEOUT_MS`, else 60s for `create` / 5s for
 * `describe` (a non-numeric or non-positive override is ignored rather than being taken as zero).
 * On timeout: SIGTERM, then SIGKILL after a 2s grace period.
 */
export async function runHook(path: string, mode: HookMode, payload: HookPayload, opts?: { timeoutMs?: number }): Promise<HookResult> {
  const timeoutMs = resolveTimeout(mode, opts?.timeoutMs);

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FLOCK_INPUT_")) delete env[key];
  }
  for (const key of CONTROL_ENV_KEYS) delete env[key];

  const mirror = (key: string, value: string) => {
    if (Buffer.byteLength(value) <= MAX_ENV_VALUE_BYTES) env[key] = value;
  };
  mirror("FLOCK_EVENT", payload.event);
  mirror("FLOCK_HOOK_VERSION", "1");
  if (payload.title !== undefined) mirror("FLOCK_TITLE", payload.title);
  if (payload.actor?.name !== undefined) mirror("FLOCK_ACTOR", payload.actor.name);
  if (payload.actor?.kind !== undefined) mirror("FLOCK_ACTOR_KIND", payload.actor.kind);
  if (payload.dbPath !== undefined) mirror("FLOCK_DB", payload.dbPath);

  let mirrored = 0;
  for (const [key, value] of Object.entries(payload.inputs ?? {})) {
    if (mirrored >= MAX_ENV_INPUTS) break;
    // Objects, arrays, null and undefined have no sensible flat spelling; they stay in stdin JSON
    // only, rather than reaching a hook as "[object Object]".
    if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") continue;
    const envKey = inputEnvKey(key);
    if (!envKey) continue;
    mirror(envKey, typeof value === "boolean" ? (value ? "1" : "") : String(value));
    mirrored++;
  }

  const stdin = JSON.stringify({
    event: payload.event,
    version: 1,
    actor: payload.actor,
    title: payload.title,
    inputs: payload.inputs ?? {},
    dbPath: payload.dbPath,
  });

  const proc = Bun.spawn([path, mode], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const ac = new AbortController();
  // Start draining before anything is awaited: a hook that fills the 64 KB pipe buffer before
  // reading stdin would otherwise deadlock against our own stdin write.
  const stdoutPromise = drainTail(proc.stdout, STDOUT_TAIL_BYTES, ac.signal);
  const stderrPromise = drainTail(proc.stderr, STDERR_BUFFER_BYTES, ac.signal);

  // A hook that exits before reading stdin gives us EPIPE; that is its business, not a failure of
  // ours, and it must never reach the server as an unhandled rejection.
  void (async () => {
    try {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    } catch {
      // ignored on purpose
    }
  })();

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
  }, timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }

  // The hook is gone, but a grandchild it spawned can still hold the write end of these pipes open
  // (`nohup something &`), so EOF may never come. Give the real output a moment to arrive, then
  // stop reading rather than hanging the request forever.
  const readerTimer = setTimeout(() => ac.abort(), READER_GRACE_MS);
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } finally {
    clearTimeout(readerTimer);
  }

  const exitCode = timedOut ? null : proc.exitCode;
  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout,
    stderr: tailStderr(stderr),
    timedOut,
  };
}

/** Longest a hook may make each board field; past this the output is a bug, not a board. */
const MAX_OUTPUT_LENGTH: Record<"title" | "slug" | "body" | "project", number> = {
  title: 500,
  slug: 200,
  body: 100_000,
  project: 4096,
};

function requireSaneString(obj: Record<string, unknown>, key: "title" | "slug" | "body" | "project"): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HookError(`hook returned a "${key}" that is not a string: ${JSON.stringify(value)}`, "hook_output_invalid");
  }
  if (value.includes("\0")) {
    throw new HookError(`hook returned a "${key}" containing a NUL byte`, "hook_output_invalid");
  }
  if (value.length > MAX_OUTPUT_LENGTH[key]) {
    throw new HookError(`hook returned a "${key}" longer than ${MAX_OUTPUT_LENGTH[key]} characters`, "hook_output_invalid");
  }
  return value;
}

/**
 * Parse a hook's stdout: the last non-empty line, as JSON. No non-empty line at all means "no
 * output" — not an error — and returns `{}`, so a hook that never prints anything (or that just
 * echoes progress) still counts as a clean no-op. A non-empty last line that fails to parse, or
 * that parses to something other than a JSON object, is `HookError("hook_output_invalid")`.
 *
 * `title`, `slug` and `body`, when present, must be strings of sane length: a hook that returns a
 * number or a megabyte is a broken hook, and silently dropping the value would create a board that
 * does not match what the hook meant.
 *
 * `project`, when present, must be an absolute path to a directory that exists, and comes back
 * canonicalized — symlinks resolved, trailing slashes and `..` removed. Boards are keyed one per
 * project directory (ADR 0002) and the CLI keys off `process.cwd()`, which the kernel has already
 * resolved; without this a hook returning `/tmp/x` (a symlink to `/private/tmp/x` on macOS) would
 * create a board that `flock` run from inside that very directory could not find.
 */
export function parseHookOutput(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n");
  let lastNonEmpty: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) {
      lastNonEmpty = line;
      break;
    }
  }
  if (lastNonEmpty === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastNonEmpty);
  } catch {
    throw new HookError(`hook stdout's last line is not valid JSON: ${lastNonEmpty.slice(0, 200)}`, "hook_output_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HookError("hook stdout's last line must be a JSON object", "hook_output_invalid");
  }
  const obj = parsed as Record<string, unknown>;

  requireSaneString(obj, "title");
  requireSaneString(obj, "slug");
  requireSaneString(obj, "body");
  const project = requireSaneString(obj, "project");

  if (project !== undefined) {
    if (!isAbsolute(project)) {
      throw new HookError(`hook returned a "project" that is not an absolute path: ${JSON.stringify(project)}`, "hook_output_invalid");
    }
    let canonical: string;
    try {
      canonical = realpathSync(project);
      if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new HookError(`hook returned a "project" that is not an existing directory: ${project}`, "hook_output_invalid");
    }
    obj.project = canonical.length > 1 ? canonical.replace(/\/+$/, "") : canonical;
  }

  return obj;
}

export type HookFieldType = "text" | "textarea" | "select" | "checkbox";

export interface HookFieldOption {
  value: string;
  label: string;
}

export interface HookField {
  name: string;
  label: string;
  type: HookFieldType;
  required?: boolean;
  placeholder?: string;
  default?: string | boolean;
  options?: HookFieldOption[];
}

export interface HookDescribe {
  title?: string;
  submit?: string;
  fields: HookField[];
}

const FIELD_TYPES: HookFieldType[] = ["text", "textarea", "select", "checkbox"];
const MAX_FIELDS = 50;
const MAX_OPTIONS = 500;
const MAX_FIELD_NAME = 128;
const MAX_FIELD_TEXT = 500;

/**
 * Validate a `describe` response into the field schema. Anything malformed is dropped rather
 * than thrown: a field missing `name`/`label`/a recognized `type` is skipped, and non-object
 * input (or a failed describe upstream) normalizes to `{fields: []}` — the dialog falls back to
 * a plain title field, which is the whole point of a `describe` hook being optional.
 *
 * A name with no alphanumeric character is dropped too: it has no `FLOCK_INPUT_<KEY>` spelling, so
 * the `create` run could never see its value. Duplicate names keep the first declaration, and the
 * field, option and string counts are bounded so a runaway `describe` cannot render a dialog with a
 * million rows in it.
 */
export function normalizeFields(json: unknown): HookDescribe {
  const result: HookDescribe = { fields: [] };
  if (typeof json !== "object" || json === null || Array.isArray(json)) return result;
  const obj = json as Record<string, unknown>;

  if (typeof obj.title === "string") result.title = obj.title.slice(0, MAX_FIELD_TEXT);
  if (typeof obj.submit === "string") result.submit = obj.submit.slice(0, MAX_FIELD_TEXT);

  const rawFields = Array.isArray(obj.fields) ? obj.fields : [];
  const seen = new Set<string>();
  for (const raw of rawFields) {
    if (result.fields.length >= MAX_FIELDS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.name !== "string" || f.name.length === 0 || f.name.length > MAX_FIELD_NAME) continue;
    if (!/[a-zA-Z0-9]/.test(f.name)) continue;
    if (seen.has(f.name)) continue;
    if (typeof f.label !== "string" || f.label.length === 0) continue;
    if (typeof f.type !== "string" || !FIELD_TYPES.includes(f.type as HookFieldType)) continue;

    const field: HookField = { name: f.name, label: f.label.slice(0, MAX_FIELD_TEXT), type: f.type as HookFieldType };
    if (typeof f.required === "boolean") field.required = f.required;
    if (typeof f.placeholder === "string") field.placeholder = f.placeholder.slice(0, MAX_FIELD_TEXT);
    if (typeof f.default === "string") field.default = f.default.slice(0, MAX_FIELD_TEXT);
    else if (typeof f.default === "boolean") field.default = f.default;
    if (Array.isArray(f.options)) {
      const options: HookFieldOption[] = [];
      for (const opt of f.options) {
        if (options.length >= MAX_OPTIONS) break;
        if (typeof opt === "string") {
          options.push({ value: opt.slice(0, MAX_FIELD_TEXT), label: opt.slice(0, MAX_FIELD_TEXT) });
        } else if (typeof opt === "object" && opt !== null && typeof (opt as Record<string, unknown>).value === "string") {
          const o = opt as Record<string, unknown>;
          const value = (o.value as string).slice(0, MAX_FIELD_TEXT);
          options.push({ value, label: typeof o.label === "string" ? o.label.slice(0, MAX_FIELD_TEXT) : value });
        }
      }
      field.options = options;
    }
    seen.add(f.name);
    result.fields.push(field);
  }

  return result;
}

export interface BoardInput {
  title?: string;
  slug?: string;
  body?: string;
  project?: string;
}

/** Hook output wins over the submitted form; keys the hook did not return are left alone, and keys on the hook output that are not part of `BoardInput` are ignored. */
export function mergeBoardInput(form: BoardInput, hookOutput: Record<string, unknown>): BoardInput {
  const merged: BoardInput = { ...form };
  if (typeof hookOutput.title === "string") merged.title = hookOutput.title;
  if (typeof hookOutput.slug === "string") merged.slug = hookOutput.slug;
  if (typeof hookOutput.body === "string") merged.body = hookOutput.body;
  if (typeof hookOutput.project === "string") merged.project = hookOutput.project;
  return merged;
}
