import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";
import { resolveActor } from "./identity.ts";

const RUNTIME_ENV_KEYS = ["FLOCK_ACTOR", "FLOCK_ACTOR_KIND", "FLOCK_HARNESS", "FLOCK_MODEL", "FLOCK_EFFORT", "FLOCK_SESSION", "CLAUDECODE", "AI_AGENT", "CLAUDE_EFFORT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(RUNTIME_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of RUNTIME_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of RUNTIME_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveActor runtime precedence: flag > env > detection > nothing", () => {
  test("nothing set: runtime fields stay undefined", () => {
    const { flags } = parseArgs(["--as", "scout"]);
    const actor = resolveActor(flags);
    expect(actor.harness).toBeUndefined();
    expect(actor.model).toBeUndefined();
    expect(actor.effort).toBeUndefined();
  });

  test("detection fills harness and effort when the environment looks like Claude Code", () => {
    process.env.CLAUDECODE = "1";
    process.env.AI_AGENT = "claude-code_2-1-261_agent";
    process.env.CLAUDE_EFFORT = "medium";
    const { flags } = parseArgs(["--as", "scout"]);
    const actor = resolveActor(flags);
    expect(actor.harness).toBe("claude-code@2.1.261");
    expect(actor.effort).toBe("medium");
    expect(actor.model).toBeUndefined();
  });

  test("env vars override detection", () => {
    process.env.CLAUDECODE = "1";
    process.env.AI_AGENT = "claude-code_2-1-261_agent";
    process.env.CLAUDE_EFFORT = "medium";
    process.env.FLOCK_HARNESS = "codex";
    process.env.FLOCK_EFFORT = "high";
    process.env.FLOCK_MODEL = "opus-5";
    const { flags } = parseArgs(["--as", "scout"]);
    const actor = resolveActor(flags);
    expect(actor.harness).toBe("codex");
    expect(actor.effort).toBe("high");
    expect(actor.model).toBe("opus-5");
  });

  test("flags override everything, including env", () => {
    process.env.FLOCK_HARNESS = "codex";
    process.env.FLOCK_MODEL = "opus-5";
    process.env.FLOCK_EFFORT = "high";
    const { flags } = parseArgs(["--as", "scout", "--harness", "claude-code@9.9.9", "--model", "sonnet-5", "--effort", "low"]);
    const actor = resolveActor(flags);
    expect(actor.harness).toBe("claude-code@9.9.9");
    expect(actor.model).toBe("sonnet-5");
    expect(actor.effort).toBe("low");
  });

  test("session: nothing set stays undefined", () => {
    const { flags } = parseArgs(["--as", "scout"]);
    expect(resolveActor(flags).session).toBeUndefined();
  });

  test("session: detected from CLAUDE_CODE_SESSION_ID (ADR 0026)", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "8ea8caf2-d288-4e0a-89de-04c45158535c";
    const { flags } = parseArgs(["--as", "scout"]);
    expect(resolveActor(flags).session).toBe("claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c");
  });

  test("session: FLOCK_SESSION overrides detection", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "8ea8caf2-d288-4e0a-89de-04c45158535c";
    process.env.FLOCK_SESSION = "claude-code:override-id";
    const { flags } = parseArgs(["--as", "scout"]);
    expect(resolveActor(flags).session).toBe("claude-code:override-id");
  });

  test("session: --session overrides everything", () => {
    process.env.FLOCK_SESSION = "claude-code:from-env";
    const { flags } = parseArgs(["--as", "scout", "--session", "claude-code:from-flag"]);
    expect(resolveActor(flags).session).toBe("claude-code:from-flag");
  });
});
