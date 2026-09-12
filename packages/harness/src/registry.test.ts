import { describe, expect, test } from "bun:test";
import type { HarnessReader, LivenessReading, RunHint, RunRef } from "./reader.ts";
import { createRegistry } from "./registry.ts";

function stubReader(family: string): HarnessReader {
  return {
    family,
    resolve: async (_hint: RunHint): Promise<RunRef | null> => null,
    read: async () => null,
    liveness: async (): Promise<LivenessReading> => ({ liveness: "unknown" }),
  };
}

describe("createRegistry", () => {
  test("finds a registered reader by family name", () => {
    const registry = createRegistry([stubReader("claude-code")]);
    expect(registry.readerFor("claude-code")?.family).toBe("claude-code");
  });

  test("finds a registered reader by a full run key", () => {
    const registry = createRegistry([stubReader("claude-code")]);
    expect(registry.readerFor("claude-code:8ea8caf2-…")?.family).toBe("claude-code");
  });

  test("readerForHint uses the hint's key", () => {
    const registry = createRegistry([stubReader("codex")]);
    expect(registry.readerForHint({ key: "codex:019d2195-…" })?.family).toBe("codex");
  });

  test("returns undefined for an unregistered family", () => {
    const registry = createRegistry();
    expect(registry.readerFor("codex")).toBeUndefined();
  });

  test("register adds a reader after construction, and families lists every one", () => {
    const registry = createRegistry([stubReader("claude-code")]);
    registry.register(stubReader("codex"));
    expect([...registry.families].sort()).toEqual(["claude-code", "codex"]);
  });
});
