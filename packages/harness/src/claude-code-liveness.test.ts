import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPidFileForSession, isAlive, procStartMatches } from "./claude-code-liveness.ts";

const FIXTURE_HOME = new URL("../fixtures/claude-code", import.meta.url).pathname;

describe("isAlive", () => {
  test("is true for this test's own process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("is false for a pid that almost certainly does not exist", () => {
    expect(isAlive(999999)).toBe(false);
  });
});

describe("findPidFileForSession", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "flock-harness-liveness-"));
    await cp(FIXTURE_HOME, home, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("finds the pid file naming a session id, among several", async () => {
    await writeFile(
      join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "11111111-1111-1111-1111-111111111111", status: "busy" }),
    );
    const found = await findPidFileForSession(home, "11111111-1111-1111-1111-111111111111");
    expect(found?.pid).toBe(process.pid);
    expect(found?.status).toBe("busy");
  });

  test("returns null for a session no pid file names", async () => {
    expect(await findPidFileForSession(home, "no-such-session")).toBeNull();
  });

  test("skips an unreadable/malformed pid file rather than throwing", async () => {
    await writeFile(join(home, "sessions", "junk.json"), "{not json");
    expect(await findPidFileForSession(home, "11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  test("returns null, never throws, when the sessions directory is missing", async () => {
    expect(await findPidFileForSession("/nonexistent/claude/home", "anything")).toBeNull();
  });
});

describe("procStartMatches", () => {
  test("returns null (not false) for a pid that does not exist, rather than claiming a mismatch", async () => {
    expect(await procStartMatches(999999, "Fri Sep 11 23:03:19 2026")).toBeNull();
  });

  test("matches this process's own procStart against ps, once converted to the file's UTC form", async () => {
    const proc = Bun.spawn(["ps", "-p", String(process.pid), "-o", "lstart="], { stdout: "pipe" });
    const local = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const utcAsctime = toAsctimeUtc(local);
    expect(await procStartMatches(process.pid, utcAsctime)).toBe(true);
  });

  test("returns false for a procStart that plainly does not match", async () => {
    expect(await procStartMatches(process.pid, "Mon Jan 1 00:00:00 2000")).toBe(false);
  });
});

/** Re-render a `ps -o lstart=` (local time) string as the same instant in UTC asctime form, the
 * shape `~/.claude/sessions/<pid>.json` stores `procStart` in. Test-only inverse of the parsing
 * `claude-code-liveness.ts` does, so this test does not depend on the machine's own timezone. */
function toAsctimeUtc(local: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(local.trim());
  if (!m) throw new Error(`unparsable ps lstart output: ${local}`);
  const [, mon, day, h, min, s, year] = m;
  const d = new Date(Number(year), months.indexOf(mon), Number(day), Number(h), Number(min), Number(s));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
