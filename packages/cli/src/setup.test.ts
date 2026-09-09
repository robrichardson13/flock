import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { skillPath, version } from "./runtime.ts";
import { claudeSkillsDir, setupCommand, skillDestPath, skillJsonPath, writeSkill } from "./setup.ts";

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "flock-setup-home-"));

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const dirs: string[] = [];
let savedHome: string | undefined;
let savedFlockHome: string | undefined;

function scratchHome(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const d = mkdtempSync(join(SCRATCH_ROOT, "home-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedFlockHome = process.env.FLOCK_HOME;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedFlockHome === undefined) delete process.env.FLOCK_HOME;
  else process.env.FLOCK_HOME = savedFlockHome;
  delete process.env.CLAUDE_SKILLS_DIR;
});

/** Points HOME (and FLOCK_HOME, per daemon.ts's convention) at a fresh scratch directory. */
function useScratchHome(): string {
  const home = scratchHome();
  process.env.HOME = home;
  process.env.FLOCK_HOME = join(home, ".flock");
  return home;
}

describe("writeSkill", () => {
  test("fresh write: a real file, matching the embedded source, plus a skill.json record", async () => {
    useScratchHome();
        const result = writeSkill();
    expect(result.action).toBe("written");
    const dest = skillDestPath();
    expect(existsSync(dest)).toBe(true);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(skillPath, "utf8"));

    const record = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    expect(typeof record.sha256).toBe("string");
    expect(typeof record.writtenAt).toBe("string");
    expect(record.path).toBe(dest);
  });

  test("a symlinked flock/ skill directory is left alone", async () => {
    const home = useScratchHome();
        const skillsDir = join(home, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const target = join(home, "checkout-skill");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "# contributor copy\n");
    symlinkSync(target, join(skillsDir, "flock"));

    const result = writeSkill();
    expect(result.action).toBe("symlink-preserved");
    // untouched: still a symlink, still pointing at the contributor's checkout content
    const dest = skillDestPath();
    expect(lstatSync(join(skillsDir, "flock")).isSymbolicLink()).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("# contributor copy\n");
  });

  test("re-running with an identical skill is a no-op", async () => {
    useScratchHome();
        const first = writeSkill();
    expect(first.action).toBe("written");
    const second = writeSkill();
    expect(second.action).toBe("up-to-date");
  });

  test("an edited destination file is repaired even when skill.json still matches", async () => {
    useScratchHome();
    expect(writeSkill().action).toBe("written");
    // The record still vouches for the embedded hash; only the file on disk has drifted. Trusting
    // the record here would leave a mangled SKILL.md in place forever.
    writeFileSync(skillDestPath(), "MUTATED\n");

    const result = writeSkill();
    expect(result.action).toBe("written");
    expect(readFileSync(skillDestPath(), "utf8")).toBe(readFileSync(skillPath, "utf8"));
  });

  test("skill.json is restamped when the file is right but the record names an older version", async () => {
    useScratchHome();
    writeSkill();
    const record = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    writeFileSync(skillJsonPath(), JSON.stringify({ ...record, version: "0.0.0-old" }));

    const result = writeSkill();
    expect(result.action).toBe("up-to-date");
    const updated = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    expect(updated.version).toBe(version());
    expect(updated.sha256).toBe(record.sha256);
  });

  test("a corrupt recorded hash is healed without rewriting a file that is already correct", async () => {
    useScratchHome();
    writeSkill();
    const record = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    record.sha256 = "not-the-real-hash";
    writeFileSync(skillJsonPath(), JSON.stringify(record));

    // The file on disk is the authority, so this is "up-to-date" — but the bad record is corrected.
    const result = writeSkill();
    expect(result.action).toBe("up-to-date");
    const updated = JSON.parse(readFileSync(skillJsonPath(), "utf8"));
    expect(updated.sha256).not.toBe("not-the-real-hash");
    expect(readFileSync(skillDestPath(), "utf8")).toBe(readFileSync(skillPath, "utf8"));
  });
});

// B2 regression: `??` doesn't catch HOME="", so `join("", ".claude", "skills")` used to resolve
// to a relative path (a `.claude` dropped into whatever the cwd happened to be). claudeSkillsDir
// must always resolve to an absolute path derived from a real home directory.
describe("claudeSkillsDir", () => {
  test('HOME="" never produces a relative path; falls back to os.homedir()', () => {
    process.env.HOME = "";
    delete process.env.CLAUDE_SKILLS_DIR;

    const dir = claudeSkillsDir();

    expect(isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(".")).toBe(false);
  });
});

describe("setupCommand", () => {
  test("--skill-only writes the skill and starts nothing", async () => {
    const home = useScratchHome();
        await setupCommand({ json: false, skillOnly: true });

    const skillFile = join(home, ".claude", "skills", "flock", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);

    const runDir = join(home, ".flock", "run");
    const running = existsSync(runDir) ? readdirSync(runDir) : [];
    expect(running).toEqual([]);
  });

  // N1/N2 regression: a checkout (bun test is never a standalone compiled binary) must never edit
  // a real shell rc, and --skill-only must not touch it either, even if it somehow were standalone.
  test("never touches the shell rc from a checkout, with or without --skill-only", async () => {
    const home = useScratchHome();
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "# untouched\n");

    await setupCommand({ json: false, skillOnly: true });
    await setupCommand({ json: false, noStart: true });

    expect(readFileSync(rc, "utf8")).toBe("# untouched\n");
  });
});
