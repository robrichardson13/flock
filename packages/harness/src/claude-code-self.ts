/**
 * Self-identification for a write happening *inside* a Claude Code subagent (ADR 0027).
 *
 * Claude Code gives a subagent no per-agent environment variable: `CLAUDE_CODE_SESSION_ID` is
 * the parent's, so every subagent write used to carry the conductor's run key and the Run block
 * rendered the conductor's transcript on every card.
 *
 * It does, however, write each subagent's own transcript to
 * `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, and it flushes the `tool_use` line
 * carrying a Bash command to that file *before* running the command. So a process that knows
 * its own argv can find the one subagent transcript whose tail contains that command, and that
 * file's name is its agent id.
 *
 * Best effort by construction: an unreadable directory, an ambiguous match or a harness that
 * changes its layout all return `undefined`, which is exactly the bare-key behaviour that
 * shipped before. Nothing here throws.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeHome, projectDir } from "./claude-code-paths.ts";

/** Subagent transcripts considered, newest first. A session with more live subagents than this
 * is already past the point where a tail scan is the right tool. */
export const DEFAULT_MAX_SUBAGENT_FILES = 16;

/** Bytes read from the tail of each candidate transcript. The `tool_use` we are looking for was
 * written moments ago, so it is always in the last few kilobytes. */
export const DEFAULT_SELF_TAIL_BYTES = 64 * 1024;

/** How stale a subagent transcript may be and still be considered ours. Our own `tool_use` line
 * was flushed within milliseconds; anything older belongs to a different agent. */
export const DEFAULT_SELF_FRESH_MS = 5 * 60 * 1000;

/** Command fragments searched for, and the length band a fragment must sit in to be useful. */
const MAX_FRAGMENTS = 8;
const MIN_FRAGMENT_LENGTH = 1;
const MAX_FRAGMENT_LENGTH = 64;

const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;

export interface SelfAgentOptions {
  cwd: string;
  sessionId: string;
  /** Distinctive fragments of this process's own command line; all must appear. */
  fragments: string[];
  /** `~/.claude` by default; overridable so tests never touch the real home directory. */
  home?: string;
  now?: () => number;
  maxFiles?: number;
  tailBytes?: number;
  freshMs?: number;
}

/**
 * The shell-quoting-proof needle set for an argv: every token that survives a shell round trip
 * unchanged, in argv order, capped. Tokens carrying whitespace, quotes or backslashes are
 * dropped because the transcript holds the command *as written*, complete with its quoting,
 * while argv holds it after the shell stripped that quoting away.
 */
export function commandFragments(argv: string[]): string[] {
  const out: string[] = [];
  for (const token of argv) {
    if (out.length >= MAX_FRAGMENTS) break;
    if (token.length < MIN_FRAGMENT_LENGTH || token.length > MAX_FRAGMENT_LENGTH) continue;
    if (/[\s"'\\`$]/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/** Candidate transcripts: `agent-<id>.jsonl` files touched recently, newest first, capped. */
function candidates(dir: string, now: number, freshMs: number, maxFiles: number): { agentId: string; path: string; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // No subagents directory: this write is not inside a subagent. Not an error.
  }
  const out: { agentId: string; path: string; mtimeMs: number }[] = [];
  for (const name of names.slice(0, DEFAULT_MAX_SUBAGENT_FILES * 4)) {
    const match = AGENT_FILE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > freshMs) continue;
      out.push({ agentId: match[1], path, mtimeMs: st.mtimeMs });
    } catch {
      // Vanished between readdir and stat, or unreadable: skip it, never throw.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

/** The last `bytes` of a file as UTF-8, or "" when it cannot be read. */
function tail(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    if (length === 0) return "";
    const buf = Buffer.allocUnsafe(length);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch {
    return ""; // Unreadable or truncated mid-read: no match, never an exception.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when every fragment appears in `text`, each in the JSON-escaped form a transcript
 * stores it in (a transcript line is JSON, so `"` and `\` inside the command are escaped). */
function containsAll(text: string, fragments: string[]): boolean {
  return fragments.every((f) => text.includes(JSON.stringify(f).slice(1, -1)));
}

/**
 * This process's own Claude Code subagent id, or `undefined` when it is not running inside one
 * (or cannot tell). Synchronous on purpose: `resolveActor` runs on every CLI write and is not
 * async, and the work is a bounded directory listing plus a few 64 KiB tail reads.
 */
export function resolveOwnAgentId(opts: SelfAgentOptions): string | undefined {
  if (opts.fragments.length === 0) return undefined;
  const home = claudeHome(opts.home);
  const dir = join(projectDir(home, opts.cwd), opts.sessionId, "subagents");
  const now = (opts.now ?? Date.now)();
  const files = candidates(dir, now, opts.freshMs ?? DEFAULT_SELF_FRESH_MS, opts.maxFiles ?? DEFAULT_MAX_SUBAGENT_FILES);
  if (files.length === 0) return undefined;
  const tailBytes = opts.tailBytes ?? DEFAULT_SELF_TAIL_BYTES;
  // Newest first, so the first hit is also the most recently written — the tie-break we want
  // if two concurrent subagents ever ran byte-identical commands.
  for (const file of files) {
    if (containsAll(tail(file.path, tailBytes), opts.fragments)) return file.agentId;
  }
  return undefined;
}

/** `claude-code:<sid>` refined to `claude-code:<sid>#<agentId>` when this process is a subagent.
 * A key that already names an agent, or one this reader does not own, is returned untouched. */
export function refineRunKey(key: string, cwd: string, argv: string[], opts: Partial<SelfAgentOptions> = {}): string {
  const colon = key.indexOf(":");
  if (colon === -1 || key.includes("#")) return key;
  const sessionId = key.slice(colon + 1);
  if (!sessionId) return key;
  const agentId = resolveOwnAgentId({ ...opts, cwd, sessionId, fragments: commandFragments(argv) });
  return agentId ? `${key}#${agentId}` : key;
}
