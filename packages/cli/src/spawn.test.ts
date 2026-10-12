import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "./builtin-launcher.ts";
import { harnessFor, parseLaunchResult } from "./launcher.ts";
import { Flock, type Actor } from "@flock/core";
import { deliverInbox, isOffDuty, QUIET_MS, shouldRetire } from "./supervise.ts";
import { isPushed, workerPrompt } from "./spawn.ts";

const CLI = new URL("./main.ts", import.meta.url).pathname;

describe("harnessFor", () => {
  test("infers the harness from the model, and --harness wins", () => {
    expect(harnessFor("sonnet")).toBe("claude-code");
    expect(harnessFor("gpt-6.1-sol")).toBe("codex");
    expect(harnessFor("o4-mini")).toBe("codex");
    expect(harnessFor("opencode:anthropic/claude-sonnet")).toBe("opencode");
    expect(harnessFor("sonnet", "codex")).toBe("codex");
    expect(() => harnessFor("sonnet", "cursor")).toThrow("Unknown harness");
  });
});

describe("claudeArgs", () => {
  test("bypasses permissions by default; config swaps in a mode and an allow-list", () => {
    const base = { bin: "claude", sessionId: "s1", model: "sonnet", effort: null };
    expect(claudeArgs({ ...base, harness: {} })).toContain("bypassPermissions");
    const strict = claudeArgs({ ...base, effort: "high", harness: { permissionMode: "acceptEdits", allowedTools: ["Bash(flock:*)"] } });
    expect(strict.slice(strict.indexOf("--permission-mode"), strict.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(strict.slice(-4)).toEqual(["--effort", "high", "--allowedTools", "Bash(flock:*)"]);
    expect(strict.slice(strict.indexOf("--session-id"), strict.indexOf("--session-id") + 2)).toEqual(["--session-id", "s1"]);
  });
});

describe("worker lifetime", () => {
  test("a worker is off duty once its card closes, or once it gave back a card it had claimed", () => {
    expect(isOffDuty({ status: "todo", assignee: null }, "scout", false)).toBe(false);
    expect(isOffDuty({ status: "doing", assignee: "scout" }, "scout", true)).toBe(false);
    expect(isOffDuty({ status: "todo", assignee: null }, "scout", true)).toBe(true);
    expect(isOffDuty({ status: "done", assignee: "scout" }, "scout", true)).toBe(true);
  });

  test("it retires only after the inbox has been quiet for the whole window since going off duty", () => {
    expect(shouldRetire(null, 0, QUIET_MS * 10)).toBe(false);
    expect(shouldRetire(0, 0, QUIET_MS - 1)).toBe(false);
    expect(shouldRetire(0, 0, QUIET_MS)).toBe(true);
    expect(shouldRetire(0, QUIET_MS, QUIET_MS + 1)).toBe(false);
  });
});

test("a launcher reply keeps only well-typed fields and falls back to the requested cwd", () => {
  expect(parseLaunchResult({ sessionKey: "codex:t1", pid: "12", openUrl: "", cwd: "/w" }, "/p")).toEqual({ sessionKey: "codex:t1", pid: null, openUrl: null, cwd: "/w" });
  expect(() => parseLaunchResult("nope", "/p")).toThrow("not a JSON object");
});

test("spawn hands the request to an external launcher, records the agent, and links its worktree", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flock-spawn-test-")));
  const project = join(dir, "app");
  const launcher = join(dir, "launcher.sh");
  writeFileSync(launcher, `#!/bin/sh\ncat > "${dir}/request.json"\necho '{"sessionKey":"claude-code:abc","pid":null,"openUrl":"x-ide://tab/1","cwd":"${dir}/app-wt"}'\n`);
  chmodSync(launcher, 0o755);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ launcher }));
  const env = { ...process.env, FLOCK_DB: join(dir, "flock.db"), FLOCK_HOME: dir, FLOCK_NO_UPDATE: "1" };
  const flock = (...args: string[]) => Bun.spawnSync(["bun", CLI, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  try {
    flock("board", "new", "App", "--project", project);
    flock("card", "new", "app", "Parser", "--as", "rob");
    const spawned = flock("spawn", "app", "1", "--as", "scout", "--model", "sonnet", "--worktree", "--json");
    expect(spawned.stderr.toString()).toBe("");
    const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
    expect([request.op, request.card, request.name, request.harness, request.worktree, request.env.FLOCK_ACTOR]).toEqual(["launch", 1, "scout", "claude-code", true, "scout"]);
    expect(request.prompt).toContain("flock inbox app --as scout --follow --json");
    const team = JSON.parse(flock("team", "app", "--json").stdout.toString());
    expect(team.map((a: { name: string; openUrl: string; cwd: string }) => [a.name, a.openUrl, a.cwd])).toEqual([["scout", "x-ide://tab/1", `${dir}/app-wt`]]);
    mkdirSync(join(dir, "app-wt"));
    const fromWorktree = Bun.spawnSync(["bun", CLI, "board", "show", "--json"], { cwd: join(dir, "app-wt"), env, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(fromWorktree.stdout.toString()).board.slug).toBe("app");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deliverInbox", () => {
  test("writes unread inbox into the session as one user turn, then nothing until more arrives", () => {
    const f = new Flock(":memory:");
    const rob: Actor = { name: "rob", kind: "human" };
    const board = f.createBoard(rob, { title: "Team", project: "/repos/app" });
    const card = f.createCard(rob, board.slug, { title: "Parser" });
    f.registerAgent({ name: "conductor", kind: "agent" }, board.slug, {
      name: "scout", cardNum: card.num, harness: "claude-code", model: "opus", effort: null,
      sessionKey: "claude-code:1", openUrl: null, cwd: "/repos/app", pid: 1, launcher: "builtin",
    });
    f.say(rob, board.slug, "@scout use the new tokens");
    f.say(rob, board.slug, "unrelated chatter");
    const lines: string[] = [];
    const spec = { boardId: board.id, name: "scout" };

    expect(deliverInbox(f, spec, (l) => lines.push(l))).toBe(1);
    expect(deliverInbox(f, spec, (l) => lines.push(l))).toBe(0);
    expect(lines).toHaveLength(1);
    const turn = JSON.parse(lines[0]!);
    expect(turn.type).toBe("user");
    expect(turn.message.content).toContain("@scout use the new tokens");
    expect(turn.message.content).not.toContain("unrelated chatter");
    expect(f.agents(board.slug)[0]!.unread).toBe(0);
  });
});

describe("workerPrompt", () => {
  test("only a built-in Claude Code worker is pushed its inbox; everyone else re-arms a Monitor", () => {
    expect(isPushed("builtin", "claude-code")).toBe(true);
    expect(isPushed("flock-nib-launch", "claude-code")).toBe(false);
    expect(isPushed("builtin", "codex")).toBe(false);
    const card = { num: 4, title: "Parser" };
    expect(workerPrompt("b", card, "scout", { pushed: true })).toContain("Do not arm a Monitor");
    expect(workerPrompt("b", card, "scout", { pushed: false })).toContain("every time it expires, re-arm it");
  });
});
