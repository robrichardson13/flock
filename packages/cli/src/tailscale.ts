/**
 * `tailscale serve` integration: fronts the daemon's browser-facing port with an HTTPS origin on
 * the tailnet. See ADR 0018 (card 4) for the full design; this module is the whole surface
 * `daemon.ts` and `main.ts` use — nothing else in the CLI talks to `tailscale` directly.
 *
 * Everything that could shell out takes an injectable `Runner`, so `bun test` never executes a
 * real `tailscale` binary. The only production construction of `spawnRunner` lives in daemon.ts
 * and main.ts, at the actual call sites.
 */
import { existsSync } from "node:fs";
import { FlockError } from "@flock/core";
import { readConfig, type FlockConfig } from "./update.ts";

export const FLOCK_TAILSCALE_BIN = "FLOCK_TAILSCALE_BIN";

// ---------------------------------------------------------------------------- resolution

/**
 * `--tailscale`/`--no-tailscale` > `FLOCK_TAILSCALE` > `"tailscale"` in config.json > off. Mirrors
 * `resolveHost` in dev.ts, one step wider because the value is a boolean with an explicit negation
 * (`--no-tailscale`, `FLOCK_TAILSCALE=0`) rather than every value being expressible positively.
 */
export function resolveTailscale(flag: boolean | undefined, env: Record<string, string | undefined>, config: Pick<FlockConfig, "tailscale"> = readConfig()): boolean {
  return flag ?? envBool(env.FLOCK_TAILSCALE) ?? config.tailscale ?? false;
}

/** "", "0", "false", "no" (any case) are off; any other set value is on; unset is undefined. */
export function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return !["0", "false", "no"].includes(v.toLowerCase());
}

/**
 * A bare `up`/`restart` must not silently drop the HTTPS origin a phone's installed app depends
 * on: when neither the flag nor the env var is given explicitly, the running daemon's own choice
 * wins over recomputing the config/default. Mirrors `preserveRunningHost` in daemon.ts exactly.
 */
export function preserveRunningTailscale(flag: boolean | undefined, env: Record<string, string | undefined>, existing: { tailscale?: boolean } | undefined): boolean | undefined {
  if (flag !== undefined || env.FLOCK_TAILSCALE) return flag;
  return existing?.tailscale ?? flag;
}

// ---------------------------------------------------------------------------- which port

export type Mode = "binary" | "checkout";

/** The port a browser hits: vite's webPort in checkout mode (it proxies /api onward), the one server port in binary mode. */
export function browserPort(d: { mode: Mode; apiPort: number; webPort?: number }): number {
  return d.mode === "checkout" ? (d.webPort ?? d.apiPort) : d.apiPort;
}

/** Where the mount should proxy to: loopback for a wildcard/loopback bind, else the bound host itself. */
export function proxyTarget(host: string, port: number): string {
  const loopbackOrWildcard = ["0.0.0.0", "::", "", "127.0.0.1", "localhost", "::1"].includes(host);
  return `http://${loopbackOrWildcard ? "127.0.0.1" : bracketed(host)}:${port}`;
}

function bracketed(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** `https://<dnsName>`, stripping a trailing dot and never including a port — the mount is on 443. */
export const tailscaleUrl = (dnsName: string) => `https://${dnsName.replace(/\.$/, "")}`;

// ---------------------------------------------------------------------------- the runner

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string[]) => RunResult;

export const spawnRunner: Runner = (cmd) => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    // A binary that vanished (or an FLOCK_TAILSCALE_BIN override pointing nowhere) makes
    // Bun.spawnSync throw rather than return a result; every caller here only ever looks at
    // `code`/`stderr`, so turn that into an ordinary failed RunResult instead of an uncaught throw.
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

// ---------------------------------------------------------------------------- locating the binary

export const MAC_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale", // App Store build: no CLI on PATH
  "/usr/local/bin/tailscale", // open-source / pkg install
  "/opt/homebrew/bin/tailscale", // Homebrew on Apple Silicon
];
export const LINUX_CANDIDATES = ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];

export function findTailscale(env: Record<string, string | undefined>, platform: string, which: (c: string) => string | undefined, exists: (p: string) => boolean): string | undefined {
  const override = env[FLOCK_TAILSCALE_BIN];
  if (override) return override; // trusted as given; failure surfaces later
  const onPath = which("tailscale");
  if (onPath) return onPath;
  return (platform === "darwin" ? MAC_CANDIDATES : LINUX_CANDIDATES).find(exists);
}

/** The live version of `findTailscale`: PATH via Bun.which, real files via existsSync. */
export function findTailscaleReal(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | undefined {
  return findTailscale(env, platform, (c) => Bun.which(c) ?? undefined, existsSync);
}

// ---------------------------------------------------------------------------- parsing tailscale's output

export interface TailnetInfo {
  /** MagicDNS name, trailing dot stripped: "robs-macbook-pro.tailef3210.ts.net". */
  dnsName?: string;
  /** "Running", "NeedsLogin", "Stopped", "NoState", … */
  backendState?: string;
  /** true when Self.CapMap has "https"; undefined when CapMap is absent (older tailscaled) — a
   *  three-valued read so an old tailscaled that never reports CapMap is not treated as refused. */
  httpsEnabled?: boolean;
}

export function parseTailnetStatus(stdout: string): TailnetInfo {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const backendState = typeof o.BackendState === "string" ? o.BackendState : undefined;
  const self = o.Self && typeof o.Self === "object" ? (o.Self as Record<string, unknown>) : undefined;
  const dnsName = typeof self?.DNSName === "string" ? (self.DNSName as string).replace(/\.$/, "") || undefined : undefined;
  const capMap = self?.CapMap && typeof self.CapMap === "object" ? (self.CapMap as Record<string, unknown>) : undefined;
  const httpsEnabled = capMap ? "https" in capMap : undefined;
  return { dnsName, backendState, httpsEnabled };
}

export interface Mount {
  host: string;
  port: number;
  path: string;
  proxy: string;
}

/** Flattens `serve status --json`'s `.Web[host:port].Handlers[path].Proxy` shape. `{}`/malformed -> []. */
export function parseServeStatus(stdout: string): Mount[] {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!v || typeof v !== "object") return [];
  const web = (v as Record<string, unknown>).Web;
  if (!web || typeof web !== "object") return [];
  const mounts: Mount[] = [];
  for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const handlers = (entry as Record<string, unknown>).Handlers;
    if (!handlers || typeof handlers !== "object") continue;
    const idx = hostPort.lastIndexOf(":");
    const host = idx >= 0 ? hostPort.slice(0, idx) : hostPort;
    const port = idx >= 0 ? Number(hostPort.slice(idx + 1)) : Number.NaN;
    for (const [path, handler] of Object.entries(handlers as Record<string, unknown>)) {
      if (!handler || typeof handler !== "object") continue;
      const proxy = (handler as Record<string, unknown>).Proxy;
      if (typeof proxy === "string") mounts.push({ host, port, path, proxy });
    }
  }
  return mounts;
}

/** The `/` mount on :443, if any. */
export function rootMount(mounts: Mount[]): Mount | undefined {
  return mounts.find((m) => m.path === "/" && m.port === 443);
}

// ---------------------------------------------------------------------------- the composed operations

export interface TailscaleMount {
  url: string;
  port: number;
  target: string;
  bin: string;
}

function refuse(message: string): never {
  throw new FlockError(message, "invalid");
}

/**
 * Steps 1-5: entirely read-only. Called twice per `up --tailscale` by design — once in
 * `resolvePlan`, before anything is spawned, so a missing binary or a logged-out tailnet costs
 * nothing and starts nothing; and again inside `establishTailscale`, right before mounting, since
 * tailscaled's state can change between planning and the daemon actually listening.
 */
export function preflightTailscale(a: { run: Runner; bin: string | undefined }): TailnetInfo & { dnsName: string } {
  const bin = a.bin;
  if (!bin) refuse("tailscale is not installed, or not on PATH. Install it from https://tailscale.com/download, or set FLOCK_TAILSCALE_BIN to its path.");

  const status = a.run([bin, "status", "--json"]);
  if (status.code !== 0) refuse(`\`${bin} status\` failed: ${status.stderr.trim().split("\n")[0] || `exit ${status.code}`}`);
  const info = parseTailnetStatus(status.stdout);

  if (info.backendState !== "Running") {
    refuse(`tailscale is not connected (\`${info.backendState ?? "unknown"}\`). Run \`${bin} up\` first.`);
  }
  if (!info.dnsName) {
    refuse("this node has no MagicDNS name; enable MagicDNS in the admin console: https://login.tailscale.com/admin/dns");
  }
  if (info.httpsEnabled === false) {
    refuse("HTTPS certificates are not enabled for this tailnet. Enable them at https://login.tailscale.com/admin/dns, then retry.");
  }
  return info as TailnetInfo & { dnsName: string };
}

/**
 * Preflight + mount (steps 1-7 of ADR 0018 §4). Throws an actionable, single-topic FlockError on
 * any failure, each naming the command to run next. Every `up --tailscale` re-runs this, whether
 * the daemon was just started or was already running, since the mount lives in tailscaled rather
 * than in the runfile and can be removed from underneath flock (`tailscale down`, a reboot, a
 * manual `serve reset`).
 */
export function establishTailscale(a: { run: Runner; bin: string | undefined; host: string; port: number }): TailscaleMount {
  const info = preflightTailscale(a);
  const bin = a.bin as string; // preflightTailscale refuses (throws) when bin is undefined

  const target = proxyTarget(a.host, a.port);
  const serveStatus = a.run([bin, "serve", "status", "--json"]);
  const existing = serveStatus.code === 0 ? rootMount(parseServeStatus(serveStatus.stdout)) : undefined;
  if (existing && existing.proxy !== target) {
    refuse(`\`tailscale serve\` already proxies / to ${existing.proxy}. Stop that service, or run \`${bin} serve --https=443 off\`, then retry.`);
  }

  const mount = a.run([bin, "serve", "--bg", "--yes", "--https=443", target]);
  if (mount.code !== 0) refuse(`\`${bin} serve\` failed: ${mount.stderr.trim().split("\n")[0] || `exit ${mount.code}`}`);

  return { url: tailscaleUrl(info.dnsName), port: 443, target, bin };
}

/**
 * Guarded teardown: removes only the `:443` handler, and only when the live `/` mount still points
 * at `target` (what this daemon recorded, not a recomputed value — the daemon may have fallen back
 * onto offset ports since). Never `serve reset`, which would wipe every other mount the user has.
 * Never throws; returns a note to print, or undefined when there was nothing to say.
 */
export function releaseTailscale(a: { run: Runner; bin: string | undefined; target: string }): string | undefined {
  const bin = a.bin;
  if (!bin) return undefined;
  const status = a.run([bin, "serve", "status", "--json"]);
  if (status.code !== 0) return undefined;
  const mount = rootMount(parseServeStatus(status.stdout));
  if (!mount) return undefined;
  if (mount.proxy !== a.target) {
    return `left \`tailscale serve\` alone: / now proxies ${mount.proxy}, not flock's ${a.target}`;
  }
  const off = a.run([bin, "serve", "--https=443", "off"]);
  if (off.code !== 0) {
    return `could not remove the tailscale serve mount: ${off.stderr.trim().split("\n")[0] || `exit ${off.code}`}\nClear it by hand with: ${bin} serve --https=443 off`;
  }
  return undefined;
}
