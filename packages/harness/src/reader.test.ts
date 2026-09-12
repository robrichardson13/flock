import { describe, expect, test } from "bun:test";
import { familyOf } from "./reader.ts";

describe("familyOf", () => {
  test("splits on the first colon", () => {
    expect(familyOf("claude-code:8ea8caf2-…")).toBe("claude-code");
    expect(familyOf("claude-code:8ea8caf2-…#agent-1")).toBe("claude-code");
    expect(familyOf("codex:019d2195-…")).toBe("codex");
  });

  test("returns the whole string when there is no colon", () => {
    expect(familyOf("claude-code")).toBe("claude-code");
  });
});
