import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises `flock decide`/`decisions`/`decision archive|restore` end to end as a subprocess,
// since main() isn't exported for direct calls. The domain rule lives in
// packages/core/test/decisions.test.ts; this checks the CLI is thin over it: arg parsing,
// human/--json output, and exit codes.

const mainPath = join(import.meta.dir, "main.ts");
let dbPath: string;

function run(args: string[]) {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", "tester", "--json"], {
    env: { ...process.env },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function runHuman(args: string[]) {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", "tester"], { env: { ...process.env } });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function setup() {
  dbPath = join(mkdtempSync(join(tmpdir(), "flock-cli-test-")), "flock.db");
  const board = JSON.parse(run(["board", "new", "Decisions test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
  return { board };
}

afterEach(() => {
  if (dbPath) rmSync(dbPath, { force: true });
});

describe("flock decide / decisions", () => {
  test("decide records a decision; human output names its d-number", () => {
    const { board } = setup();
    const human = runHuman(["decide", board.slug, "Use SQLite"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Recorded d1: Use SQLite");

    const d = JSON.parse(run(["decide", board.slug, "Use bun:sqlite"]).stdout);
    expect(d.num).toBe(2);
  });

  test("decide --supersedes archives the prior decision and says so", () => {
    const { board } = setup();
    const first = JSON.parse(run(["decide", board.slug, "v1"]).stdout);
    const human = runHuman(["decide", board.slug, "v2", "--supersedes", `d${first.num}`]);
    expect(human.stdout).toContain(`Recorded d2 (supersedes d${first.num}): v2`);

    const list = JSON.parse(run(["decisions", board.slug]).stdout);
    expect(list.map((d: any) => d.num)).toEqual([2]);
  });

  test("decide --supersedes on an already-archived decision exits 3", () => {
    const { board } = setup();
    const first = JSON.parse(run(["decide", board.slug, "v1"]).stdout);
    run(["decide", board.slug, "v2", "--supersedes", String(first.num)]);
    const again = run(["decide", board.slug, "v3", "--supersedes", String(first.num)]);
    expect(again.code).toBe(3);
  });

  test("decide --supersedes on an unknown decision exits 2", () => {
    const { board } = setup();
    const res = run(["decide", board.slug, "v1", "--supersedes", "99"]);
    expect(res.code).toBe(2);
  });

  test("decisions with no decisions prints 'No decisions yet.'", () => {
    const { board } = setup();
    const human = runHuman(["decisions", board.slug]);
    expect(human.stdout).toContain("No decisions yet.");
  });

  test("decisions default listing hides archived and notes the count", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "gone soon"]).stdout);
    run(["decision", "archive", board.slug, String(d.num), "--yes"]);
    JSON.parse(run(["decide", board.slug, "standing"]).stdout);

    const human = runHuman(["decisions", board.slug]);
    expect(human.stdout).toContain("standing");
    expect(human.stdout).not.toContain("gone soon");
    expect(human.stdout).toContain("(1 archived — flock decisions --archived)");
  });

  test("decisions --archived shows only archived rows, marked [archived]", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "gone soon"]).stdout);
    run(["decision", "archive", board.slug, String(d.num), "--yes"]);

    const human = runHuman(["decisions", board.slug, "--archived"]);
    expect(human.stdout).toContain("gone soon");
    expect(human.stdout).toContain("[archived]");

    const empty = runHuman(["decisions", board.slug, "--card", "999", "--archived"]);
    expect(empty.stdout).toContain("No archived decisions.");
  });

  test("decisions --all shows superseded rows with a pointer to the successor", () => {
    const { board } = setup();
    const first = JSON.parse(run(["decide", board.slug, "v1"]).stdout);
    const second = JSON.parse(run(["decide", board.slug, "v2", "--supersedes", String(first.num)]).stdout);

    const human = runHuman(["decisions", board.slug, "--all"]);
    expect(human.stdout).toContain(`[superseded by d${second.num}]`);
  });

  test("decisions --card and --by filter", () => {
    const { board } = setup();
    const card = JSON.parse(run(["card", "new", board.slug, "Some card"]).stdout);
    run(["decide", board.slug, "on the card", "--card", String(card.num)]);
    run(["decide", board.slug, "not on a card"]);

    const byCard = JSON.parse(run(["decisions", board.slug, "--card", String(card.num)]).stdout);
    expect(byCard).toHaveLength(1);
    expect(byCard[0].gist).toBe("on the card");

    const byAuthor = JSON.parse(run(["decisions", board.slug, "--by", "tester"]).stdout);
    expect(byAuthor).toHaveLength(2);

    const byOther = JSON.parse(run(["decisions", board.slug, "--by", "nobody"]).stdout);
    expect(byOther).toHaveLength(0);
  });
});

describe("flock decision archive / restore", () => {
  test("archive by explicit num, human output and --json shape", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "temp"]).stdout);
    const human = runHuman(["decision", "archive", board.slug, `d${d.num}`]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`Archived 1 decision: d${d.num}`);

    const d2 = JSON.parse(run(["decide", board.slug, "temp2"]).stdout);
    const jsonRes = JSON.parse(run(["decision", "archive", board.slug, String(d2.num)]).stdout);
    expect(jsonRes.archived).toHaveLength(1);
    expect(jsonRes.archived[0].num).toBe(d2.num);
  });

  test("archiving an unknown explicit num exits 2", () => {
    const { board } = setup();
    const res = run(["decision", "archive", board.slug, "999"]);
    expect(res.code).toBe(2);
  });

  test("re-archiving an already-archived decision is a silent no-op: 'Nothing to archive.'", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "temp"]).stdout);
    run(["decision", "archive", board.slug, String(d.num)]);
    const again = runHuman(["decision", "archive", board.slug, String(d.num)]);
    expect(again.stdout).toContain("Nothing to archive.");
  });

  test("restore round-trips a decision back to standing", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "temp"]).stdout);
    run(["decision", "archive", board.slug, String(d.num)]);
    const human = runHuman(["decision", "restore", board.slug, String(d.num)]);
    expect(human.stdout).toContain(`Restored 1 decision: d${d.num}`);

    const standing = JSON.parse(run(["decisions", board.slug]).stdout);
    expect(standing.map((x: any) => x.num)).toEqual([d.num]);
  });

  test("a selector matching more than ten needs --yes; --dry-run lists without writing", () => {
    const { board } = setup();
    for (let i = 0; i < 11; i++) run(["decide", board.slug, `decision ${i}`]);

    const gated = run(["decision", "archive", board.slug, "--by", "tester"]);
    expect(gated.code).toBe(1);
    expect(gated.stdout).toContain("Re-run with --yes");

    const dryRun = JSON.parse(run(["decision", "archive", board.slug, "--by", "tester", "--dry-run"]).stdout);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.matched).toHaveLength(11);

    const stillStanding = JSON.parse(run(["decisions", board.slug]).stdout);
    expect(stillStanding).toHaveLength(11);

    const forced = JSON.parse(run(["decision", "archive", board.slug, "--by", "tester", "--yes"]).stdout);
    expect(forced.archived).toHaveLength(11);
  });

  test("a board whose decisions are all archived still says how many are hidden", () => {
    const { board } = setup();
    for (const g of ["one", "two"]) run(["decide", board.slug, g]);
    run(["decision", "archive", board.slug, "1", "2"]);

    const human = runHuman(["decisions", board.slug]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("No decisions yet.");
    expect(human.stdout).toContain("(2 archived — flock decisions --archived)");
  });

  test("--dry-run previews only the rows the write would change", () => {
    const { board } = setup();
    for (const g of ["one", "two", "three"]) run(["decide", board.slug, g]);
    run(["decision", "archive", board.slug, "1", "2"]);

    const dry = JSON.parse(run(["decision", "archive", board.slug, "--by", "tester", "--dry-run"]).stdout);
    expect(dry.matched.map((d: any) => d.num)).toEqual([3]);

    const real = JSON.parse(run(["decision", "archive", board.slug, "--by", "tester"]).stdout);
    expect(real.archived.map((d: any) => d.num)).toEqual([3]);

    const dryRestore = JSON.parse(run(["decision", "restore", board.slug, "1", "3", "--dry-run"]).stdout);
    expect(dryRestore.matched.map((d: any) => d.num)).toEqual([1, 3]);
  });

  test("a selector matching nothing exits 0 with 'Nothing to archive.'", () => {
    const { board } = setup();
    const res = run(["decision", "archive", board.slug, "--card", "999"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).archived).toEqual([]);
  });

  test("archive with --reason stores it", () => {
    const { board } = setup();
    const d = JSON.parse(run(["decide", board.slug, "temp"]).stdout);
    const archived = JSON.parse(run(["decision", "archive", board.slug, String(d.num), "--reason", "stale"]).stdout);
    expect(archived.archived[0].archiveReason).toBe("stale");
  });

  test("unknown decision subcommand exits 1", () => {
    const { board } = setup();
    const res = run(["decision", "delete", board.slug, "1"]);
    expect(res.code).toBe(1);
  });

  test("decide/decisions/decision appear in help", () => {
    const help = Bun.spawnSync(["bun", mainPath, "help"]).stdout.toString();
    expect(help).toContain("decide [BOARD] GIST");
    expect(help).toContain("--supersedes");
    expect(help).toContain("decisions [BOARD]");
    expect(help).toContain("decision archive [BOARD]");
    expect(help).toContain("decision restore [BOARD]");
  });
});
