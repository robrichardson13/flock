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

  test("mentions held cards: what they are, and that force never overrides a hold", () => {
    const text = handoffMarkdown({ board: "b", project: "/tmp/p", actor: "scout", model: "sonnet", dbPath: "/tmp/db" });
    expect(text).toContain("on hold");
    expect(text).toContain("never past a hold");
    expect(text).toContain("flock unhold");
  });

  test("the filing section is the first heading, ahead of the working-agent sections", () => {
    const text = handoffMarkdown({ board: "b", project: "/tmp/p", actor: "scout", model: "sonnet", dbPath: "/tmp/db" });
    const headings = [...text.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings[0]).toBe("## Just filing a card?");
    expect(text.indexOf("## Just filing a card?")).toBeLessThan(text.indexOf("## Orient"));
    expect(text).toContain('flock card new [BOARD] "<title>" --body "<markdown>" --as <your-name>');
    expect(text).toContain("No `claim`/`done` cycle needed");
  });

  test("a normally-attributed actor gets the plain identity line, not the defaulted warning", () => {
    const text = handoffMarkdown({ board: "b", project: "/tmp/p", actor: "scout", model: "sonnet", dbPath: "/tmp/db" });
    expect(text).toContain("You are **scout**, an agent on a shared Flock board.");
    expect(text).not.toContain("ran as **scout**, the OS user");
  });

  test("a defaulted actor is warned it ran as the OS user and told to pick a name", () => {
    const text = handoffMarkdown({ board: "b", project: "/tmp/p", actor: "robrichardson", model: "sonnet", dbPath: "/tmp/db", defaulted: true });
    expect(text).toContain("ran as **robrichardson**, the OS user");
    expect(text).toContain("Pick a name for yourself");
    expect(text).not.toContain("You are **robrichardson**, an agent on a shared Flock board.");
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
