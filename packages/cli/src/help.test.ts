import { describe, expect, test } from "bun:test";

const CLI = new URL("./main.ts", import.meta.url).pathname;

function runHelp(args: string[] = ["help"]): string {
  const result = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString();
}

describe("flock --help / bare flock", () => {
  test("the agent preamble appears before USAGE", () => {
    const text = runHelp();
    expect(text.indexOf("FOR AGENTS")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("FOR AGENTS")).toBeLessThan(text.indexOf("USAGE"));
  });

  test("the preamble covers the one-line card-filing command and attribution", () => {
    const text = runHelp();
    expect(text).toContain('flock card new "<title>" --body "<markdown>" --as <your-name>');
    expect(text).toContain("FLOCK_ACTOR");
    expect(text).toContain("flock boards --here");
    expect(text).toContain("flock handoff");
  });

  test("`card new` appears before the first daemon verb (`up`)", () => {
    const text = runHelp();
    const cardNewIndex = text.indexOf("card new");
    const upIndex = text.indexOf("\n  up [--port N]");
    expect(cardNewIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(0);
    expect(cardNewIndex).toBeLessThan(upIndex);
  });

  test("IDENTITY leads SETUP", () => {
    const text = runHelp();
    expect(text.indexOf("IDENTITY")).toBeLessThan(text.indexOf("SETUP"));
  });

  test("bare `flock` and `--help`/`-h` print the same help as `flock help`", () => {
    const bare = runHelp([]);
    const help = runHelp(["help"]);
    const dashDash = runHelp(["--help"]);
    const dashH = runHelp(["-h"]);
    expect(bare).toBe(help);
    expect(dashDash).toBe(help);
    expect(dashH).toBe(help);
  });

  test("--tailscale / --no-tailscale, FLOCK_TAILSCALE and FLOCK_TAILSCALE_BIN are documented", () => {
    const text = runHelp();
    expect(text).toContain("--tailscale");
    expect(text).toContain("--no-tailscale");
    expect(text).toContain("FLOCK_TAILSCALE");
    expect(text).toContain("FLOCK_TAILSCALE_BIN");
    expect(text).toContain("docs/adr/0019");
  });

  test("`help formatting` is unaffected by the reorder", () => {
    const formatting = runHelp(["help", "formatting"]);
    expect(formatting).toContain("message formatting");
    expect(formatting).not.toBe(runHelp());
  });
});
