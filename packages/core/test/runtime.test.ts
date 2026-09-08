import { describe, expect, test } from "bun:test";
import { detectRuntime, normalizeRuntime } from "../src/index.ts";

describe("detectRuntime", () => {
  test("detects Claude Code from CLAUDECODE and parses the version out of AI_AGENT", () => {
    const env = {
      CLAUDECODE: "1",
      AI_AGENT: "claude-code_2-1-261_agent",
      CLAUDE_EFFORT: "medium",
    } as NodeJS.ProcessEnv;
    const r = detectRuntime(env);
    expect(r.harness).toBe("claude-code@2.1.261");
    expect(r.effort).toBe("medium");
    expect(r.model).toBeUndefined();
  });

  test("an empty environment detects nothing", () => {
    expect(detectRuntime({} as NodeJS.ProcessEnv)).toEqual({});
  });

  test("a malformed AI_AGENT still detects the harness by name, falling back to a bare label", () => {
    const env = { AI_AGENT: "claude-code-but-not-the-expected-shape" } as NodeJS.ProcessEnv;
    const r = detectRuntime(env);
    expect(r.harness).toBe("claude-code");
    expect(r.model).toBeUndefined();
  });

  test("falls back to CLAUDE_CODE_EXECPATH's trailing version segment when AI_AGENT has none", () => {
    const env = {
      CLAUDECODE: "1",
      CLAUDE_CODE_EXECPATH: "/Users/x/.claude/versions/2.1.261",
    } as NodeJS.ProcessEnv;
    const r = detectRuntime(env);
    expect(r.harness).toBe("claude-code@2.1.261");
  });

  test("never detects a model, even with a settings.json-like var present", () => {
    const env = { CLAUDECODE: "1", CLAUDE_MODEL: "sonnet" } as NodeJS.ProcessEnv;
    expect(detectRuntime(env).model).toBeUndefined();
  });
});

describe("normalizeRuntime", () => {
  test("trims, lowercases, and caps at 64 characters", () => {
    const r = normalizeRuntime({ harness: "  Claude-Code  ", model: "OPUS-5", effort: "HIGH" });
    expect(r).toEqual({ harness: "claude-code", model: "opus-5", effort: "high" });
  });

  test("drops empty and whitespace-only fields", () => {
    expect(normalizeRuntime({ harness: "", model: "   ", effort: undefined })).toEqual({});
  });

  test("caps at 64 characters", () => {
    const long = "x".repeat(100);
    expect(normalizeRuntime({ model: long }).model).toHaveLength(64);
  });
});
