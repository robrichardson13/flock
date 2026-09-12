import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end subprocess tests for ADR 0024's CLI surface: `--level` on say/comment, the needs-me
// refusal, and `flock notify settings`/`flock notify set`. Core's own precedence/inheritance
// tests (packages/core/test/notify.test.ts) cover the domain rule; this only checks the CLI is
// thin over it and that `notify`'s board/--global resolution and flag parsing behave.

const mainPath = join(import.meta.dir, "main.ts");
let dbPath: string;

function run(args: string[]) {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", "tester", "--json"], {
    env: { ...process.env },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function setup() {
  dbPath = join(mkdtempSync(join(tmpdir(), "flock-cli-test-")), "flock.db");
  const board = JSON.parse(run(["board", "new", "Notify test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
  return { board };
}

afterEach(() => {
  if (dbPath) rmSync(dbPath, { force: true });
});

describe("flock say/comment --level", () => {
  test("--level review/info is stored and round-trips through card/message JSON", () => {
    const { board } = setup();
    const msg = JSON.parse(run(["say", board.slug, "the PR is up", "--level", "review"]).stdout);
    expect(msg.body).toBe("the PR is up");
    const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
    const comment = JSON.parse(run(["comment", board.slug, String(card.num), "status update", "--level", "info"]).stdout);
    expect(comment.body).toBe("status update");
  });

  test("--level needs-me is refused on say, exit 1, pointing at flock ask", () => {
    const { board } = setup();
    const result = run(["say", board.slug, "help", "--level", "needs-me"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/flock ask/);
  });

  test("--level needs-me is refused on comment, exit 1, pointing at flock ask", () => {
    const { board } = setup();
    const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
    const result = run(["comment", board.slug, String(card.num), "help", "--level", "needs-me"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/flock ask/);
  });

  test("an unrecognised --level fails loudly rather than silently landing as info", () => {
    const { board } = setup();
    const result = run(["say", board.slug, "hi", "--level", "urgent"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/unknown notification level/);
  });
});

describe("flock notify settings / set", () => {
  test("settings with no rows written reads every field as default", () => {
    const { board } = setup();
    const settings = JSON.parse(run(["notify", "settings", board.slug]).stdout);
    expect(settings.resolved).toEqual({ needsMe: true, review: true, info: false, settled: false, settledAfterMs: 20 * 60_000 });
    expect(settings.raw).toBeNull();
  });

  test("set writes only the board row for the named board; other fields still inherit", () => {
    const { board } = setup();
    const written = JSON.parse(run(["notify", "set", board.slug, "--everything", "on", "--threshold", "45m"]).stdout);
    expect(written.raw).toEqual({ needsMe: null, review: null, info: true, settled: null, settledAfterMs: 45 * 60_000 });
    expect(written.resolved.info).toBe(true);
    expect(written.resolved.needsMe).toBe(true); // untouched, still the default

    const read = JSON.parse(run(["notify", "settings", board.slug]).stdout);
    expect(read.resolved).toEqual(written.resolved);
  });

  test("--global writes the actor's global row regardless of the board named or the cwd", () => {
    const { board } = setup();
    JSON.parse(run(["notify", "set", board.slug, "--global", "--needs-me", "off"]).stdout);
    const globalRead = JSON.parse(run(["notify", "settings", "--global"]).stdout);
    expect(globalRead.boardId).toBeNull();
    expect(globalRead.resolved.needsMe).toBe(false);

    // The board itself inherits the changed global value, having no override of its own.
    const boardRead = JSON.parse(run(["notify", "settings", board.slug]).stdout);
    expect(boardRead.resolved.needsMe).toBe(false);
  });

  test("a board override wins over a global value for the same field", () => {
    const { board } = setup();
    run(["notify", "set", "--global", "--review", "off"]);
    run(["notify", "set", board.slug, "--review", "on"]);
    const boardRead = JSON.parse(run(["notify", "settings", board.slug]).stdout);
    expect(boardRead.resolved.review).toBe(true);
    const globalRead = JSON.parse(run(["notify", "settings", "--global"]).stdout);
    expect(globalRead.resolved.review).toBe(false);
  });

  test("set with no toggles at all is a usage error", () => {
    const { board } = setup();
    const result = run(["notify", "set", board.slug]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/Nothing to set/);
  });

  test("an unknown notify subcommand is a usage error", () => {
    const { board } = setup();
    const result = run(["notify", "bogus", board.slug]);
    expect(result.code).toBe(1);
  });

  test("--threshold is clamped by core (below 5m floors at 5m)", () => {
    const { board } = setup();
    const written = JSON.parse(run(["notify", "set", board.slug, "--threshold", "1m"]).stdout);
    expect(written.raw.settledAfterMs).toBe(5 * 60_000);
  });
});
