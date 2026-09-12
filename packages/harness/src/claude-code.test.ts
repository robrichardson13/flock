import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeReader } from "./claude-code.ts";

const FIXTURE_HOME = new URL("../fixtures/claude-code", import.meta.url).pathname;
const CWD = "/Users/test/project";
const ENDED_KEY = "claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c";
const SUBAGENT_KEY = "claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c#6f2c0001";
const LIVE_KEY = "claude-code:11111111-1111-1111-1111-111111111111";
const DEAD_KEY = "claude-code:22222222-2222-2222-2222-222222222222";

describe("ClaudeCodeReader.resolve", () => {
  const reader = new ClaudeCodeReader({ home: FIXTURE_HOME });

  test("derives the top-level transcript path from cwd + session id", async () => {
    const ref = await reader.resolve({ key: ENDED_KEY, cwd: CWD });
    expect(ref?.sessionId).toBe("8ea8caf2-d288-4e0a-89de-04c45158535c");
    expect(ref?.transcript?.endsWith("8ea8caf2-d288-4e0a-89de-04c45158535c.jsonl")).toBe(true);
  });

  test("derives a subagent transcript path from the #<agentId> suffix", async () => {
    const ref = await reader.resolve({ key: SUBAGENT_KEY, cwd: CWD });
    expect(ref?.agentId).toBe("6f2c0001");
    expect(ref?.transcript?.endsWith("subagents/agent-6f2c0001.jsonl")).toBe(true);
  });

  test("returns null without a cwd, since the path cannot be derived", async () => {
    expect(await reader.resolve({ key: ENDED_KEY })).toBeNull();
  });

  test("returns null for a key naming a different harness family", async () => {
    expect(await reader.resolve({ key: "codex:some-thread", cwd: CWD })).toBeNull();
  });
});

describe("ClaudeCodeReader.read — ended session", () => {
  const reader = new ClaudeCodeReader({ home: FIXTURE_HOME });

  test("reports cost, tokens, tools and liveness=gone/clean from cost-state", async () => {
    const ref = await reader.resolve({ key: ENDED_KEY, cwd: CWD });
    const reading = await reader.read(ref!);
    expect(reading?.costUsd).toBeCloseTo(4.342646999999999);
    expect(reading?.costExact).toBe(true);
    expect(reading?.toolCalls).toBe(3);
    expect(reading?.tools).toEqual({ Bash: 2, Edit: 1 });
    expect(reading?.liveness).toBe("gone");
    expect(reading?.endedReason).toBe("clean");
    expect(reading?.partial).toBe(false);
  });

  test("sums modelUsage across models for the final token counts", async () => {
    const ref = await reader.resolve({ key: ENDED_KEY, cwd: CWD });
    const reading = await reader.read(ref!);
    expect(reading?.inputTokens).toBe(154);
    expect(reading?.outputTokens).toBe(41029);
  });

  test("looks up contextMax from the model catalog for the observed model", async () => {
    const ref = await reader.resolve({ key: ENDED_KEY, cwd: CWD });
    const reading = await reader.read(ref!);
    expect(reading?.model).toBe("claude-opus-5");
    expect(reading?.contextMax).toBe(1_000_000);
  });
});

describe("ClaudeCodeReader.read — subagent", () => {
  test("reports the subagent's own model even though the parent used a different one", async () => {
    const reader = new ClaudeCodeReader({ home: FIXTURE_HOME });
    const ref = await reader.resolve({ key: SUBAGENT_KEY, cwd: CWD });
    const reading = await reader.read(ref!);
    expect(reading?.model).toBe("claude-sonnet-5");
    expect(reading?.agentId).toBe("6f2c0001");
  });
});

describe("ClaudeCodeReader.read — a transcript nothing can be found for", () => {
  test("returns a typed unavailable reading, never throws, never null for a same-family ref", async () => {
    const reader = new ClaudeCodeReader({ home: FIXTURE_HOME });
    const ref = { key: "claude-code:no-such-session", family: "claude-code", sessionId: "no-such-session", cwd: CWD, transcript: "/nowhere.jsonl" };
    const reading = await reader.read(ref);
    expect(reading?.partial).toBe(true);
    expect(reading?.liveness).toBe("unknown");
    expect(reading?.extra?.unavailableReason).toBe("missing-transcript");
  });

  test("returns null for a ref from a different family", async () => {
    const reader = new ClaudeCodeReader({ home: FIXTURE_HOME });
    const ref = { key: "codex:x", family: "codex", sessionId: "x", transcript: "/nowhere.jsonl" };
    expect(await reader.read(ref)).toBeNull();
  });
});

describe("ClaudeCodeReader.liveness", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "flock-harness-reader-"));
    await cp(FIXTURE_HOME, home, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("gone/clean when the transcript already has a cost-state line", async () => {
    const reader = new ClaudeCodeReader({ home });
    const ref = await reader.resolve({ key: ENDED_KEY, cwd: CWD });
    expect(await reader.liveness(ref!)).toMatchObject({ liveness: "gone", endedReason: "clean" });
  });

  test("gone/absent when the pid file names a pid that is not alive", async () => {
    const reader = new ClaudeCodeReader({ home });
    const ref = await reader.resolve({ key: DEAD_KEY, cwd: CWD });
    expect(await reader.liveness(ref!)).toMatchObject({ liveness: "gone", endedReason: "absent" });
  });

  test("unknown when no pid file names the session at all", async () => {
    const reader = new ClaudeCodeReader({ home });
    const ref = await reader.resolve({ key: LIVE_KEY, cwd: CWD });
    expect(await reader.liveness(ref!)).toMatchObject({ liveness: "unknown" });
  });

  test("running when the pid is alive and the transcript is fresh", async () => {
    await writeFile(
      join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "11111111-1111-1111-1111-111111111111", status: "busy" }),
    );
    const reader = new ClaudeCodeReader({ home, freshWindowMs: 1000 * 60 * 60 * 24 * 365 * 10 });
    const ref = await reader.resolve({ key: LIVE_KEY, cwd: CWD });
    const liveness = await reader.liveness(ref!);
    expect(liveness.liveness).toBe("running");
    expect(liveness.pid).toBe(process.pid);
    expect(liveness.livenessNote).toBe("busy");
  });

  test("idle when the pid is alive but the transcript is stale against a tiny fresh window", async () => {
    await writeFile(
      join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "11111111-1111-1111-1111-111111111111", status: "busy" }),
    );
    const reader = new ClaudeCodeReader({ home, freshWindowMs: 1 });
    const ref = await reader.resolve({ key: LIVE_KEY, cwd: CWD });
    expect(await reader.liveness(ref!)).toMatchObject({ liveness: "idle" });
  });
});
