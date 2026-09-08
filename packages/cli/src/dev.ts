import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DB_DIRNAME, DB_FILENAME, FlockError } from "@flock/core";

/** The checkout this CLI's source lives in: the fallback when cwd is not inside a flock checkout. */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** The ports the canonical checkout owns. A worktree never serves these. */
export const CANONICAL_API_PORT = 4747;
export const CANONICAL_WEB_PORT = 5173;

export interface Checkout {
  /** Directory holding packages/web (and, historically, ecosystem.config.cjs). */
  root: string;
  /** True for the main checkout; false for a `git worktree` linked to it. */
  canonical: boolean;
  /** "" for the canonical checkout, else the worktree's directory name. Suffixes runfile/log names. */
  name: string;
  apiPort: number;
  webPort: number;
  /** Database the API opens. Undefined means the CLI default (~/.flock/flock.db). */
  db?: string;
}

export interface DevOptions {
  json: boolean;
  port?: number;
  webPort?: number;
  db?: string;
  /** Use an isolated .flock/flock.db inside this checkout instead of the shared global database. */
  isolated?: boolean;
}

/** Walk up from cwd to the nearest flock checkout, so `flock up` in a worktree drives that worktree. */
function findRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "packages", "web", "package.json")) && existsSync(join(dir, "packages", "cli", "src", "main.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) return REPO_ROOT;
    dir = up;
  }
}

function isLinkedWorktree(root: string): boolean {
  let r: { exitCode: number; stdout: Buffer };
  try {
    r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
  } catch {
    // No git binary on PATH: fall back to the same heuristic used when the probe just fails.
    return root !== REPO_ROOT;
  }
  if (r.exitCode !== 0) return root !== REPO_ROOT;
  const [gitDir, commonDir] = r.stdout.toString().trim().split("\n").map((p) => resolve(root, p));
  return gitDir !== commonDir;
}

/** Stable per-path offset so a worktree gets the same ports every time without a registry. */
export function portOffset(path: string): number {
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100;
}

/**
 * Pure checkout-resolution logic, with `root`/`canonical` (from git) and `env` injected so it's
 * testable without a real git repo or process.env. `resolveCheckout` is the real entry point.
 */
export function planCheckout(args: { root: string; canonical: boolean; env: Record<string, string | undefined>; opts: Partial<DevOptions> }): Checkout {
  const { root, canonical, env, opts } = args;
  const name = canonical ? "" : basename(root);
  const offset = portOffset(root);
  const apiPort = opts.port ?? (env.FLOCK_PORT ? Number(env.FLOCK_PORT) : canonical ? CANONICAL_API_PORT : 4800 + offset);
  const webPort = opts.webPort ?? (env.FLOCK_WEB_PORT ? Number(env.FLOCK_WEB_PORT) : canonical ? CANONICAL_WEB_PORT : 5200 + offset);
  if (!canonical && (apiPort === CANONICAL_API_PORT || webPort === CANONICAL_WEB_PORT)) {
    throw new FlockError(
      `Refusing to serve the canonical ports (:${CANONICAL_API_PORT} / :${CANONICAL_WEB_PORT}) from the worktree ${root}.\n` +
        `Those belong to the main checkout. Drop --port/--web-port (or FLOCK_PORT/FLOCK_WEB_PORT) to use this worktree's own ports.`,
      "invalid",
    );
  }
  let db = opts.db ? resolve(opts.db) : env.FLOCK_DB ? resolve(env.FLOCK_DB) : undefined;
  if (opts.isolated) db = join(root, DB_DIRNAME, DB_FILENAME);
  return { root, canonical, name, apiPort, webPort, db };
}

export function resolveCheckout(opts: Partial<DevOptions> = {}): Checkout {
  const root = findRoot();
  const canonical = !isLinkedWorktree(root);
  return planCheckout({ root, canonical, env: process.env, opts });
}

export const devUrl = (c: Checkout) => `http://localhost:${c.webPort}`;

/** Addresses another device can reach this machine on: LAN IPv4s and, when present, Tailscale. */
export function networkHosts(): string[] {
  const hosts: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) if (i.family === "IPv4" && !i.internal && !hosts.includes(i.address)) hosts.push(i.address);
  }
  let ts: { exitCode: number; stdout: Buffer } | undefined;
  try {
    ts = Bun.spawnSync(["tailscale", "status", "--self", "--json"], { stdout: "pipe", stderr: "pipe" });
  } catch {
    // No tailscale binary on PATH: just report no Tailscale host.
  }
  if (ts && ts.exitCode === 0) {
    try {
      const dns = (JSON.parse(ts.stdout.toString()) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
      if (dns) hosts.push(dns);
    } catch {}
  }
  return hosts;
}
