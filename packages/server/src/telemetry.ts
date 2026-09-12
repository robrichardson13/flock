/**
 * Server-side half of harness telemetry (ADR 0023 §2 "who triggers a refresh" / §5 "surface"):
 * refresh-on-read for a card or actor payload, and the shaping (transcript gating, actor totals)
 * those payloads need. Core does the storage and the group-by; `@flock/harness` does the actual
 * transcript read; this file is only the policy that ties a request to both, bounded so a page
 * full of tabs never turns into unbounded filesystem work.
 */
import type { Flock, HarnessSessionTelemetry } from "@flock/core";
import type { HarnessRegistry } from "@flock/harness/registry";

/** ADR 0023 §2: a non-ended session is refreshed when its stored reading is older than this. */
export const REFRESH_TTL_MS = 15_000;
/** How many transcript reads may run at once across the whole server. Bounded, not per-request. */
export const MAX_CONCURRENT_REFRESHES = 4;
/** Mirrors core's `MAX_KEY_LENGTH` (telemetry-types.ts) without importing a non-exported constant. */
const MAX_SESSION_HEADER_LENGTH = 200;

/** A tiny counting semaphore: bounds how many refreshes run concurrently, queueing the rest. */
function createSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  return { acquire, release };
}

export interface TelemetryRefresher {
  /** Fresh telemetry for one card: refreshes any non-ended, stale session first. */
  refreshCard(boardRef: string, cardNum: number): Promise<HarnessSessionTelemetry[]>;
  /** Fresh telemetry for one actor's sessions on one board, same staleness rule. */
  refreshActor(boardRef: string, actorName: string): Promise<HarnessSessionTelemetry[]>;
}

/**
 * Builds the refresh-on-read policy over one `Flock` and one harness registry. A session with
 * `endedAt` set is immutable and is never re-read (ADR 0023). A session with no stored row yet
 * (`observedAt: ""`) is always a candidate, bounded by the same TTL against the last *attempt*
 * (not just the last successful read) so a reader that keeps failing does not get hammered on
 * every page view. Refreshes for the same run key are single-flight: concurrent requests for the
 * same card or actor collapse onto one underlying read.
 */
export function createTelemetryRefresher(
  flock: Flock,
  registry: HarnessRegistry,
  opts: { now?: () => number; maxConcurrent?: number } = {},
): TelemetryRefresher {
  const now = opts.now ?? Date.now;
  const semaphore = createSemaphore(opts.maxConcurrent ?? MAX_CONCURRENT_REFRESHES);
  const inFlight = new Map<string, Promise<void>>();
  const lastAttemptAt = new Map<string, number>();

  const isStale = (entry: HarnessSessionTelemetry): boolean => {
    if (entry.endedAt) return false;
    const lastRead = entry.observedAt ? Date.parse(entry.observedAt) : 0;
    const lastAttempt = lastAttemptAt.get(entry.key) ?? 0;
    return now() - Math.max(lastRead, lastAttempt) > REFRESH_TTL_MS;
  };

  const refreshOne = (entry: HarnessSessionTelemetry): Promise<void> => {
    const running = inFlight.get(entry.key);
    if (running) return running;
    const task = doRefresh(flock, registry, entry, semaphore)
      .catch((err: unknown) => {
        // A refresh must never fail the request it was serving; the stale stored reading (or
        // no reading at all) stands, and the failure is logged with the key for diagnosis.
        console.error(`[telemetry] refresh failed for session ${entry.key}:`, err);
      })
      .finally(() => {
        lastAttemptAt.set(entry.key, now());
        inFlight.delete(entry.key);
      });
    inFlight.set(entry.key, task);
    return task;
  };

  const refreshStale = async (entries: HarnessSessionTelemetry[]): Promise<void> => {
    await Promise.all(entries.filter(isStale).map(refreshOne));
  };

  return {
    async refreshCard(boardRef, cardNum) {
      const entries = flock.sessionsForCard(boardRef, cardNum);
      if (entries.length === 0) return entries;
      await refreshStale(entries);
      return flock.sessionsForCard(boardRef, cardNum);
    },
    async refreshActor(boardRef, actorName) {
      const entries = flock.sessionsForActor(boardRef, actorName);
      if (entries.length === 0) return entries;
      await refreshStale(entries);
      return flock.sessionsForActor(boardRef, actorName);
    },
  };
}

/** One bounded, single read: resolve the run, read it, and upsert what came back. Never throws
 * past the caller — `refreshOne` above is the only catch site, kept here would just duplicate it. */
async function doRefresh(
  flock: Flock,
  registry: HarnessRegistry,
  entry: HarnessSessionTelemetry,
  semaphore: ReturnType<typeof createSemaphore>,
): Promise<void> {
  await semaphore.acquire();
  try {
    const hint = { key: entry.key, cwd: entry.cwd };
    const reader = registry.readerForHint(hint);
    if (!reader) return;
    const ref = await reader.resolve(hint);
    if (!ref) return;
    const reading = await reader.read(ref);
    if (!reading) return;
    flock.recordSessionReading(reading);
  } finally {
    semaphore.release();
  }
}

/** ADR 0023 §2 "Privacy": the transcript path is a convenience for a human on this machine.
 * Since `flock serve` can be fronted onto a tailnet, the HTTP API omits it off loopback. */
export function gateTranscripts(entries: HarnessSessionTelemetry[], loopback: boolean): HarnessSessionTelemetry[] {
  if (loopback) return entries;
  return entries.map(({ transcript: _transcript, ...rest }) => rest);
}

export interface ActorTelemetryTotals {
  /** Distinct sessions this actor ran on this board — never double-counts a session over its cards. */
  sessions: number;
  /** Distinct card numbers any of those sessions touched. */
  cards: number;
  /** Null when no session in scope has a known cost (all live, or all on a costless harness). */
  costUsd: number | null;
  /** False if any contributing session flagged an unknown-model cost. */
  costExact: boolean;
  toolCalls: number | null;
}

/** Sums an actor's `sessionsForActor` rows into the actor page's totals strip. `entries` is
 * already one row per distinct session (core's group-by), so summing it directly is correct. */
export function actorTelemetryTotals(entries: HarnessSessionTelemetry[]): ActorTelemetryTotals {
  const cards = new Set<number>();
  let costUsd: number | null = null;
  let costExact = true;
  let toolCalls: number | null = null;
  for (const entry of entries) {
    for (const num of entry.alsoWorked) cards.add(num);
    if (typeof entry.costUsd === "number") {
      costUsd = (costUsd ?? 0) + entry.costUsd;
      if (entry.costExact === false) costExact = false;
    }
    if (typeof entry.toolCalls === "number") toolCalls = (toolCalls ?? 0) + entry.toolCalls;
  }
  return { sessions: entries.length, cards: cards.size, costUsd, costExact, toolCalls };
}

/** A Bun `Server`'s request-IP lookup, narrowed down to the one method this file calls, so the
 * loopback check works without pulling in `bun-types`' full `Server` interface. */
interface RequestIpSource {
  requestIP(request: Request): { address: string } | null;
}

function hasRequestIP(env: unknown): env is RequestIpSource {
  return typeof env === "object" && env !== null && typeof (env as { requestIP?: unknown }).requestIP === "function";
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True when the request reached this process over loopback. Bun hands its `Server` (which has
 * `requestIP`) to `fetch` as the second argument, and Hono exposes that as `c.env` — so this
 * works with no extra wiring in `serve()`, and degrades to `false` (safer: omit the path) under
 * a runtime or test harness that never sets `c.env` at all.
 */
export function isLoopbackRequest(c: { env: unknown; req: { raw: Request } }): boolean {
  if (!hasRequestIP(c.env)) return false;
  const addr = c.env.requestIP(c.req.raw);
  return addr !== null && LOOPBACK_ADDRESSES.has(addr.address);
}

/** `x-flock-session`, trimmed and length-capped the way `normalizeRuntime` caps harness/model/effort
 * — mirrored here rather than in core's `normalizeRuntime` so this card touches only the server. */
export function sessionFromHeader(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_SESSION_HEADER_LENGTH);
}
