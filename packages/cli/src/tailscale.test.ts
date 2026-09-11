import { describe, expect, test } from "bun:test";
import {
  browserPort,
  envBool,
  establishTailscale,
  findTailscale,
  parseServeStatus,
  parseTailnetStatus,
  preflightTailscale,
  preserveRunningTailscale,
  proxyTarget,
  releaseTailscale,
  resolveTailscale,
  rootMount,
  tailscaleUrl,
  type RunResult,
  type Runner,
} from "./tailscale.ts";

/** Table-driven fake runner: never a real subprocess. Records every argv it was asked to run. */
function fake(table: Record<string, Partial<RunResult>>) {
  const calls: string[][] = [];
  const run: Runner = (cmd) => {
    calls.push(cmd);
    const key = cmd.slice(1).join(" "); // drop the binary path
    const hit = table[key];
    return { code: 0, stdout: "", stderr: "", ...(hit ?? { code: 1, stderr: "unexpected" }) };
  };
  return { run, calls };
}

const RUNNING_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "robs-macbook-pro.tailef3210.ts.net.", CapMap: { https: null, funnel: null } },
});
const NEEDS_LOGIN_STATUS = JSON.stringify({ BackendState: "NeedsLogin" });
const NO_HTTPS_STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "m.tail.ts.net.", CapMap: {} } });
const NO_CAPMAP_STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "m.tail.ts.net." } });
const EMPTY_SERVE_STATUS = "{}";
const ROOT_SERVE_STATUS = (proxy: string) => JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "m.tail.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } });
const MULTI_MOUNT_SERVE_STATUS = JSON.stringify({
  Web: { "m.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" }, "/other": { Proxy: "http://127.0.0.1:9999" } } } },
});

describe("resolveTailscale", () => {
  test("flag beats env beats config beats off", () => {
    expect(resolveTailscale(true, {}, {})).toBe(true);
    expect(resolveTailscale(false, { FLOCK_TAILSCALE: "1" }, { tailscale: true })).toBe(false);
    expect(resolveTailscale(undefined, { FLOCK_TAILSCALE: "1" }, { tailscale: false })).toBe(true);
    expect(resolveTailscale(undefined, { FLOCK_TAILSCALE: "0" }, { tailscale: true })).toBe(false);
    expect(resolveTailscale(undefined, {}, { tailscale: true })).toBe(true);
    expect(resolveTailscale(undefined, {}, {})).toBe(false);
  });

  test("FLOCK_TAILSCALE=0/false/no (any case) are off; empty is unset", () => {
    for (const v of ["0", "false", "FALSE", "no", "No"]) expect(resolveTailscale(undefined, { FLOCK_TAILSCALE: v }, { tailscale: true })).toBe(false);
    expect(resolveTailscale(undefined, { FLOCK_TAILSCALE: "" }, { tailscale: true })).toBe(true);
    expect(resolveTailscale(undefined, { FLOCK_TAILSCALE: "1" }, {})).toBe(true);
  });

  test("--no-tailscale beats a config default of true", () => {
    expect(resolveTailscale(false, {}, { tailscale: true })).toBe(false);
  });
});

describe("envBool", () => {
  test("undefined and empty are unset; 0/false/no are off; anything else is on", () => {
    expect(envBool(undefined)).toBeUndefined();
    expect(envBool("")).toBeUndefined();
    expect(envBool("0")).toBe(false);
    expect(envBool("false")).toBe(false);
    expect(envBool("No")).toBe(false);
    expect(envBool("1")).toBe(true);
    expect(envBool("yes")).toBe(true);
  });
});

describe("preserveRunningTailscale", () => {
  test("an explicit flag always wins", () => {
    expect(preserveRunningTailscale(true, {}, { tailscale: false })).toBe(true);
    expect(preserveRunningTailscale(false, {}, { tailscale: true })).toBe(false);
  });

  test("a set env var counts as explicit and steps aside from the running value", () => {
    expect(preserveRunningTailscale(undefined, { FLOCK_TAILSCALE: "1" }, { tailscale: false })).toBeUndefined();
  });

  test("an empty env var is not explicit", () => {
    expect(preserveRunningTailscale(undefined, { FLOCK_TAILSCALE: "" }, { tailscale: true })).toBe(true);
  });

  test("no flag, no env: the running daemon's own choice wins", () => {
    expect(preserveRunningTailscale(undefined, {}, { tailscale: true })).toBe(true);
    expect(preserveRunningTailscale(undefined, {}, { tailscale: false })).toBe(false);
  });

  test("no runfile: the flag (undefined) passes through untouched", () => {
    expect(preserveRunningTailscale(undefined, {}, undefined)).toBeUndefined();
  });
});

describe("browserPort", () => {
  test("checkout mode fronts webPort; falls back to apiPort if absent; binary mode always apiPort", () => {
    expect(browserPort({ mode: "checkout", apiPort: 4747, webPort: 5173 })).toBe(5173);
    expect(browserPort({ mode: "checkout", apiPort: 4747 })).toBe(4747);
    expect(browserPort({ mode: "binary", apiPort: 4747, webPort: 5173 })).toBe(4747);
  });
});

describe("proxyTarget", () => {
  test("wildcard and loopback hosts target 127.0.0.1; a specific host is named as-is", () => {
    expect(proxyTarget("0.0.0.0", 5173)).toBe("http://127.0.0.1:5173");
    expect(proxyTarget("::", 5173)).toBe("http://127.0.0.1:5173");
    expect(proxyTarget("", 5173)).toBe("http://127.0.0.1:5173");
    expect(proxyTarget("127.0.0.1", 5173)).toBe("http://127.0.0.1:5173");
    expect(proxyTarget("localhost", 5173)).toBe("http://127.0.0.1:5173");
    expect(proxyTarget("10.0.0.5", 5173)).toBe("http://10.0.0.5:5173");
  });

  test("a literal IPv6 host is bracketed", () => {
    expect(proxyTarget("2001:db8::1", 5173)).toBe("http://[2001:db8::1]:5173");
  });
});

describe("tailscaleUrl", () => {
  test("strips the trailing dot and never includes a port", () => {
    expect(tailscaleUrl("robs-macbook-pro.tailef3210.ts.net.")).toBe("https://robs-macbook-pro.tailef3210.ts.net");
    expect(tailscaleUrl("m.ts.net")).toBe("https://m.ts.net");
  });
});

describe("findTailscale", () => {
  test("FLOCK_TAILSCALE_BIN wins over everything", () => {
    expect(findTailscale({ FLOCK_TAILSCALE_BIN: "/custom/tailscale" }, "darwin", () => "/usr/local/bin/tailscale", () => true)).toBe("/custom/tailscale");
  });

  test("PATH wins over known install paths", () => {
    expect(findTailscale({}, "darwin", () => "/opt/homebrew/bin/tailscale", () => true)).toBe("/opt/homebrew/bin/tailscale");
  });

  test("darwin falls back to the known candidates in order, App Store build first", () => {
    const exists = (p: string) => p === "/usr/local/bin/tailscale";
    expect(findTailscale({}, "darwin", () => undefined, exists)).toBe("/usr/local/bin/tailscale");
  });

  test("linux uses its own candidate list", () => {
    const exists = (p: string) => p === "/usr/local/bin/tailscale";
    expect(findTailscale({}, "linux", () => undefined, exists)).toBe("/usr/local/bin/tailscale");
  });

  test("nothing found: undefined, no throw", () => {
    expect(findTailscale({}, "darwin", () => undefined, () => false)).toBeUndefined();
  });
});

describe("parseTailnetStatus", () => {
  test("a running, logged-in node with HTTPS enabled", () => {
    expect(parseTailnetStatus(RUNNING_STATUS)).toEqual({ dnsName: "robs-macbook-pro.tailef3210.ts.net", backendState: "Running", httpsEnabled: true });
  });

  test("NeedsLogin has no dnsName and httpsEnabled undefined", () => {
    expect(parseTailnetStatus(NEEDS_LOGIN_STATUS)).toEqual({ dnsName: undefined, backendState: "NeedsLogin", httpsEnabled: undefined });
  });

  test("CapMap present without https is httpsEnabled: false", () => {
    expect(parseTailnetStatus(NO_HTTPS_STATUS).httpsEnabled).toBe(false);
  });

  test("CapMap absent (older tailscaled) is httpsEnabled: undefined, not false", () => {
    expect(parseTailnetStatus(NO_CAPMAP_STATUS).httpsEnabled).toBeUndefined();
  });

  test("malformed JSON: all-undefined, no throw", () => {
    expect(parseTailnetStatus("not json")).toEqual({});
    expect(parseTailnetStatus("")).toEqual({});
    expect(parseTailnetStatus("null")).toEqual({});
  });
});

describe("parseServeStatus / rootMount", () => {
  test("the real captured shape flattens to one mount", () => {
    const mounts = parseServeStatus(ROOT_SERVE_STATUS("http://127.0.0.1:5173"));
    expect(mounts).toEqual([{ host: "m.tail.ts.net", port: 443, path: "/", proxy: "http://127.0.0.1:5173" }]);
    expect(rootMount(mounts)?.proxy).toBe("http://127.0.0.1:5173");
  });

  test("{} (nothing served) parses to []", () => {
    expect(parseServeStatus(EMPTY_SERVE_STATUS)).toEqual([]);
    expect(rootMount([])).toBeUndefined();
  });

  test("a multi-mount config: rootMount finds only the / on 443", () => {
    const mounts = parseServeStatus(MULTI_MOUNT_SERVE_STATUS);
    expect(mounts).toHaveLength(2);
    expect(rootMount(mounts)?.path).toBe("/");
  });

  test("malformed JSON -> []", () => {
    expect(parseServeStatus("not json")).toEqual([]);
    expect(parseServeStatus("{}")).toEqual([]);
  });
});

describe("preflightTailscale / establishTailscale", () => {
  const base = { host: "0.0.0.0", port: 5173 };

  test("refuses with no serve call when the binary is not found", () => {
    const { run, calls } = fake({});
    expect(() => establishTailscale({ run, bin: undefined, ...base })).toThrow(/not installed/);
    expect(calls).toHaveLength(0);
  });

  test("refuses when `status` exits non-zero", () => {
    const { run, calls } = fake({ "status --json": { code: 1, stderr: "some error\n" } });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/status.*failed/);
    expect(calls.some((c) => c.includes("serve"))).toBe(false);
  });

  test("refuses when not logged in", () => {
    const { run, calls } = fake({ "status --json": { stdout: NEEDS_LOGIN_STATUS } });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/NeedsLogin/);
    expect(calls.some((c) => c.includes("serve"))).toBe(false);
  });

  test("refuses when there is no MagicDNS name", () => {
    const { run, calls } = fake({ "status --json": { stdout: JSON.stringify({ BackendState: "Running" }) } });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/MagicDNS/);
    expect(calls.some((c) => c.includes("serve"))).toBe(false);
  });

  test("refuses when HTTPS certificates are disabled", () => {
    const { run, calls } = fake({ "status --json": { stdout: NO_HTTPS_STATUS } });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/HTTPS certificates/);
    expect(calls.some((c) => c.includes("serve"))).toBe(false);
  });

  test("refuses when / is already mounted to something else", () => {
    const { run, calls } = fake({
      "status --json": { stdout: RUNNING_STATUS },
      "serve status --json": { stdout: ROOT_SERVE_STATUS("http://127.0.0.1:9999") },
    });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/already proxies/);
    expect(calls.some((c) => c.includes("--bg"))).toBe(false);
  });

  test("refuses, quoting stderr, when the mount command itself fails", () => {
    const { run } = fake({
      "status --json": { stdout: RUNNING_STATUS },
      "serve status --json": { stdout: EMPTY_SERVE_STATUS },
      "serve --bg --yes --https=443 http://127.0.0.1:5173": { code: 1, stderr: "boom\n" },
    });
    expect(() => establishTailscale({ run, bin: "/bin/tailscale", ...base })).toThrow(/boom/);
  });

  test("happy path: the exact argv, and a mount already pointed at our target does not refuse", () => {
    const { run, calls } = fake({
      "status --json": { stdout: RUNNING_STATUS },
      "serve status --json": { stdout: ROOT_SERVE_STATUS("http://127.0.0.1:5173") },
      "serve --bg --yes --https=443 http://127.0.0.1:5173": { code: 0 },
    });
    const mount = establishTailscale({ run, bin: "/bin/tailscale", ...base });
    expect(mount).toEqual({ url: "https://robs-macbook-pro.tailef3210.ts.net", port: 443, target: "http://127.0.0.1:5173", bin: "/bin/tailscale" });
    expect(calls).toEqual([
      ["/bin/tailscale", "status", "--json"],
      ["/bin/tailscale", "serve", "status", "--json"],
      ["/bin/tailscale", "serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:5173"],
    ]);
  });

  test("preflightTailscale alone stops before ever looking at serve state", () => {
    const { run, calls } = fake({ "status --json": { stdout: RUNNING_STATUS } });
    const info = preflightTailscale({ run, bin: "/bin/tailscale" });
    expect(info.dnsName).toBe("robs-macbook-pro.tailef3210.ts.net");
    expect(calls).toEqual([["/bin/tailscale", "status", "--json"]]);
  });
});

describe("releaseTailscale", () => {
  test("no bin: undefined, no call", () => {
    const { run, calls } = fake({});
    expect(releaseTailscale({ run, bin: undefined, target: "http://127.0.0.1:5173" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("no live mount: undefined, no off command", () => {
    const { run, calls } = fake({ "serve status --json": { stdout: EMPTY_SERVE_STATUS } });
    expect(releaseTailscale({ run, bin: "/bin/tailscale", target: "http://127.0.0.1:5173" })).toBeUndefined();
    expect(calls.some((c) => c.includes("off"))).toBe(false);
  });

  test("mount points elsewhere: leaves it alone and says so, no off command", () => {
    const { run, calls } = fake({ "serve status --json": { stdout: ROOT_SERVE_STATUS("http://127.0.0.1:9999") } });
    const note = releaseTailscale({ run, bin: "/bin/tailscale", target: "http://127.0.0.1:5173" });
    expect(note).toMatch(/left `tailscale serve` alone/);
    expect(calls.some((c) => c.includes("off"))).toBe(false);
  });

  test("our mount: runs off, returns undefined", () => {
    const { run, calls } = fake({
      "serve status --json": { stdout: ROOT_SERVE_STATUS("http://127.0.0.1:5173") },
      "serve --https=443 off": { code: 0 },
    });
    expect(releaseTailscale({ run, bin: "/bin/tailscale", target: "http://127.0.0.1:5173" })).toBeUndefined();
    expect(calls).toEqual([
      ["/bin/tailscale", "serve", "status", "--json"],
      ["/bin/tailscale", "serve", "--https=443", "off"],
    ]);
  });

  test("off fails: returns the manual-instruction note, never escalates to reset", () => {
    const { run, calls } = fake({
      "serve status --json": { stdout: ROOT_SERVE_STATUS("http://127.0.0.1:5173") },
      "serve --https=443 off": { code: 1, stderr: "denied\n" },
    });
    const note = releaseTailscale({ run, bin: "/bin/tailscale", target: "http://127.0.0.1:5173" });
    expect(note).toMatch(/denied/);
    expect(note).toMatch(/serve --https=443 off/);
    expect(calls.some((c) => c.includes("reset"))).toBe(false);
  });
});
