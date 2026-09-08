import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHook,
  HookError,
  mergeBoardInput,
  normalizeFields,
  parseHookOutput,
  runHook,
  type Actor,
} from "../src/index.ts";

const actor: Actor = { name: "ada", kind: "human" };

/** A fresh hooks dir for one test, with a fixture script written and made executable. */
function hooksFixture(name: string, script: string, mode = 0o700): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, mode);
  return { dir, path };
}

describe("findHook", () => {
  test("no hook installed returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
    expect(findHook("board-create", { hooksDir: dir })).toBeNull();
  });

  test("hook present but world-writable is refused", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n", 0o707);
    expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
    try {
      findHook("board-create", { hooksDir: dir });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HookError);
      expect((e as HookError).code).toBe("hook_unsafe");
    }
  });

  test("hook present but not executable is refused", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n", 0o600);
    expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
  });

  test("safe hook resolves to its path", () => {
    const { dir, path } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n");
    expect(findHook("board-create", { hooksDir: dir })).toEqual({ path });
  });

  test("FLOCK_HOOKS_DIR overrides the default directory", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n");
    const prev = process.env.FLOCK_HOOKS_DIR;
    process.env.FLOCK_HOOKS_DIR = dir;
    try {
      expect(findHook("board-create")).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FLOCK_HOOKS_DIR;
      else process.env.FLOCK_HOOKS_DIR = prev;
    }
  });
});

describe("runHook", () => {
  test("describe returns fields", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
echo '{"title":"New workspace","submit":"Create","fields":[{"name":"repo","label":"Repository","type":"select","options":["flock","other"],"required":true}]}'
`,
    );
    const result = await runHook(path, "describe", { event: "board-create", actor });
    expect(result.ok).toBe(true);
    const parsed = normalizeFields(parseHookOutput(result.stdout));
    expect(parsed.title).toBe("New workspace");
    expect(parsed.submit).toBe("Create");
    expect(parsed.fields).toEqual([
      { name: "repo", label: "Repository", type: "select", required: true, options: [{ value: "flock", label: "flock" }, { value: "other", label: "other" }] },
    ]);
  });

  test("describe failing yields empty fields", async () => {
    const { path } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 1\n");
    const result = await runHook(path, "describe", { event: "board-create", actor });
    expect(result.ok).toBe(false);
    // A caller degrades a failed describe to the plain schema rather than propagating the exit code.
    expect(normalizeFields({}).fields).toEqual([]);
  });

  test("create returns a project dir", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-project-"));
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"project":"%s","title":"login-flow"}\\n' "${projectDir}"
`,
    );
    const result = await runHook(path, "create", { event: "board-create", actor, title: "Fix the login flow" });
    expect(result.ok).toBe(true);
    const output = parseHookOutput(result.stdout);
    expect(output.project).toBe(realpathSync(projectDir));
    const merged = mergeBoardInput({ title: "Fix the login flow" }, output);
    expect(merged).toEqual({ title: "login-flow", project: realpathSync(projectDir) });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("create returns nothing yields an empty merge", async () => {
    const { path } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n");
    const result = await runHook(path, "create", { event: "board-create", actor, title: "Plain board" });
    expect(result.ok).toBe(true);
    const output = parseHookOutput(result.stdout);
    expect(output).toEqual({});
    const merged = mergeBoardInput({ title: "Plain board" }, output);
    expect(merged).toEqual({ title: "Plain board" });
  });

  test("non-zero exit is reported, not thrown", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
echo "boom" >&2
exit 7
`,
    );
    const result = await runHook(path, "create", { event: "board-create", actor });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  test("a hook that outruns its timeout is killed and reported", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
sleep 5
echo '{"project":"/nope"}'
`,
    );
    const result = await runHook(path, "create", { event: "board-create", actor }, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  }, 10_000);

  test("FLOCK_HOOK_TIMEOUT_MS env override is honored", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
sleep 5
`,
    );
    const prev = process.env.FLOCK_HOOK_TIMEOUT_MS;
    process.env.FLOCK_HOOK_TIMEOUT_MS = "200";
    try {
      const result = await runHook(path, "create", { event: "board-create", actor });
      expect(result.timedOut).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FLOCK_HOOK_TIMEOUT_MS;
      else process.env.FLOCK_HOOK_TIMEOUT_MS = prev;
    }
  }, 10_000);

  test("env mirror receives FLOCK_INPUT_* for declared inputs", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
jq -nc \\
  --arg event "$FLOCK_EVENT" \\
  --arg version "$FLOCK_HOOK_VERSION" \\
  --arg title "$FLOCK_TITLE" \\
  --arg actor "$FLOCK_ACTOR" \\
  --arg actorKind "$FLOCK_ACTOR_KIND" \\
  --arg db "$FLOCK_DB" \\
  --arg repo "\${FLOCK_INPUT_REPO:-}" \\
  --arg oddKey "\${FLOCK_INPUT_ODD_KEY_NAME_:-}" \\
  --arg seed "\${FLOCK_INPUT_SEEDNOW:-}" \\
  --arg skip "\${FLOCK_INPUT_SKIPTESTS-set-but-empty}" \\
  '{event:$event,version:$version,title:$title,actor:$actor,actorKind:$actorKind,db:$db,repo:$repo,oddKey:$oddKey,seed:$seed,skip:$skip}'
`,
    );
    const result = await runHook(path, "create", {
      event: "board-create",
      actor,
      title: "Fix the login flow",
      dbPath: "/Users/ada/.flock/flock.db",
      inputs: { repo: "flock", "odd key name!": "value", seedNow: true, skipTests: false },
    });
    expect(result.ok).toBe(true);
    const json = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(json).toEqual({
      event: "board-create",
      version: "1",
      title: "Fix the login flow",
      actor: "ada",
      actorKind: "human",
      db: "/Users/ada/.flock/flock.db",
      repo: "flock",
      oddKey: "value",
      seed: "1",
      skip: "",
    });
  });

  test("last-non-empty-line parsing tolerates chatty stdout", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
echo "starting up"
echo "doing a thing..."
echo ""
echo '{"title":"chatty result"}'
`,
    );
    const result = await runHook(path, "create", { event: "board-create", actor });
    expect(result.ok).toBe(true);
    const output = parseHookOutput(result.stdout);
    expect(output).toEqual({ title: "chatty result" });
  });
});

describe("parseHookOutput", () => {
  test("no output at all means an empty object", () => {
    expect(parseHookOutput("")).toEqual({});
    expect(parseHookOutput("\n\n  \n")).toEqual({});
  });

  test("invalid stdout JSON is rejected", () => {
    expect(() => parseHookOutput("not json at all")).toThrow(HookError);
    try {
      parseHookOutput("not json at all");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as HookError).code).toBe("hook_output_invalid");
    }
  });

  test("a relative project path is rejected", () => {
    expect(() => parseHookOutput('{"project":"relative/path"}')).toThrow(HookError);
  });

  test("a project path that does not exist is rejected", () => {
    expect(() => parseHookOutput('{"project":"/definitely/does/not/exist/anywhere"}')).toThrow(HookError);
  });

  test("a project that is absolute and exists is accepted, canonicalized", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-project-"));
    const real = realpathSync(dir);
    // Trailing slashes, "." segments and symlinked ancestors all collapse: the board key is one
    // per directory, and the CLI keys off an already-resolved process.cwd().
    expect(parseHookOutput(JSON.stringify({ project: dir })).project).toBe(real);
    expect(parseHookOutput(JSON.stringify({ project: dir + "/" })).project).toBe(real);
    expect(parseHookOutput(JSON.stringify({ project: dir + "/./" })).project).toBe(real);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a project that is a file, not a directory, is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-project-"));
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    expect(() => parseHookOutput(JSON.stringify({ project: file }))).toThrow(HookError);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a project symlinked to a real directory resolves to the target", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-project-"));
    const target = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    expect(parseHookOutput(JSON.stringify({ project: link })).project).toBe(realpathSync(target));
    rmSync(dir, { recursive: true, force: true });
  });

  test("title, slug and body must be strings of sane length", () => {
    expect(() => parseHookOutput(JSON.stringify({ title: 42 }))).toThrow(HookError);
    expect(() => parseHookOutput(JSON.stringify({ slug: { nested: true } }))).toThrow(HookError);
    expect(() => parseHookOutput(JSON.stringify({ title: "x".repeat(501) }))).toThrow(HookError);
    expect(() => parseHookOutput(JSON.stringify({ body: "x".repeat(100_001) }))).toThrow(HookError);
    expect(() => parseHookOutput(JSON.stringify({ title: "ok\u0000nope" }))).toThrow(HookError);
    try {
      parseHookOutput(JSON.stringify({ title: 42 }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as HookError).code).toBe("hook_output_invalid");
    }
    expect(parseHookOutput(JSON.stringify({ title: "x".repeat(500), body: "y" }))).toEqual({ title: "x".repeat(500), body: "y" });
  });

  test("a project that is not a string is rejected", () => {
    expect(() => parseHookOutput(JSON.stringify({ project: 7 }))).toThrow(HookError);
  });
});

describe("normalizeFields", () => {
  test("drops malformed fields but keeps well-formed ones", () => {
    const result = normalizeFields({
      title: "New workspace",
      fields: [
        { name: "repo", label: "Repository", type: "select", options: ["a", "b"] },
        { name: "no-label", type: "text" },
        { label: "no-name", type: "text" },
        { name: "bad-type", label: "Bad", type: "date" },
        "not even an object",
        { name: "branch", label: "Branch", type: "text", required: true, placeholder: "login-flow", default: "main" },
        { name: "seed", label: "Seed?", type: "checkbox", default: true },
      ],
    });
    expect(result.title).toBe("New workspace");
    expect(result.fields.map((f) => f.name)).toEqual(["repo", "branch", "seed"]);
    expect(result.fields[1]).toEqual({ name: "branch", label: "Branch", type: "text", required: true, placeholder: "login-flow", default: "main" });
  });

  test("non-object input normalizes to empty fields", () => {
    expect(normalizeFields(null)).toEqual({ fields: [] });
    expect(normalizeFields("nope")).toEqual({ fields: [] });
    expect(normalizeFields([1, 2, 3])).toEqual({ fields: [] });
  });

  test("options may be plain strings or {value,label} objects", () => {
    const result = normalizeFields({
      fields: [{ name: "group", label: "Group", type: "select", options: ["flock", { value: "x", label: "Team X" }, { value: "y" }] }],
    });
    expect(result.fields[0].options).toEqual([
      { value: "flock", label: "flock" },
      { value: "x", label: "Team X" },
      { value: "y", label: "y" },
    ]);
  });
});

describe("mergeBoardInput", () => {
  test("hook output wins over the form", () => {
    const merged = mergeBoardInput({ title: "form title", project: "/form/project" }, { title: "hook title", body: "hook body" });
    expect(merged).toEqual({ title: "hook title", project: "/form/project", body: "hook body" });
  });

  test("unknown keys on hook output are ignored", () => {
    const merged = mergeBoardInput({ title: "form title" }, { title: "hook title", nonsense: 123, another: { nested: true } });
    expect(merged).toEqual({ title: "hook title" });
  });

  test("empty hook output leaves the form untouched", () => {
    const form = { title: "form title", body: "form body", project: "/form/project" };
    expect(mergeBoardInput(form, {})).toEqual(form);
  });
});

describe("findHook safety", () => {
  test("an event name that is not a plain file name is refused, never joined into a path", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n");
    for (const bad of ["../../../bin/ls", "board-create/../../ls", "/bin/ls", "", "Board-Create", "a b"]) {
      expect(() => findHook(bad, { hooksDir: dir })).toThrow(HookError);
    }
    try {
      findHook("../../../bin/ls", { hooksDir: dir });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as HookError).code).toBe("hook_unsafe");
    }
  });

  test("a world-writable hooks directory is refused even when the file itself is tight", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n", 0o700);
    chmodSync(dir, 0o777);
    try {
      findHook("board-create", { hooksDir: dir });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HookError);
      expect((e as HookError).code).toBe("hook_unsafe");
      expect((e as HookError).message).toContain("hooks directory");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a group-writable hooks directory is refused", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n", 0o700);
    chmodSync(dir, 0o770);
    try {
      expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a group-writable hook file is refused", () => {
    const { dir } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n", 0o770);
    expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
  });

  test("a directory at the hook path is not a hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
    mkdirSync(join(dir, "board-create"));
    expect(findHook("board-create", { hooksDir: dir })).toBeNull();
  });

  test("a dangling symlink is not a hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
    symlinkSync(join(dir, "nowhere"), join(dir, "board-create"));
    expect(findHook("board-create", { hooksDir: dir })).toBeNull();
  });

  test("a symlink to a safe executable resolves; the target's own bits are what get checked", () => {
    const target = mkdtempSync(join(tmpdir(), "flock-target-"));
    const script = join(target, "my-hook");
    writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(script, 0o700);
    const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
    const linkPath = join(dir, "board-create");
    symlinkSync(script, linkPath);
    expect(findHook("board-create", { hooksDir: dir })).toEqual({ path: linkPath });

    // The symlink is safe but its target is world-writable: the thing that actually runs decides.
    chmodSync(script, 0o707);
    expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);

    // ...and so does the directory the target lives in, which is as swappable as ours.
    chmodSync(script, 0o700);
    chmodSync(target, 0o777);
    try {
      expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
    } finally {
      chmodSync(target, 0o700);
    }
  });

  test("a symlink target that is not executable is refused", () => {
    const target = mkdtempSync(join(tmpdir(), "flock-target-"));
    const script = join(target, "my-hook");
    writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(script, 0o600);
    const dir = mkdtempSync(join(tmpdir(), "flock-hooks-"));
    symlinkSync(script, join(dir, "board-create"));
    expect(() => findHook("board-create", { hooksDir: dir })).toThrow(HookError);
  });

  test("a missing hooks directory is 'not installed', not an error", () => {
    expect(findHook("board-create", { hooksDir: join(tmpdir(), "flock-hooks-does-not-exist-xyz") })).toBeNull();
  });
});

describe("runHook hardening", () => {
  /** Prints the environment the hook actually saw, as JSON, so a test can assert on it. */
  const ENV_PROBE = `#!/usr/bin/env bash
set -euo pipefail
jq -nc \\
  --arg actor "\${FLOCK_ACTOR-unset}" \\
  --arg db "\${FLOCK_DB-unset}" \\
  --arg title "\${FLOCK_TITLE-unset}" \\
  --arg event "\${FLOCK_EVENT-unset}" \\
  --arg stale "\${FLOCK_INPUT_STALE-unset}" \\
  '{actor:$actor,db:$db,title:$title,event:$event,stale:$stale}'
`;

  test("the parent process's FLOCK_* environment never leaks into a hook", async () => {
    const { path } = hooksFixture("board-create", ENV_PROBE);
    const saved = { ...process.env };
    process.env.FLOCK_ACTOR = "server-identity";
    process.env.FLOCK_DB = "/server/flock.db";
    process.env.FLOCK_TITLE = "left over";
    process.env.FLOCK_INPUT_STALE = "left over too";
    try {
      const result = await runHook(path, "create", { event: "board-create" });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        actor: "unset",
        db: "unset",
        title: "unset",
        event: "board-create",
        stale: "unset",
      });
    } finally {
      for (const k of ["FLOCK_ACTOR", "FLOCK_DB", "FLOCK_TITLE", "FLOCK_INPUT_STALE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test("an input named like a control variable cannot shadow one", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
jq -nc --arg event "$FLOCK_EVENT" --arg title "\${FLOCK_TITLE-unset}" --arg db "\${FLOCK_DB-unset}" \\
  --arg iEvent "\${FLOCK_INPUT_EVENT-unset}" --arg iTitle "\${FLOCK_INPUT_TITLE-unset}" --arg iDb "\${FLOCK_INPUT_DB-unset}" \\
  '{event:$event,title:$title,db:$db,iEvent:$iEvent,iTitle:$iTitle,iDb:$iDb}'
`,
    );
    const result = await runHook(path, "create", {
      event: "board-create",
      title: "real title",
      dbPath: "/real/flock.db",
      inputs: { event: "pwned", title: "pwned", db: "pwned", hook_version: "pwned" },
    });
    expect(JSON.parse(result.stdout.trim())).toEqual({
      event: "board-create",
      title: "real title",
      db: "/real/flock.db",
      iEvent: "pwned",
      iTitle: "pwned",
      iDb: "pwned",
    });
  });

  test("object and array input values stay out of the env but remain in stdin JSON", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
payload=$(cat)
jq -nc --arg obj "\${FLOCK_INPUT_OBJ-unset}" --arg blank "\${FLOCK_INPUT_______-unset}" --argjson p "$payload" \\
  '{obj:$obj,blank:$blank,fromStdin:($p.inputs.obj.a)}'
`,
    );
    const inputs = { obj: { a: 1 }, "!!!": "no key to hang this on" } as unknown as Record<string, string | boolean | number>;
    const result = await runHook(path, "create", { event: "board-create", inputs });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ obj: "unset", blank: "unset", fromStdin: 1 });
  });

  test("an enormous input value is dropped from the env rather than blowing up the spawn", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
jq -nc --arg big "\${FLOCK_INPUT_BIG-unset}" --arg small "\${FLOCK_INPUT_SMALL-unset}" '{big:$big,small:$small}'
`,
    );
    const result = await runHook(path, "create", { event: "board-create", inputs: { big: "x".repeat(200_000), small: "ok" } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ big: "unset", small: "ok" });
  });

  test("a hook that exits without reading a large stdin does not crash the caller", async () => {
    const { path } = hooksFixture("board-create", "#!/usr/bin/env bash\nexit 0\n");
    const result = await runHook(path, "create", { event: "board-create", inputs: { blob: "y".repeat(2_000_000) } });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("gigabyte-scale stdout is tail-capped and the last line still parses", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
for i in $(seq 1 20000); do printf 'padding line %s ....................................................\\n' "$i"; done
printf '%s\\n' '{"title":"survived"}'
`,
    );
    const result = await runHook(path, "create", { event: "board-create" }, { timeoutMs: 20_000 });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(parseHookOutput(result.stdout)).toEqual({ title: "survived" });
  }, 30_000);

  test("a mountain of stderr is capped to the last 20 lines", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
for i in $(seq 1 5000); do echo "noise $i" >&2; done
echo "the real error" >&2
exit 3
`,
    );
    const result = await runHook(path, "create", { event: "board-create" }, { timeoutMs: 20_000 });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("the real error");
    expect(result.stderr.split("\n").length).toBeLessThanOrEqual(20);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
  }, 30_000);

  test("a hook whose background child holds the pipes open still returns promptly", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
set -euo pipefail
sleep 30 &
printf '%s\\n' '{"title":"done anyway"}'
exit 0
`,
    );
    const started = Date.now();
    const result = await runHook(path, "create", { event: "board-create" }, { timeoutMs: 20_000 });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(parseHookOutput(result.stdout)).toEqual({ title: "done anyway" });
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  test("a non-numeric FLOCK_HOOK_TIMEOUT_MS is ignored, not treated as zero", async () => {
    const { path } = hooksFixture("board-create", "#!/usr/bin/env bash\nsleep 0.3\nexit 0\n");
    const prev = process.env.FLOCK_HOOK_TIMEOUT_MS;
    for (const bad of ["not-a-number", "0", "-1", ""]) {
      process.env.FLOCK_HOOK_TIMEOUT_MS = bad;
      try {
        const result = await runHook(path, "create", { event: "board-create" });
        expect(result.timedOut).toBe(false);
        expect(result.ok).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.FLOCK_HOOK_TIMEOUT_MS;
        else process.env.FLOCK_HOOK_TIMEOUT_MS = prev;
      }
    }
  }, 20_000);

  test("an explicit timeoutMs beats the env override", async () => {
    const { path } = hooksFixture("board-create", "#!/usr/bin/env bash\nsleep 5\n");
    const prev = process.env.FLOCK_HOOK_TIMEOUT_MS;
    process.env.FLOCK_HOOK_TIMEOUT_MS = "60000";
    try {
      const result = await runHook(path, "create", { event: "board-create" }, { timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FLOCK_HOOK_TIMEOUT_MS;
      else process.env.FLOCK_HOOK_TIMEOUT_MS = prev;
    }
  }, 10_000);

  test("a hook that ignores SIGTERM is SIGKILLed and the call still returns", async () => {
    const { path } = hooksFixture(
      "board-create",
      `#!/usr/bin/env bash
trap '' TERM
sleep 30
`,
    );
    const started = Date.now();
    const result = await runHook(path, "create", { event: "board-create" }, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe("normalizeFields hardening", () => {
  test("a field name with nothing to build FLOCK_INPUT_<KEY> from is dropped", () => {
    const result = normalizeFields({ fields: [{ name: "!!!", label: "Nope", type: "text" }, { name: "ok", label: "Ok", type: "text" }] });
    expect(result.fields.map((f) => f.name)).toEqual(["ok"]);
  });

  test("duplicate field names keep the first declaration", () => {
    const result = normalizeFields({
      fields: [{ name: "repo", label: "First", type: "text" }, { name: "repo", label: "Second", type: "text" }],
    });
    expect(result.fields).toEqual([{ name: "repo", label: "First", type: "text" }]);
  });

  test("field, option and string counts are bounded", () => {
    const fields = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, label: "L", type: "text" }));
    expect(normalizeFields({ fields }).fields.length).toBe(50);

    const options = Array.from({ length: 2000 }, (_, i) => `o${i}`);
    const one = normalizeFields({ fields: [{ name: "big", label: "Big", type: "select", options }] });
    expect(one.fields[0]!.options!.length).toBe(500);

    const long = normalizeFields({
      title: "t".repeat(5000),
      fields: [{ name: "x", label: "l".repeat(5000), type: "text", placeholder: "p".repeat(5000), default: "d".repeat(5000) }],
    });
    expect(long.title!.length).toBe(500);
    expect(long.fields[0]!.label.length).toBe(500);
    expect((long.fields[0]!.default as string).length).toBe(500);
  });
});
