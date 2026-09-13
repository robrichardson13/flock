import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFragments, refineRunKey, resolveOwnAgentId } from "./claude-code-self.ts";
import { encodeCwd } from "./claude-code-paths.ts";

const CWD = "/Users/rob/repos/flock";
const SESSION = "ce8d433b-3632-400c-8a1d-6e4004fe62b5";

let home: string;
let subagents: string;

/** One transcript line shaped like Claude Code's: a JSON object whose Bash `tool_use` carries
 * the command as the model wrote it, quoting and all. */
function writeAgent(agentId: string, command: string, ageMs = 0): void {
  const line = JSON.stringify({
    isSidechain: true,
    agentId,
    sessionId: SESSION,
    cwd: CWD,
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });
  const path = join(subagents, `agent-${agentId}.jsonl`);
  writeFileSync(path, `${line}\n`);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flock-self-"));
  subagents = join(home, "projects", encodeCwd(CWD), SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("commandFragments", () => {
  test("keeps every token that survives a shell round trip unchanged", () => {
    expect(commandFragments(["claim", "106", "--as", "attribution-fixer", "--model", "opus"])).toEqual([
      "claim",
      "106",
      "--as",
      "attribution-fixer",
      "--model",
      "opus",
    ]);
  });

  test("drops tokens the shell would have quoted, because the transcript keeps the quotes", () => {
    expect(commandFragments(["comment", "106", "a long note", "--as", "builder"])).toEqual(["comment", "106", "--as", "builder"]);
  });

  test("is capped, and ignores an absurdly long token", () => {
    expect(commandFragments(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(8);
    expect(commandFragments(["x".repeat(500)])).toEqual([]);
  });
});

describe("resolveOwnAgentId", () => {
  const fragments = ["claim", "106", "--as", "attribution-fixer"];

  test("finds the one subagent transcript carrying this process's own command", () => {
    writeAgent("aaaaaaaaaaaaaaaaa", "bun run flock claim 105 --as merger");
    writeAgent("bbbbbbbbbbbbbbbbb", "cd /Users/rob/repos/flock && bun run flock claim 106 --as attribution-fixer --model opus");
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments })).toBe("bbbbbbbbbbbbbbbbb");
  });

  test("matches through the JSON escaping a transcript applies to the command", () => {
    writeAgent("ccccccccccccccccc", 'bun run flock comment 106 "a \\"quoted\\" note" --as attribution-fixer');
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments: ["comment", "106", "--as", "attribution-fixer"] })).toBe(
      "ccccccccccccccccc",
    );
  });

  test("no subagents directory (the conductor's own write) resolves to nothing", () => {
    expect(resolveOwnAgentId({ home, cwd: "/somewhere/else", sessionId: SESSION, fragments })).toBeUndefined();
  });

  test("a transcript that does not carry our command is not ours", () => {
    writeAgent("ddddddddddddddddd", "bun run flock claim 105 --as merger");
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments })).toBeUndefined();
  });

  test("a stale transcript is never claimed as ours, however well it matches", () => {
    writeAgent("eeeeeeeeeeeeeeeee", "bun run flock claim 106 --as attribution-fixer", 60 * 60 * 1000);
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments })).toBeUndefined();
  });

  test("with no fragments to go on it refuses to guess", () => {
    writeAgent("fffffffffffffffff", "bun run flock claim 106 --as attribution-fixer");
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments: [] })).toBeUndefined();
  });

  test("two identical commands resolve to the most recently written transcript", () => {
    writeAgent("ggggggggggggggggg", "bun run flock claim 106 --as attribution-fixer", 30_000);
    writeAgent("hhhhhhhhhhhhhhhhh", "bun run flock claim 106 --as attribution-fixer");
    expect(resolveOwnAgentId({ home, cwd: CWD, sessionId: SESSION, fragments })).toBe("hhhhhhhhhhhhhhhhh");
  });
});

describe("refineRunKey", () => {
  const argv = ["claim", "106", "--as", "attribution-fixer"];

  test("appends the agent id when this write is inside a subagent", () => {
    writeAgent("a9e6feec4e1969307", "bun run flock claim 106 --as attribution-fixer");
    expect(refineRunKey(`claude-code:${SESSION}`, CWD, argv, { home })).toBe(`claude-code:${SESSION}#a9e6feec4e1969307`);
  });

  test("leaves the conductor's own key alone", () => {
    writeAgent("a9e6feec4e1969307", "bun run flock claim 105 --as merger");
    expect(refineRunKey(`claude-code:${SESSION}`, CWD, argv, { home })).toBe(`claude-code:${SESSION}`);
  });

  test("never rewrites a key that already names an agent, or one with no session id", () => {
    const already = `claude-code:${SESSION}#already`;
    expect(refineRunKey(already, CWD, argv, { home })).toBe(already);
    expect(refineRunKey("claude-code:", CWD, argv, { home })).toBe("claude-code:");
    expect(refineRunKey("bare", CWD, argv, { home })).toBe("bare");
  });
});
