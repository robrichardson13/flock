import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./main.ts", import.meta.url).pathname;

/** A fresh hooks dir for one test, with a fixture script written and made executable. */
function hooksFixture(script: string, mode = 0o700): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "flock-cli-hooks-"));
  const path = join(dir, "board-create");
  writeFileSync(path, script);
  chmodSync(path, mode);
  return { dir, path };
}

function run(args: string[], env: Record<string, string>) {
  return Bun.spawnSync(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
}

describe("flock hook describe", () => {
  test("--json reports missing when no hook is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-cli-hooks-"));
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "describe", "--json"], env);
      expect(result.exitCode).toBe(2);
      const data = JSON.parse(result.stdout.toString());
      expect(data.installed).toBe(false);
      expect(data.unsafe).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("--json reports the normalized fields of an installed hook", () => {
    const { dir } = hooksFixture(
      `#!/usr/bin/env bash
set -euo pipefail
echo '{"title":"New workspace","submit":"Create","fields":[{"name":"repo","label":"Repository","type":"select","options":["flock","other"],"required":true}]}'
`,
    );
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "describe", "--json"], env);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout.toString());
      expect(data.installed).toBe(true);
      expect(data.unsafe).toBe(false);
      expect(data.title).toBe("New workspace");
      expect(data.submit).toBe("Create");
      expect(data.fields).toEqual([
        { name: "repo", label: "Repository", type: "select", required: true, options: [{ value: "flock", label: "flock" }, { value: "other", label: "other" }] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("a describe printing non-JSON degrades to no fields with a warning, not a stack trace", () => {
    const { dir } = hooksFixture(`#!/usr/bin/env bash\necho "hello, not json"\n`);
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "describe", "--json"], env);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout.toString());
      expect(data.installed).toBe(true);
      expect(data.ok).toBe(false);
      expect(data.fields).toEqual([]);
      expect(data.warning).toContain("not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("reports unsafe for a world-writable hook and exits 1", () => {
    const { dir } = hooksFixture("#!/usr/bin/env bash\nexit 0\n", 0o707);
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "describe", "--json"], env);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout.toString());
      expect(data.installed).toBe(true);
      expect(data.unsafe).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe("flock hook run --dry-run", () => {
  test("--json runs the hook and reports the merged output without creating a board", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-cli-project-"));
    const { dir } = hooksFixture(
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"project":"%s","title":"from-hook"}\\n' "${projectDir}"
`,
    );
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const dbPath = join(dbDir, "flock.db");
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: dbPath };
      const result = run(["hook", "run", "--title", "Fix the login flow", "--input", "repo=flock", "--dry-run", "--json"], env);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout.toString());
      expect(data.dryRun).toBe(true);
      expect(data.ok).toBe(true);
      expect(data.merged.title).toBe("from-hook");
      expect(data.merged.project).toBe(realpathSync(projectDir));
      expect(data.board).toBeUndefined();

      // No board should have been created.
      const boards = run(["boards", "--json"], env);
      expect(JSON.parse(boards.stdout.toString())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("without --dry-run, creates the board through core and exits 0", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-cli-project-"));
    const { dir } = hooksFixture(
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"project":"%s","title":"from-hook"}\\n' "${projectDir}"
`,
    );
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const dbPath = join(dbDir, "flock.db");
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: dbPath };
      const result = run(["hook", "run", "--title", "Fix the login flow", "--json"], env);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout.toString());
      expect(data.dryRun).toBe(false);
      expect(data.board.title).toBe("from-hook");
      expect(data.board.project).toBe(realpathSync(projectDir));

      const boards = run(["boards", "--json"], env);
      const list = JSON.parse(boards.stdout.toString());
      expect(list.length).toBe(1);
      expect(list[0].title).toBe("from-hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("a failing hook exits 1 and creates no board", () => {
    const { dir } = hooksFixture("#!/usr/bin/env bash\necho 'boom' >&2\nexit 1\n");
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "run", "--title", "x", "--json"], env);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout.toString());
      expect(data.ok).toBe(false);
      expect(data.stderr).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("no hook installed exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-cli-hooks-"));
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const result = run(["hook", "run", "--title", "x", "--json"], env);
      expect(result.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("a board conflict from the resolved project exits 3", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-cli-project-"));
    const { dir } = hooksFixture(
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"project":"%s","title":"dup"}\\n' "${projectDir}"
`,
    );
    const dbDir = mkdtempSync(join(tmpdir(), "flock-cli-db-"));
    try {
      const env = { ...process.env, FLOCK_HOOKS_DIR: dir, FLOCK_DB: join(dbDir, "flock.db") };
      const first = run(["hook", "run", "--title", "first"], env);
      expect(first.exitCode).toBe(0);
      const second = run(["hook", "run", "--title", "second", "--json"], env);
      expect(second.exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
