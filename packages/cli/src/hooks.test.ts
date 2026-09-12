import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, HOOKS_MARKER, installHooks, isNoHooks, removeHooks } from "./hooks.ts";

// Every test points CLAUDE_SETTINGS_PATH at a fresh scratch file, never the real
// ~/.claude/settings.json, per the card's requirement that these tests use a temp HOME
// equivalent and never touch a real file.
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "flock-hooks-"));
const dirs: string[] = [];
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_SETTINGS_PATH;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
  else process.env.CLAUDE_SETTINGS_PATH = saved;
});

function scratchSettingsPath(): string {
  const d = mkdtempSync(join(SCRATCH_ROOT, "home-"));
  dirs.push(d);
  const path = join(d, ".claude", "settings.json");
  process.env.CLAUDE_SETTINGS_PATH = path;
  return path;
}

describe("claudeSettingsPath", () => {
  test("honors CLAUDE_SETTINGS_PATH", () => {
    const path = scratchSettingsPath();
    expect(claudeSettingsPath()).toBe(path);
  });
});

describe("isNoHooks", () => {
  test("only an unset/falsy value opts in", () => {
    expect(isNoHooks(undefined)).toBe(false);
    expect(isNoHooks("")).toBe(false);
    expect(isNoHooks("0")).toBe(false);
    expect(isNoHooks("false")).toBe(false);
  });

  test("any other non-empty value opts out", () => {
    expect(isNoHooks("1")).toBe(true);
    expect(isNoHooks("true")).toBe(true);
    expect(isNoHooks("yes")).toBe(true);
  });
});

describe("installHooks", () => {
  test("creates settings.json from scratch with marked SessionEnd + SubagentStop entries", () => {
    const path = scratchSettingsPath();
    const result = installHooks();
    expect(result.action).toBe("installed");
    expect(existsSync(path)).toBe(true);

    const settings = JSON.parse(readFileSync(path, "utf8"));
    for (const event of ["SessionEnd", "SubagentStop"]) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0]._flock).toBe(HOOKS_MARKER);
      expect(settings.hooks[event][0].hooks[0].command).toBe("flock telemetry record");
    }
  });

  test("is idempotent: a second install does not duplicate the entry", () => {
    scratchSettingsPath();
    installHooks();
    const result = installHooks();
    expect(result.action).toBe("already-installed");

    const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    expect(settings.hooks.SessionEnd).toHaveLength(1);
  });

  test("is additive: an existing unrelated hook and setting survive", () => {
    const path = scratchSettingsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        someOtherSetting: true,
        hooks: { SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    installHooks();
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.SessionEnd).toHaveLength(2);
    expect(settings.hooks.SessionEnd.some((g: { _flock?: string }) => g._flock === HOOKS_MARKER)).toBe(true);
    expect(settings.hooks.SessionEnd.some((g: { hooks: { command: string }[] }) => g.hooks[0]?.command === "echo hi")).toBe(true);
  });

  test("refuses to write when the file does not parse as JSON, and touches nothing", () => {
    const path = scratchSettingsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json");
    const before = readFileSync(path, "utf8");
    const result = installHooks();
    expect(result.action).toBe("parse-error");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("removeHooks", () => {
  test("removes exactly flock's marked entries, byte for byte, leaving everything else", () => {
    const path = scratchSettingsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        someOtherSetting: true,
        hooks: { SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    installHooks();
    const result = removeHooks();
    expect(result.action).toBe("removed");

    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe("echo hi");
    expect(settings.hooks.SubagentStop).toBeUndefined();
  });

  test("deletes the hooks key entirely once nothing else uses it", () => {
    scratchSettingsPath();
    installHooks();
    removeHooks();
    const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    expect(settings.hooks).toBeUndefined();
  });

  test("is a no-op on a file with no flock hooks installed", () => {
    const path = scratchSettingsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: {} }));
    const result = removeHooks();
    expect(result.action).toBe("nothing-to-remove");
  });

  test("is a no-op on a missing file", () => {
    scratchSettingsPath();
    const result = removeHooks();
    expect(result.action).toBe("nothing-to-remove");
  });

  test("refuses to write when the file does not parse as JSON", () => {
    const path = scratchSettingsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json at all");
    const result = removeHooks();
    expect(result.action).toBe("parse-error");
  });
});
