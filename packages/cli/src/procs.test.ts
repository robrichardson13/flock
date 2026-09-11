import { describe, expect, test } from "bun:test";
import { findStrays, isAlive, listProcesses, parsePs, strayLabel, terminate, type ProcRow } from "./procs.ts";

const ROOT = "/Users/r/repos/flock";
const row = (pid: number, command: string, ppid = 1): ProcRow => ({ pid, ppid, command });

describe("parsePs", () => {
  test("reads pid, ppid and the full command, padding and all", () => {
    const text = "    1     0 /sbin/launchd\n 3344     1 node /x/vite --port 5238 --strictPort\n\ngarbage line\n";
    expect(parsePs(text)).toEqual([row(1, "/sbin/launchd", 0), row(3344, "node /x/vite --port 5238 --strictPort")]);
  });
});

describe("listProcesses", () => {
  test("sees this very process, with its real parent", () => {
    const me = listProcesses().find((r) => r.pid === process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.command).toContain("bun");
  });
});

describe("findStrays", () => {
  const vite = `node ${ROOT}/packages/web/node_modules/.bin/vite --port 5238 --strictPort --host 0.0.0.0`;
  const api = `/opt/homebrew/bin/bun --watch ${ROOT}/packages/cli/src/main.ts serve --port 4838 --host 0.0.0.0`;

  test("an orphaned vite and API of this checkout are strays, with their ports", () => {
    const strays = findStrays([row(3344, vite), row(3345, api)], ROOT, new Set());
    expect(strays).toEqual([
      { pid: 3344, kind: "web", port: 5238 },
      { pid: 3345, kind: "api", port: 4838 },
    ]);
    expect(strays.map(strayLabel)).toEqual(["pid 3344 (web :5238)", "pid 3345 (api :4838)"]);
  });

  test("a vite hoisted to the checkout's root node_modules still counts", () => {
    expect(findStrays([row(7, `node ${ROOT}/node_modules/.bin/vite --port 5173`)], ROOT, new Set())).toHaveLength(1);
  });

  test("a pid a live runfile owns is a running daemon, not a stray", () => {
    expect(findStrays([row(3344, vite), row(3345, api)], ROOT, new Set([3344, 3345]))).toEqual([]);
  });

  test("anything with a live parent is someone's hand-run process, left alone", () => {
    expect(findStrays([row(3344, vite, 812), row(3345, api, 812)], ROOT, new Set())).toEqual([]);
  });

  test("another checkout never matches, even one whose path contains this root", () => {
    const rows = [
      row(1, vite.replace(ROOT, "/Users/r/repos/flock2")),
      row(2, api.replace(ROOT, "/Users/r/.nib/repos/flock/feature")),
      row(3, vite.replace(ROOT, `/x${ROOT}`)),
    ];
    expect(findStrays(rows, ROOT, new Set())).toEqual([]);
  });

  test("other commands under the checkout are not dev children", () => {
    const rows = [row(1, `bun ${ROOT}/packages/cli/src/main.ts up`), row(2, `bun test ${ROOT}/packages/cli`), row(3, `vim ${ROOT}/packages/web/vite.config.ts`)];
    expect(findStrays(rows, ROOT, new Set())).toEqual([]);
  });

  test("regex metacharacters in the root are literal", () => {
    const root = "/tmp/a+b (1)";
    expect(findStrays([row(9, `node ${root}/packages/web/node_modules/.bin/vite --port 5200`)], root, new Set())).toHaveLength(1);
    expect(findStrays([row(9, `node /tmp/aab (1)/packages/web/node_modules/.bin/vite`)], root, new Set())).toEqual([]);
  });
});

describe("terminate", () => {
  test("stops a live process and tolerates one that is already gone", async () => {
    const proc = Bun.spawn(["sleep", "30"]);
    expect(isAlive(proc.pid)).toBe(true);
    await terminate([proc.pid, 0x7ffffff], 2_000);
    await proc.exited;
    expect(isAlive(proc.pid)).toBe(false);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const proc = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30 & wait"]);
    await Bun.sleep(100);
    const started = Date.now();
    await terminate([proc.pid], 300);
    await proc.exited;
    expect(proc.signalCode).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
