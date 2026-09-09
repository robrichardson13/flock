import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePathConfigured, isNoModifyPath, PATH_MARKER, type PathSetupEnv } from "./path-setup.ts";

// A scratch HOME per test, never the real one — this module edits real rc files in production,
// so its tests must never touch ~/.zshrc or ~/.bashrc.
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "flock-path-setup-"));
const dirs: string[] = [];

afterAll(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function scratchHome(): string {
  const d = mkdtempSync(join(SCRATCH_ROOT, "home-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INSTALL_DIR = "/home/x/.flock/bin";

function zshEnv(home: string, overrides: Partial<PathSetupEnv> = {}): PathSetupEnv {
  return {
    home,
    shell: "/bin/zsh",
    path: "/usr/bin:/bin",
    platform: "darwin",
    noModifyPath: false,
    ...overrides,
  };
}

describe("ensurePathConfigured", () => {
  test("rc already contains the marker: no-op, nothing appended again", () => {
    const home = scratchHome();
    const rc = join(home, ".zshrc");
    writeFileSync(rc, `# my stuff\n\n${PATH_MARKER}\nexport PATH="${INSTALL_DIR}:$PATH"\n`);
    const before = readFileSync(rc, "utf8");

    const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home));

    expect(result).toEqual({ action: "already-present", rc });
    expect(readFileSync(rc, "utf8")).toBe(before);
  });

  test("rc lacks it: appended exactly once", () => {
    const home = scratchHome();
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "# existing user content\n");

    const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home));

    expect(result).toEqual({ action: "appended", rc });
    const content = readFileSync(rc, "utf8");
    expect(content.startsWith("# existing user content\n")).toBe(true);
    expect(content).toContain(PATH_MARKER);
    expect(content).toContain(`export PATH="${INSTALL_DIR}:$PATH"`);
    expect(content.split(PATH_MARKER).length - 1).toBe(1);
  });

  test("run twice in a row: still exactly once", () => {
    const home = scratchHome();
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "");

    const first = ensurePathConfigured(INSTALL_DIR, zshEnv(home));
    expect(first.action).toBe("appended");
    const second = ensurePathConfigured(INSTALL_DIR, zshEnv(home));
    expect(second).toEqual({ action: "already-present", rc });

    const content = readFileSync(rc, "utf8");
    expect(content.split(PATH_MARKER).length - 1).toBe(1);
    expect(content.split(`export PATH="${INSTALL_DIR}:$PATH"`).length - 1).toBe(1);
  });

  test("FLOCK_NO_MODIFY_PATH=1: prints the fallback block, writes nothing", () => {
    const home = scratchHome();
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "# untouched\n");

    const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home, { noModifyPath: true }));

    expect(result.action).toBe("printed");
    if (result.action === "printed") {
      expect(result.message).toContain(INSTALL_DIR);
      expect(result.message).toContain(`export PATH="${INSTALL_DIR}:$PATH"`);
    }
    expect(readFileSync(rc, "utf8")).toBe("# untouched\n");
  });

  test("no rc determinable ($SHELL unset): prints the block, writes nothing, does not crash", () => {
    const home = scratchHome();
    // No rc file of any kind exists, and no shell is set.
    expect(() => {
      const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home, { shell: undefined }));
      expect(result.action).toBe("printed");
      if (result.action === "printed") {
        expect(result.message).toContain(INSTALL_DIR);
        expect(result.message).not.toContain("(add that to");
      }
    }).not.toThrow();
    // Nothing was created in home as a side effect.
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
  });

  test("installDir already on PATH: no-op, nothing written", () => {
    const home = scratchHome();
    const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home, { path: `/usr/bin:${INSTALL_DIR}:/bin` }));
    expect(result).toEqual({ action: "on-path" });
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  test("bash on macOS resolves to .bash_profile, never .bashrc", () => {
    const home = scratchHome();
    const result = ensurePathConfigured(
      INSTALL_DIR,
      zshEnv(home, { shell: "/bin/bash", platform: "darwin" }),
    );
    expect(result.action).toBe("appended");
    if (result.action === "appended") expect(result.rc).toBe(join(home, ".bash_profile"));
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });

  test("bash on linux resolves to .bashrc", () => {
    const home = scratchHome();
    const result = ensurePathConfigured(
      INSTALL_DIR,
      zshEnv(home, { shell: "/bin/bash", platform: "linux" }),
    );
    expect(result.action).toBe("appended");
    if (result.action === "appended") expect(result.rc).toBe(join(home, ".bashrc"));
  });

  test("fish gets fish_add_path under config/fish/config.fish", () => {
    const home = scratchHome();
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home, { shell: "/usr/local/bin/fish" }));
    expect(result.action).toBe("appended");
    if (result.action === "appended") {
      expect(result.rc).toBe(join(home, ".config", "fish", "config.fish"));
      expect(readFileSync(result.rc, "utf8")).toContain(`fish_add_path ${INSTALL_DIR}`);
    }
  });

  // --- regression tests for card 12's five blockers -----------------------------------------

  // B1: an unwritable rc must never throw — it must degrade to the printed fallback. Skipped
  // under root, which ignores file-mode permissions entirely and would make chmod a no-op.
  test.skipIf(process.getuid?.() === 0)(
    "B1: unwritable rc degrades to the printed fallback instead of throwing",
    () => {
      const home = scratchHome();
      const rc = join(home, ".zshrc");
      writeFileSync(rc, "# existing user content\n");
      chmodSync(rc, 0o444);

      let result: ReturnType<typeof ensurePathConfigured> | undefined;
      expect(() => {
        result = ensurePathConfigured(INSTALL_DIR, zshEnv(home));
      }).not.toThrow();

      expect(result?.action).toBe("printed");
      if (result?.action === "printed") {
        expect(result.message).toContain(INSTALL_DIR);
        expect(result.message).toContain("could not write to");
      }
      // The file was not touched — restore permissions to let afterAll clean it up.
      const before = readFileSync(rc, "utf8");
      chmodSync(rc, 0o644);
      expect(before).toBe("# existing user content\n");
    },
  );

  // B2: an empty (not just missing) HOME must never resolve to a relative rc path — that would
  // land a shell rc file wherever the process happened to be running from.
  test("B2: home ''  never produces a relative rc path; degrades to the printed fallback", () => {
    const result = ensurePathConfigured(INSTALL_DIR, zshEnv("", {}));
    expect(result.action).toBe("printed");
    // Nothing relative to the test's own cwd should ever be created.
    expect(existsSync(join(process.cwd(), ".zshrc"))).toBe(false);
  });

  // B4: the opt-out must fail closed — any non-empty value other than 0/false counts, not just "1".
  describe("B4: isNoModifyPath", () => {
    test.each([
      ["1", true],
      ["true", true],
      ["TRUE", true],
      ["yes", true],
      ["on", true],
      ["0", false],
      ["false", false],
      ["FALSE", false],
      ["", false],
      [undefined, false],
    ] as const)("isNoModifyPath(%p) === %p", (value, expected) => {
      expect(isNoModifyPath(value)).toBe(expected);
    });

    test("end to end: FLOCK_NO_MODIFY_PATH-style truthy value other than 1 still opts out", () => {
      const home = scratchHome();
      const rc = join(home, ".zshrc");
      writeFileSync(rc, "# untouched\n");

      const result = ensurePathConfigured(INSTALL_DIR, zshEnv(home, { noModifyPath: isNoModifyPath("true") }));

      expect(result.action).toBe("printed");
      expect(readFileSync(rc, "utf8")).toBe("# untouched\n");
    });
  });

  // B5: an unmarked pre-existing PATH line, in any realistic spelling, must not get a duplicate —
  // and must not ride on the onPath short-circuit (env.path deliberately excludes the install dir,
  // the cron/CI/agent-subprocess scenario the review flagged as real on the maintainer's machine).
  describe("B5: unmarked pre-existing .flock/bin line is recognized, not duplicated", () => {
    // A dedicated install dir under each test's own scratch home, so the $HOME/${HOME}/~
    // substitutions below line up with a real (sandboxed) directory rather than a fake one.
    const spellings: Array<[string, (dir: string, home: string) => string]> = [
      ["absolute path", (dir) => `export PATH="${dir}:$PATH"\n`],
      ["$HOME spelling", (dir, home) => `export PATH="$HOME${dir.slice(home.length)}:$PATH"\n`],
      ["${HOME} spelling", (dir, home) => `export PATH="\${HOME}${dir.slice(home.length)}:$PATH"\n`],
      ["~ spelling", (dir, home) => `export PATH="~${dir.slice(home.length)}:$PATH"\n`],
    ];

    test.each(spellings)("%s", (_label, buildLine) => {
      const home = scratchHome();
      const dir = join(home, ".flock", "bin");
      const rc = join(home, ".zshrc");
      const line = buildLine(dir, home);
      writeFileSync(rc, `# flock dev launcher (scripts/setup.sh --link)\n${line}`);

      const result = ensurePathConfigured(dir, {
        home,
        shell: "/bin/zsh",
        path: "/usr/bin:/bin", // deliberately does not contain dir
        platform: "darwin",
        noModifyPath: false,
      });

      expect(result).toEqual({ action: "already-on-path-unmarked", rc });
      // Append-only: the file must be byte-identical, not just "still contains" the line.
      expect(readFileSync(rc, "utf8")).toBe(`# flock dev launcher (scripts/setup.sh --link)\n${line}`);
    });

    test("still recognizes it when the dir actually is on PATH (the common case)", () => {
      const home = scratchHome();
      const dir = join(home, ".flock", "bin");
      const rc = join(home, ".zshrc");
      writeFileSync(rc, `export PATH="${dir}:$PATH"\n`);

      const result = ensurePathConfigured(dir, {
        home,
        shell: "/bin/zsh",
        path: `/usr/bin:${dir}`,
        platform: "darwin",
        noModifyPath: false,
      });

      expect(result).toEqual({ action: "on-path" });
    });
  });
});
