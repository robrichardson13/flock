import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercises `flock react` / `flock say` / `flock chat` / `flock log` end to end as a subprocess.
// The domain rule (react/unreact, idempotency, event shape) lives in
// packages/core/test/reactions.test.ts; this checks the CLI is thin over it: ref parsing,
// human/--json output, and exit codes.

const mainPath = join(import.meta.dir, "main.ts");
let dbPath: string;

function run(args: string[]) {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", "tester", "--json"], {
    env: { ...process.env },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function runHuman(args: string[], as = "tester") {
  const res = Bun.spawnSync(["bun", mainPath, ...args, "--db", dbPath, "--as", as], { env: { ...process.env } });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

function setup() {
  dbPath = join(mkdtempSync(join(tmpdir(), "flock-cli-test-")), "flock.db");
  const board = JSON.parse(run(["board", "new", "React test", "--project", mkdtempSync(join(tmpdir(), "flock-project-"))]).stdout);
  return { board };
}

afterEach(() => {
  if (dbPath) rmSync(dbPath, { force: true });
});

describe("flock say / chat show message refs and reactions", () => {
  test("say prints the new message's ref", () => {
    const { board } = setup();
    const human = runHuman(["say", board.slug, "hello"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("m1");
    expect(human.stdout).toContain("hello");
  });

  test("chat --json includes num, ref-able num, and reactions", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    const ms = JSON.parse(run(["chat", board.slug]).stdout);
    expect(ms).toHaveLength(1);
    expect(ms[0].num).toBe(1);
    expect(ms[0].reactions).toEqual([]);
  });

  test("chat human output shows the ref and reactions under a message", () => {
    const { board } = setup();
    run(["say", board.slug, "sounds good"]);
    runHuman(["react", board.slug, "m1", "👍"], "rob");
    const human = runHuman(["chat", board.slug]);
    expect(human.stdout).toContain("m1");
    expect(human.stdout).toContain("sounds good");
    expect(human.stdout).toContain("👍 1 (rob)");
  });
});

describe("flock react", () => {
  test("reacts to a message by m<n> ref; --json returns the core result", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    const result = JSON.parse(run(["react", board.slug, "m1", "👍"]).stdout);
    expect(result.changed).toBe(true);
    expect(result.message.reactions).toEqual([{ emoji: "👍", count: 1, actors: ["tester"] }]);
  });

  test("accepts a bare number in place of m<n>", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    const result = JSON.parse(run(["react", board.slug, "1", "👍"]).stdout);
    expect(result.changed).toBe(true);
  });

  test("human output names the emoji, ref and actor", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    const human = runHuman(["react", board.slug, "m1", "👍"]);
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe("👍 m1 (tester)");
  });

  test("reacting twice with the same emoji is a no-op: changed false, human says already reacted", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    run(["react", board.slug, "m1", "👍"]);
    const result = JSON.parse(run(["react", board.slug, "m1", "👍"]).stdout);
    expect(result.changed).toBe(false);
    const human = runHuman(["react", board.slug, "m1", "👍"]);
    expect(human.stdout.trim()).toBe("already reacted");
  });

  test("--remove unreacts; human output says removed / not reacted", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    run(["react", board.slug, "m1", "👍"]);
    const removed = runHuman(["react", board.slug, "m1", "👍", "--remove"]);
    expect(removed.stdout.trim()).toBe("👍 m1 (tester) removed");
    const again = runHuman(["react", board.slug, "m1", "👍", "--remove"]);
    expect(again.stdout.trim()).toBe("not reacted");
  });

  test("unknown message exits 2", () => {
    const { board } = setup();
    const result = run(["react", board.slug, "m99", "👍"]);
    expect(result.code).toBe(2);
  });

  test("invalid emoji exits 1 with core's message", () => {
    const { board } = setup();
    run(["say", board.slug, "hello"]);
    const result = run(["react", board.slug, "m1", "two words"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("whitespace");
  });

  test("`flock help` lists react next to say", () => {
    const help = Bun.spawnSync(["bun", mainPath, "help"], { env: { ...process.env } }).stdout.toString();
    expect(help.indexOf("say [BOARD]")).toBeGreaterThanOrEqual(0);
    expect(help.indexOf("react [BOARD]")).toBeGreaterThan(help.indexOf("say [BOARD]"));
  });
});

describe("flock log renders reactions readably", () => {
  test("message.reacted / message.unreacted show emoji, ref, and message author/gist", () => {
    const { board } = setup();
    runHuman(["say", board.slug, "sounds good"], "rob");
    runHuman(["react", board.slug, "m1", "👍"], "conductor");
    runHuman(["react", board.slug, "m1", "👍", "--remove"], "conductor");
    const human = runHuman(["log", board.slug]);
    expect(human.stdout).toContain("message.reacted");
    expect(human.stdout).toContain("👍 m1");
    expect(human.stdout).toContain("rob");
    expect(human.stdout).toContain("sounds good");
    expect(human.stdout).toContain("message.unreacted");
  });
});

// Comment reactions: core's react/unreact-on-comment semantics live in
// packages/core/test/comment-reactions.test.ts; this checks the CLI is thin over it too.

function setupCardWithComment() {
  const { board } = setup();
  const card = JSON.parse(run(["card", "new", board.slug, "Do the thing"]).stdout);
  run(["comment", board.slug, String(card.num), "on it"]);
  return { board, card };
}

describe("flock react on a comment ref", () => {
  test("reacts to a comment by <card>.<n> ref; --json returns the core result", () => {
    const { board, card } = setupCardWithComment();
    const ref = `${card.num}.1`;
    const result = JSON.parse(run(["react", board.slug, ref, "👍"]).stdout);
    expect(result.changed).toBe(true);
    expect(result.comment.reactions).toEqual([{ emoji: "👍", count: 1, actors: ["tester"] }]);
  });

  test("human output names the emoji, comment ref and actor", () => {
    const { board, card } = setupCardWithComment();
    const ref = `${card.num}.1`;
    const human = runHuman(["react", board.slug, ref, "👍"]);
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe(`👍 ${ref} (tester)`);
  });

  test("reacting twice with the same emoji is a no-op: changed false, human says already reacted", () => {
    const { board, card } = setupCardWithComment();
    const ref = `${card.num}.1`;
    run(["react", board.slug, ref, "👍"]);
    const result = JSON.parse(run(["react", board.slug, ref, "👍"]).stdout);
    expect(result.changed).toBe(false);
    const human = runHuman(["react", board.slug, ref, "👍"]);
    expect(human.stdout.trim()).toBe("already reacted");
  });

  test("--remove unreacts a comment; human output says removed / not reacted", () => {
    const { board, card } = setupCardWithComment();
    const ref = `${card.num}.1`;
    run(["react", board.slug, ref, "👍"]);
    const removed = runHuman(["react", board.slug, ref, "👍", "--remove"]);
    expect(removed.stdout.trim()).toBe(`👍 ${ref} (tester) removed`);
    const again = runHuman(["react", board.slug, ref, "👍", "--remove"]);
    expect(again.stdout.trim()).toBe("not reacted");
  });

  test("unknown comment exits 2", () => {
    const { board, card } = setupCardWithComment();
    const result = run(["react", board.slug, `${card.num}.99`, "👍"]);
    expect(result.code).toBe(2);
  });

  test("unknown card in a comment ref exits 2", () => {
    const { board } = setup();
    const result = run(["react", board.slug, "999.1", "👍"]);
    expect(result.code).toBe(2);
  });

  test("a ref matching neither m<n> nor <card>.<n> is a usage error, exit 1", () => {
    const { board } = setupCardWithComment();
    const result = run(["react", board.slug, "bogus", "👍"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("not a message reference");
  });

  test("invalid emoji on a comment exits 1 with core's message", () => {
    const { board, card } = setupCardWithComment();
    const result = run(["react", board.slug, `${card.num}.1`, "two words"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("whitespace");
  });
});

describe("flock card show prints comment refs and reactions", () => {
  test("--json comments carry num, cardNum and reactions", () => {
    const { board, card } = setupCardWithComment();
    run(["react", board.slug, `${card.num}.1`, "👍"]);
    const shown = JSON.parse(run(["card", "show", board.slug, String(card.num)]).stdout);
    expect(shown.comments).toHaveLength(1);
    expect(shown.comments[0].num).toBe(1);
    expect(shown.comments[0].cardNum).toBe(card.num);
    expect(shown.comments[0].reactions).toEqual([{ emoji: "👍", count: 1, actors: ["tester"] }]);
  });

  test("human output shows the comment's ref and reactions", () => {
    const { board, card } = setupCardWithComment();
    run(["react", board.slug, `${card.num}.1`, "👍"]);
    const human = runHuman(["card", "show", board.slug, String(card.num)]);
    expect(human.stdout).toContain(`${card.num}.1`);
    expect(human.stdout).toContain("on it");
    expect(human.stdout).toContain("👍 1 (tester)");
  });
});

describe("flock log renders comment reactions readably", () => {
  test("comment.reacted / comment.unreacted show emoji, ref, and comment author/gist", () => {
    const { board, card } = setupCardWithComment();
    const ref = `${card.num}.1`;
    runHuman(["react", board.slug, ref, "👍"], "conductor");
    runHuman(["react", board.slug, ref, "👍", "--remove"], "conductor");
    const human = runHuman(["log", board.slug]);
    expect(human.stdout).toContain("comment.reacted");
    expect(human.stdout).toContain(`👍 ${ref}`);
    expect(human.stdout).toContain("tester");
    expect(human.stdout).toContain("on it");
    expect(human.stdout).toContain("comment.unreacted");
  });
});
