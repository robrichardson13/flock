import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./main.ts", import.meta.url).pathname;

test("say --to lands in the recipient's inbox and nobody else's", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flock-inbox-test-")));
  const env = { ...process.env, FLOCK_DB: join(dir, "flock.db"), FLOCK_ACTOR_KIND: "agent" };
  const flock = (...args: string[]) => Bun.spawnSync(["bun", CLI, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  try {
    flock("init", "--dir", dir);
    expect(flock("say", "schema is in", "--to", "scout", "--as", "builder").exitCode).toBe(0);
    const scout = flock("inbox", "--as", "scout", "--json").stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
    expect(scout.map((e) => e.data.body)).toEqual(["@scout schema is in"]);
    expect(flock("inbox", "--as", "rob", "--json").stdout.toString().trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
