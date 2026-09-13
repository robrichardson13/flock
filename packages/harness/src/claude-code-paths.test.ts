import { describe, expect, test } from "bun:test";
import {
  contextMaxForModel,
  encodeCwd,
  findModelCatalogFiles,
  baseModelId,
  normalizeAgentId,
  projectDir,
  subagentTranscriptPath,
  transcriptPath,
  windowFromModelVariant,
} from "./claude-code-paths.ts";

const FIXTURE_HOME = new URL("../fixtures/claude-code", import.meta.url).pathname;

describe("encodeCwd", () => {
  test("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeCwd("/Users/robrichardson/repos/flock")).toBe("-Users-robrichardson-repos-flock");
    expect(encodeCwd("/Users/robrichardson/.atlas")).toBe("-Users-robrichardson--atlas");
  });

  test("is lossy: two different cwds can collide", () => {
    expect(encodeCwd("/Users/rob/-atlas")).toBe(encodeCwd("/Users/rob/.atlas"));
  });
});

describe("transcript path derivation", () => {
  const cwd = "/Users/test/project";

  test("builds <projects>/<encoded-cwd>/<session>.jsonl", () => {
    expect(transcriptPath(FIXTURE_HOME, cwd, "abc")).toBe(`${projectDir(FIXTURE_HOME, cwd)}/abc.jsonl`);
  });

  test("subagent transcript nests under <session>/subagents/agent-<id>.jsonl", () => {
    expect(subagentTranscriptPath(FIXTURE_HOME, cwd, "abc", "6f2c0001")).toBe(
      `${projectDir(FIXTURE_HOME, cwd)}/abc/subagents/agent-6f2c0001.jsonl`,
    );
  });

  test("normalizes an agentId that already carries the agent- prefix", () => {
    expect(normalizeAgentId("agent-6f2c0001")).toBe("6f2c0001");
    expect(normalizeAgentId("6f2c0001")).toBe("6f2c0001");
    expect(subagentTranscriptPath(FIXTURE_HOME, cwd, "abc", "agent-6f2c0001")).toBe(
      subagentTranscriptPath(FIXTURE_HOME, cwd, "abc", "6f2c0001"),
    );
  });
});

describe("model catalog", () => {
  test("finds every published-*.json in the cache, sentinel included", async () => {
    const files = await findModelCatalogFiles(FIXTURE_HOME);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("published-abc123.json"))).toBe(true);
  });

  test("a same-mtime sentinel file never costs the machine its windows", async () => {
    // `published-floor.json` is a real file Claude Code keeps beside the catalogue: a different
    // shape, and the same mtime, so "newest file wins" is a coin flip. Every candidate is tried.
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-sonnet-5")).toBe(1_000_000);
  });

  test("reads runtime.max_input_tokens for a known model", async () => {
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-opus-5")).toBe(1_000_000);
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("reads the 1M window Sonnet, Opus and Fable actually have", async () => {
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-sonnet-5")).toBe(1_000_000);
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-opus-5")).toBe(1_000_000);
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-fable-5-1")).toBe(1_000_000);
  });

  test("a bracketed variant in the model id is the harness stating the window, and wins", async () => {
    // Catalogued at 200K, but this run was on the 1M window and the id says so.
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-haiku-4-5-20251001[1m]")).toBe(1_000_000);
    // A variant on a model no catalogue here knows still gets its window.
    expect(await contextMaxForModel(FIXTURE_HOME, "some-future-model[1m]")).toBe(1_000_000);
    expect(windowFromModelVariant("claude-opus-5[200k]")).toBe(200_000);
    expect(windowFromModelVariant("claude-opus-5")).toBeUndefined();
    expect(baseModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(baseModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  test("returns undefined for an unknown model rather than guessing", async () => {
    expect(await contextMaxForModel(FIXTURE_HOME, "some-future-model")).toBeUndefined();
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-3-5-sonnet-20241022")).toBeUndefined();
  });

  test("returns undefined, never throws, when the cache directory is missing", async () => {
    expect(await contextMaxForModel("/nonexistent/claude/home", "claude-opus-5")).toBeUndefined();
    expect(await findModelCatalogFiles("/nonexistent/claude/home")).toEqual([]);
  });
});
