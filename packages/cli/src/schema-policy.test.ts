import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Flock, SCHEMA_VERSION, schemaStamp } from "@flock/core";
import { FALLBACK_MARKER, fallbackDbPath, needsFallback, openForCli, rejoinHint, schemaPolicy, seedFallback, type SchemaSite } from "./schema-policy.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "flock-schema-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const binary: SchemaSite = { standalone: true, worktree: false, root: "/x" };
const canonical: SchemaSite = { standalone: false, worktree: false, root: "/repo" };
const worktree: SchemaSite = { standalone: false, worktree: true, root: "/repo-wt" };
const shared = "/home/me/.flock/flock.db";

describe("schemaPolicy (ADR 0021)", () => {
  test("an installed binary keeps the ADR 0012 guard: migrate, refuse newer", () => {
    expect(schemaPolicy(binary, shared, shared)).toEqual({});
  });
  test("the canonical checkout migrates and tolerates a newer stamp", () => {
    expect(schemaPolicy(canonical, shared, shared)).toEqual({ allowNewer: true });
  });
  test("a worktree never migrates the shared file", () => {
    expect(schemaPolicy(worktree, shared, shared)).toEqual({ migrate: false, allowNewer: true });
  });
  test("a worktree pointed at any other file (--db, FLOCK_DB, its own copy) migrates it", () => {
    expect(schemaPolicy(worktree, "/tmp/scratch.db", shared)).toEqual({ allowNewer: true });
    expect(schemaPolicy(worktree, fallbackDbPath(worktree.root), shared)).toEqual({ allowNewer: true });
  });
});

describe("needsFallback", () => {
  test("only a worktree, on the shared file, whose build is ahead of the stamp", () => {
    expect(needsFallback({ site: worktree, db: shared, shared, stamp: 5, version: 6 })).toBe(true);
    expect(needsFallback({ site: worktree, db: shared, shared, stamp: 6, version: 6 })).toBe(false);
    expect(needsFallback({ site: worktree, db: shared, shared, stamp: 7, version: 6 })).toBe(false);
    expect(needsFallback({ site: worktree, db: "/tmp/other.db", shared, stamp: 5, version: 6 })).toBe(false);
    expect(needsFallback({ site: canonical, db: shared, shared, stamp: 5, version: 6 })).toBe(false);
    expect(needsFallback({ site: binary, db: shared, shared, stamp: 5, version: 6 })).toBe(false);
  });
});

describe("rejoinHint", () => {
  const db = "/repo-wt/.flock/flock.db";
  test("nothing for a deliberate --isolated copy (no marker)", () => {
    expect(rejoinHint({ db, marker: false, sharedStamp: 6, copyStamp: 6 })).toBeUndefined();
  });
  test("nothing while the shared file is still behind", () => {
    expect(rejoinHint({ db, marker: true, sharedStamp: 5, copyStamp: 6 })).toBeUndefined();
  });
  test("names the directory to remove once the shared file has caught up", () => {
    expect(rejoinHint({ db, marker: true, sharedStamp: 6, copyStamp: 6 })).toContain("/repo-wt/.flock");
  });
});

describe("openForCli", () => {
  function sharedAt(stamp: number): string {
    const path = join(scratch(), "flock.db");
    const f = new Flock(path);
    f.createBoard({ name: "t", kind: "human" }, { title: "Shared", project: "/p" });
    f.close();
    const db = new Database(path);
    db.exec(`PRAGMA user_version = ${stamp}`);
    db.close();
    return path;
  }

  test("a worktree ahead of the shared stamp seeds a copy and opens that instead", () => {
    const shared = sharedAt(SCHEMA_VERSION - 1);
    const root = scratch();
    const site: SchemaSite = { standalone: false, worktree: true, root };
    const r = openForCli(shared, site, shared);
    expect(r.dbPath).toBe(fallbackDbPath(root));
    expect(r.note).toContain("Copied it to");
    expect(r.flock.listBoards().map((b) => b.title)).toEqual(["Shared"]);
    expect(schemaStamp(r.dbPath)).toBe(SCHEMA_VERSION);
    expect(existsSync(join(root, ".flock", FALLBACK_MARKER))).toBe(true);
    expect(readFileSync(join(root, ".flock", ".gitignore"), "utf8")).toContain(FALLBACK_MARKER);
    r.flock.close();
    // The shared file was not touched.
    expect(schemaStamp(shared)).toBe(SCHEMA_VERSION - 1);
  });

  test("a worktree behind the shared stamp opens it with the skew recorded, not an error", () => {
    const shared = sharedAt(SCHEMA_VERSION + 1);
    const site: SchemaSite = { standalone: false, worktree: true, root: scratch() };
    const r = openForCli(shared, site, shared);
    expect(r.dbPath).toBe(shared);
    expect(r.flock.schemaSkew?.dbVersion).toBe(SCHEMA_VERSION + 1);
    r.flock.close();
  });

  test("an installed binary behind the shared stamp still refuses", () => {
    const shared = sharedAt(SCHEMA_VERSION + 1);
    expect(() => openForCli(shared, binary, shared)).toThrow(/Upgrade flock/);
  });

  test("seedFallback is idempotent", () => {
    const shared = sharedAt(SCHEMA_VERSION);
    const dest = fallbackDbPath(scratch());
    seedFallback(shared, dest);
    seedFallback(shared, dest);
    expect(schemaStamp(dest)).toBe(SCHEMA_VERSION);
  });
});
