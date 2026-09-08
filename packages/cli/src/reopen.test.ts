import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises `flock move` end to end as a subprocess, since main() isn't exported for
// direct calls. The domain rule itself (require a reason to reopen) is covered in depth
// by packages/core/test/flock.test.ts; this just checks the CLI is thin over it.

const mainPath = join(import.meta.dir, "main.ts");
let dbPath: string;

function run(args: string[]) {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", "tester", "--json"], {
    env: { ...process.env },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

afterEach(() => {
  if (dbPath) rmSync(dbPath, { force: true });
});

describe("flock move --reason", () => {
  test("reopening a done card without --reason exits 1 with a clear message", () => {
    dbPath = join(mkdtempSync(join(tmpdir(), "flock-cli-test-")), "flock.db");
    const board = JSON.parse(run(["board", "new", "Reopen test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
    const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
    run(["done", board.slug, String(card.num), "--resolution", "shipped"]);

    const result = run(["move", board.slug, String(card.num), "todo"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toMatch(/reason/i);

    const shown = JSON.parse(run(["card", "show", board.slug, String(card.num)]).stdout);
    expect(shown.card.status).toBe("done");
  });

  test("reopening with --reason succeeds and posts the reason as a comment", () => {
    dbPath = join(mkdtempSync(join(tmpdir(), "flock-cli-test-")), "flock.db");
    const board = JSON.parse(run(["board", "new", "Reopen test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
    const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
    run(["done", board.slug, String(card.num), "--resolution", "shipped"]);

    const result = run(["move", board.slug, String(card.num), "todo", "--reason", "the fix regressed"]);
    expect(result.code).toBe(0);
    const moved = JSON.parse(result.stdout);
    expect(moved.status).toBe("todo");

    const shown = JSON.parse(run(["card", "show", board.slug, String(card.num)]).stdout);
    expect(shown.comments.some((c: any) => c.body === "the fix regressed")).toBe(true);
  });
});
