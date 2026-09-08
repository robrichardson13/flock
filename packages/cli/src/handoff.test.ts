import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffMarkdown } from "./handoff.ts";

const CLI = new URL("./main.ts", import.meta.url).pathname;

describe("handoffMarkdown", () => {
  test("points agents at the formatting help topic", () => {
    const text = handoffMarkdown({ board: "b", project: "/tmp/p", actor: "scout", model: "sonnet", dbPath: "/tmp/db" });
    expect(text).toContain("flock help formatting");
  });
});

describe("flock help formatting", () => {
  test("prints something other than the main help", async () => {
    const main = Bun.spawnSync(["bun", CLI, "help"], { stdout: "pipe", stderr: "pipe" });
    const formatting = Bun.spawnSync(["bun", CLI, "help", "formatting"], { stdout: "pipe", stderr: "pipe" });
    const mainOut = main.stdout.toString();
    const formattingOut = formatting.stdout.toString();
    expect(formattingOut).not.toBe(mainOut);
    expect(formattingOut).toContain("message formatting");
  });
});

describe("flock handoff --model", () => {
  test("running handoff with --model persists the model on the actor", () => {
    const dir = mkdtempSync(join(tmpdir(), "flock-handoff-test-"));
    const dbPath = join(dir, "flock.db");
    const env = { ...process.env, FLOCK_DB: dbPath };
    try {
      Bun.spawnSync(["bun", CLI, "init", "--dir", dir], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      const handoff = Bun.spawnSync(["bun", CLI, "handoff", "--as", "fixer", "--model", "sonnet"], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(handoff.exitCode).toBe(0);
      const actors = Bun.spawnSync(["bun", CLI, "actors", "--json"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      const list = JSON.parse(actors.stdout.toString());
      const fixer = list.find((a: { name: string }) => a.name === "fixer");
      expect(fixer?.model).toBe("sonnet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
