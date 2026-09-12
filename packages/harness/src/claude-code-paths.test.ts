import { describe, expect, test } from "bun:test";
import {
  contextMaxForModel,
  encodeCwd,
  findModelCatalogFiles,
  normalizeAgentId,
  projectDir,
  subagentTranscriptPath,
  transcriptPath,
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
  test("finds the fixture catalog file", async () => {
    const files = await findModelCatalogFiles(FIXTURE_HOME);
    expect(files.length).toBe(1);
    expect(files[0].endsWith("published-abc123.json")).toBe(true);
  });

  test("reads runtime.max_input_tokens for a known model", async () => {
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-opus-5")).toBe(1_000_000);
    expect(await contextMaxForModel(FIXTURE_HOME, "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("returns undefined for an unknown model rather than guessing", async () => {
    expect(await contextMaxForModel(FIXTURE_HOME, "some-future-model")).toBeUndefined();
  });

  test("returns undefined, never throws, when the cache directory is missing", async () => {
    expect(await contextMaxForModel("/nonexistent/claude/home", "claude-opus-5")).toBeUndefined();
    expect(await findModelCatalogFiles("/nonexistent/claude/home")).toEqual([]);
  });
});
