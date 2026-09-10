import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises `flock hold`/`flock unhold` end to end as a subprocess, since main() isn't exported
// for direct calls. The domain rule (claim guard, --force never overrides, events) is covered in
// depth by packages/core/test/hold.test.ts; this just checks the CLI is thin over it.

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
  const board = JSON.parse(run(["board", "new", "Hold test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
  const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
  return { board, card };
}

afterEach(() => {
  if (dbPath) rmSync(dbPath, { force: true });
});

describe("flock hold / unhold", () => {
  test("hold sets held state and reason, exposed in card show --json", () => {
    const { board, card } = setup();
    const result = run(["hold", board.slug, String(card.num), "--reason", "waiting on design"]);
    expect(result.code).toBe(0);
    const held = JSON.parse(result.stdout);
    expect(held.held).toBe(true);
    expect(held.heldBy).toBe("tester");
    expect(held.holdReason).toBe("waiting on design");
    expect(held.heldAt).toBeTruthy();

    const shown = JSON.parse(run(["card", "show", board.slug, String(card.num)]).stdout);
    expect(shown.card.held).toBe(true);
    expect(shown.card.holdReason).toBe("waiting on design");
  });

  test("hold with no reason stores null", () => {
    const { board, card } = setup();
    const held = JSON.parse(run(["hold", board.slug, String(card.num)]).stdout);
    expect(held.held).toBe(true);
    expect(held.holdReason).toBeNull();
  });

  test("human output: Held / Unheld / not on hold lines", () => {
    const { board, card } = setup();
    const held = Bun.spawnSync(["bun", mainPath, "hold", board.slug, String(card.num), "--reason", "later", "--db", dbPath, "--as", "tester"]);
    expect(held.stdout.toString()).toContain("Held");
    expect(held.stdout.toString()).toContain("(on hold: later)");

    const unheld = Bun.spawnSync(["bun", mainPath, "unhold", board.slug, String(card.num), "--db", dbPath, "--as", "tester"]);
    expect(unheld.stdout.toString()).toContain("Unheld");

    const again = Bun.spawnSync(["bun", mainPath, "unhold", board.slug, String(card.num), "--db", dbPath, "--as", "tester"]);
    expect(again.stdout.toString()).toContain("was not on hold");
  });

  test("claim on a held card exits 3 with core's holdConflictMessage; --force does not override", () => {
    const { board, card } = setup();
    run(["hold", board.slug, String(card.num), "--reason", "not yet"]);

    const claim = run(["claim", board.slug, String(card.num)]);
    expect(claim.code).toBe(3);
    const err = JSON.parse(claim.stdout);
    expect(err.error).toContain("is on hold");
    expect(err.error).toContain("not yet");
    expect(err.error).toContain("flock unhold");

    const forced = run(["claim", board.slug, String(card.num), "--force"]);
    expect(forced.code).toBe(3);

    run(["unhold", board.slug, String(card.num)]);
    const claimed = run(["claim", board.slug, String(card.num)]);
    expect(claimed.code).toBe(0);
  });

  test("cards --held lists only held cards", () => {
    const { board, card } = setup();
    const other = JSON.parse(run(["card", "new", board.slug, "Other"]).stdout);
    run(["hold", board.slug, String(card.num)]);

    const held = JSON.parse(run(["cards", board.slug, "--held"]).stdout);
    expect(held.map((c: any) => c.num)).toEqual([card.num]);
    expect(held.every((c: any) => c.num !== other.num)).toBe(true);
  });

  test("cards --frontier excludes held cards; board show reports on-hold count", () => {
    const { board, card } = setup();
    run(["hold", board.slug, String(card.num)]);
    const frontier = JSON.parse(run(["cards", board.slug, "--frontier"]).stdout);
    expect(frontier.find((c: any) => c.num === card.num)).toBeUndefined();

    const shown = Bun.spawnSync(["bun", mainPath, "board", "show", board.slug, "--db", dbPath, "--as", "tester"]);
    expect(shown.stdout.toString()).toContain("on hold: #" + card.num);
  });

  test("hold and unhold appear in help", () => {
    const help = Bun.spawnSync(["bun", mainPath, "help"]).stdout.toString();
    expect(help).toContain("hold [BOARD] N");
    expect(help).toContain("unhold [BOARD] N");
    expect(help).toContain("--held");
  });
});
