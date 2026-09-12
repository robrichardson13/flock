export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Tiny argv parser: --k v, --k=v, --flag, -k v, repeated flags collect into arrays. */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const push = (k: string, v: string | boolean) => {
    const prev = flags[k];
    if (prev === undefined) flags[k] = v;
    else if (Array.isArray(prev)) prev.push(String(v));
    else flags[k] = [String(prev), String(v)];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        push(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-")) && !BOOLEAN_FLAGS.has(key)) {
        push(key, next);
        i++;
      } else push(key, true);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-")) && !BOOLEAN_FLAGS.has(key)) {
        push(key, next);
        i++;
      } else push(key, true);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

export const BOOLEAN_FLAGS = new Set([
  "json", "human", "agent", "force", "frontier", "open", "mine", "wait", "follow", "all", "help", "h", "archived", "no-open", "quiet", "q", "blocked", "here", "local", "none", "archive", "activate", "wontfix", "isolated", "dry-run", "yes", "foreground", "f", "version", "no-start", "skill-only", "if-newer", "tailscale", "no-tailscale", "global",
  "refresh",
]);

export function str(v: string | boolean | string[] | undefined): string | undefined {
  if (v === undefined || v === true || v === false) return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export function list(v: string | boolean | string[] | undefined): string[] {
  if (v === undefined || typeof v === "boolean") return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

export function bool(v: string | boolean | string[] | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return !["0", "false", "no"].includes(s.toLowerCase());
}
