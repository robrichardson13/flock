import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_DIRNAME, DB_FILENAME, Flock, SCHEMA_VERSION, SchemaBehindError, copyDatabase, globalDbPath, schemaStamp, type OpenOptions } from "@flock/core";
import { REPO_ROOT, isLinkedWorktree } from "./dev.ts";
import { isStandalone } from "./runtime.ts";

/**
 * ADR 0021: a worktree never stamps the shared database. Who is opening it decides the policy:
 *
 * - an installed binary migrates and refuses a newer stamp (the ADR 0012 guard, unchanged);
 * - the canonical checkout migrates too, and tolerates a newer stamp (a worktree's `--db` file,
 *   say) because within one repo's history migrations are additive by contract;
 * - a linked worktree tolerates a newer stamp the same way, and *declines* to migrate the shared
 *   `~/.flock/flock.db`. When it would have to, the CLI seeds a private `.flock/flock.db` copy at
 *   the worktree root instead, which `resolveDbPath`'s walk-up then finds on every later run.
 *
 * "Worktree" is a property of the code being run (this CLI's own source tree), not of the cwd:
 * the schema version that would do the stamping is the one compiled into this process.
 */
export interface SchemaSite {
  standalone: boolean;
  worktree: boolean;
  /** The checkout root a fallback copy goes under. Unused for an installed binary. */
  root: string;
}

/** Marker beside a seeded copy, so `status` can tell it from a deliberate `--isolated`. */
export const FALLBACK_MARKER = "seeded-from-shared";

export function currentSite(): SchemaSite {
  if (isStandalone()) return { standalone: true, worktree: false, root: process.cwd() };
  return { standalone: false, worktree: isLinkedWorktree(REPO_ROOT), root: REPO_ROOT };
}

/** Pure: how `openDatabase` should treat `db`'s stamp for this site. */
export function schemaPolicy(site: SchemaSite, db: string, shared: string = globalDbPath()): OpenOptions {
  if (site.standalone) return {};
  if (site.worktree && db === shared) return { migrate: false, allowNewer: true };
  return { allowNewer: true };
}

export function fallbackDbPath(root: string): string {
  return join(root, DB_DIRNAME, DB_FILENAME);
}

/** Pure: would a worktree at `version` have to migrate the shared file stamped `stamp`? */
export function needsFallback(args: { site: SchemaSite; db: string; shared: string; stamp: number; version?: number }): boolean {
  const { site, db, shared, stamp, version = SCHEMA_VERSION } = args;
  return !site.standalone && site.worktree && db === shared && stamp < version;
}

export function fallbackNote(args: { stamp: number; version?: number; dest: string }): string {
  const { stamp, version = SCHEMA_VERSION, dest } = args;
  return `Shared database is at schema v${stamp} and this worktree is at v${version}.\nCopied it to ${dest} so other checkouts keep working; writes here stay in this worktree.`;
}

/** Seed the private copy once: the database, the marker, and a .gitignore. Idempotent. */
export function seedFallback(shared: string, dest: string): void {
  const dir = dirname(dest);
  if (!existsSync(dest)) copyDatabase(shared, dest);
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*.db\n*.db-wal\n*.db-shm\nseeded-from-shared\n");
  const marker = join(dir, FALLBACK_MARKER);
  if (!existsSync(marker)) writeFileSync(marker, `${shared}\n`);
}

/**
 * Pure: once the shared file has caught up with a seeded copy, say how to rejoin it. `undefined`
 * for a deliberate `--isolated` database (no marker) or while the shared file is still behind.
 */
export function rejoinHint(args: { db: string; marker: boolean; sharedStamp: number; copyStamp: number }): string | undefined {
  const { db, marker, sharedStamp, copyStamp } = args;
  if (!marker || sharedStamp < copyStamp) return undefined;
  return `The shared database has caught up (v${sharedStamp}); this worktree is still on its own copy. Remove ${dirname(db)} and run \`flock up\` to rejoin.`;
}

let warned = false;
/** One stderr line per process when an older build opens a newer database; never on --json stdout. */
export function warnSkew(flock: Flock): void {
  if (!flock.schemaSkew || warned) return;
  warned = true;
  const { dbVersion, binaryVersion } = flock.schemaSkew;
  console.error(`warning: database is schema v${dbVersion}, this checkout is v${binaryVersion}; migrations are additive, so proceeding.`);
}

/**
 * Open the CLI's database under the site's policy, seeding a worktree copy when the shared file
 * would otherwise be stamped. Returns the path actually opened so `ctx.dbPath` stays truthful.
 */
export function openForCli(dbPath: string, site: SchemaSite = currentSite(), shared: string = globalDbPath()): { flock: Flock; dbPath: string; note?: string } {
  try {
    const flock = new Flock(dbPath, schemaPolicy(site, dbPath, shared));
    warnSkew(flock);
    return { flock, dbPath };
  } catch (e) {
    if (!(e instanceof SchemaBehindError) || !needsFallback({ site, db: dbPath, shared, stamp: e.dbVersion })) throw e;
    const dest = fallbackDbPath(site.root);
    seedFallback(shared, dest);
    const note = fallbackNote({ stamp: e.dbVersion, dest });
    console.error(note);
    return { flock: new Flock(dest), dbPath: dest, note };
  }
}

/** Stamp of the file a seeded copy came from, for `status`'s rejoin hint. */
export function fallbackMarkerExists(db: string): boolean {
  return existsSync(join(dirname(db), FALLBACK_MARKER));
}

export { schemaStamp };
