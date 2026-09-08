import { describe, expect, test } from "bun:test";
import { parseArgs, str } from "./args.ts";

describe("parseArgs: a bare \"-\" as a flag value", () => {
  test("--body-file - takes '-' as the value, not a boolean flag with a stray positional", () => {
    const { flags, positional } = parseArgs(["card", "new", "Title", "--body-file", "-", "--as", "tester"]);
    expect(str(flags["body-file"])).toBe("-");
    expect(positional).toEqual(["card", "new", "Title"]);
  });

  test("single-dash form: -k - also takes '-' as the value", () => {
    const { flags, positional } = parseArgs(["-k", "-"]);
    expect(str(flags.k)).toBe("-");
    expect(positional).toEqual([]);
  });

  test("a boolean flag immediately before '-' still leaves '-' positional", () => {
    // "--force" is a known boolean flag, so it never consumes the next token.
    const { flags, positional } = parseArgs(["--force", "-"]);
    expect(flags.force).toBe(true);
    expect(positional).toEqual(["-"]);
  });

  test("a real flag afterwards still terminates a bare-dash value's neighbor normally", () => {
    const { flags } = parseArgs(["--body-file", "-", "--json"]);
    expect(str(flags["body-file"])).toBe("-");
    expect(flags.json).toBe(true);
  });
});
