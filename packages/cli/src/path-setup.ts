/**
 * `flock setup`'s PATH repair. Ports `scripts/install.sh`'s shell detection (lines 169–202)
 * faithfully — including the macOS-login-bash subtlety (`.bash_profile`, never `.bashrc`) — and
 * adds the one thing that script deliberately leaves undone: actually appending the export line.
 *
 * Everything here takes its inputs as parameters rather than reading `process.env` or `HOME`
 * directly, so tests can point it at a scratch directory and a fabricated environment without
 * touching a real `~/.zshrc`. `setupCommand` in setup.ts is the only caller that reads the real
 * environment and passes it in.
 *
 * See docs/adr for the decision record; the reasoning (why auto-edit, why an env var and not a
 * flag, why this lives in `flock setup` rather than `install.sh`) is card 10/11 on the flock board.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The environment `ensurePathConfigured` needs, gathered explicitly rather than read ambiently. */
export interface PathSetupEnv {
  /** The user's home directory. Never falls back to `os.homedir()` here — the caller decides that. */
  home: string;
  /** `process.env.SHELL`, verbatim. Often unset in a container; that is a normal input, not an error. */
  shell: string | undefined;
  /** `process.env.PATH`, verbatim, used only to short-circuit when `installDir` is already on it. */
  path: string | undefined;
  /** `process.platform`. Only `"darwin"` changes behavior (bash resolves to `.bash_profile`). */
  platform: NodeJS.Platform;
  /** `process.env.FLOCK_NO_MODIFY_PATH === "1"` — the opt-out. An env var, not a flag: flags do not
   *  survive `curl | sh`, which is why uv deprecated its `--no-modify-path` flag for this exact env var. */
  noModifyPath: boolean;
}

/** The fixed marker `install.sh`'s comment already promised: identifies our line for hand removal
 *  and doubles as the `grep -F` guard against double-appending. Never change this string — it is
 *  read back from existing rc files to decide idempotency. */
export const PATH_MARKER = "# Added by flock (https://github.com/robrichardson13/flock) — safe to remove";

/**
 * Which rc file `install.sh` would point the user at, ported verbatim from lines 182–191 of
 * `scripts/install.sh`. Returns `undefined` when the shell can't be identified (`$SHELL` unset,
 * or a shell we don't special-case) — the container case that script's own comment anticipates.
 */
export function detectRc(env: Pick<PathSetupEnv, "home" | "shell" | "platform">): string | undefined {
  const shellName = (env.shell ?? "").split("/").pop() ?? "";
  switch (shellName) {
    case "zsh":
      return join(env.home, ".zshrc");
    case "bash":
      // macOS Terminal starts bash as a login shell, which reads .bash_profile and never .bashrc —
      // pointing a mac user at .bashrc is advice that silently does nothing.
      return env.platform === "darwin" ? join(env.home, ".bash_profile") : join(env.home, ".bashrc");
    case "fish":
      return join(env.home, ".config", "fish", "config.fish");
    default:
      return undefined;
  }
}

/** The line to append: `fish_add_path` for fish, a plain `export PATH=` for everything else — the
 *  same split `install.sh` already makes in its printed advice. */
function pathLine(installDir: string, rc: string): string {
  return rc.endsWith(join("fish", "config.fish")) ? `fish_add_path ${installDir}` : `export PATH="${installDir}:$PATH"`;
}

/** The printed fallback block, byte-for-byte what `install.sh` already prints today (lines
 *  193–202), used whenever we can't or shouldn't edit a file: no rc determined, or the opt-out. */
export function fallbackBlock(installDir: string, env: Pick<PathSetupEnv, "shell">, rc: string | undefined): string {
  const shellName = (env.shell ?? "").split("/").pop() ?? "";
  const lines = [`flock: ${installDir} is not on your PATH.`];
  if (shellName === "fish") lines.push(`  fish_add_path ${installDir}`);
  else lines.push(`  export PATH="${installDir}:$PATH"`);
  if (rc) lines.push(`  (add that to ${rc})`);
  lines.push(`  or run it directly: ${installDir}/flock`);
  return lines.join("\n");
}

export type EnsurePathResult =
  | { action: "on-path" }
  | { action: "already-present"; rc: string }
  | { action: "already-on-path-unmarked"; rc: string }
  | { action: "appended"; rc: string }
  | { action: "printed"; message: string };

/** Any non-empty value other than `0`/`false` (case-insensitive) opts out — an opt-out must fail
 *  closed, not open: the cost of honouring a value the user didn't mean is one un-set PATH, the
 *  cost of ignoring one they did mean is an unrequested edit to their shell startup. Only `1` is
 *  documented, but `true`/`yes`/anything else non-falsy is still honoured as an opt-out. */
export function isNoModifyPath(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

/** Every spelling of `installDir` under `home` that a human or `scripts/setup.sh --link` plausibly
 *  writes by hand: the expanded absolute path, and `$HOME/`, `${HOME}/`, `~/` variants. Matching
 *  only the absolute path misses the common case of a hand-written or `--link`-written line. */
function pathNeedles(installDir: string, home: string): string[] {
  const needles = [installDir];
  if (home && installDir.startsWith(`${home}/`)) {
    const rest = installDir.slice(home.length); // "/.flock/bin"
    needles.push(`$HOME${rest}`, `\${HOME}${rest}`, `~${rest}`);
  }
  return needles;
}

/**
 * Makes sure `installDir` ends up on the user's `PATH`, or explains how to do it by hand.
 *
 * Order of checks: already on `PATH` (nothing to do) → opt-out or no determinable rc (print the
 * fallback, touch nothing) → rc already carries our marker, or an unmarked line already puts the
 * dir on PATH (no-op, idempotent either way) → append. Append-only: this never rewrites, reorders,
 * or truncates an existing rc file.
 */
export function ensurePathConfigured(installDir: string, env: PathSetupEnv): EnsurePathResult {
  const onPath = (env.path ?? "").split(":").filter(Boolean).includes(installDir);
  if (onPath) return { action: "on-path" };

  const rc = detectRc(env);

  // A relative rc path (e.g. HOME="" makes join("", ".zshrc") === ".zshrc") must never be written
  // to — that would land a shell rc file in whatever directory happened to be the cwd. Treat it the
  // same as "no rc determinable": print the fallback, touch nothing.
  if (rc !== undefined && !isAbsolute(rc)) {
    return { action: "printed", message: fallbackBlock(installDir, env, undefined) };
  }

  if (env.noModifyPath || !rc) {
    return { action: "printed", message: fallbackBlock(installDir, env, rc) };
  }

  let existing = "";
  try {
    if (existsSync(rc)) existing = readFileSync(rc, "utf8");
    if (existing.includes(PATH_MARKER)) {
      return { action: "already-present", rc };
    }
    if (pathNeedles(installDir, env.home).some((needle) => existing.includes(needle))) {
      return { action: "already-on-path-unmarked", rc };
    }

    mkdirSync(dirname(rc), { recursive: true });
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    const block = `${needsLeadingNewline ? "\n" : ""}\n${PATH_MARKER}\n${pathLine(installDir, rc)}\n`;
    appendFileSync(rc, block);
    return { action: "appended", rc };
  } catch (err) {
    // An unwritable rc or a read-only $HOME must never fail the whole install — PATH advice is a
    // nicety, not a requirement. Degrade to the same fallback a container with no rc gets.
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : String(err);
    return { action: "printed", message: `${fallbackBlock(installDir, env, rc)}\n  (could not write to ${rc}: ${code})` };
  }
}
