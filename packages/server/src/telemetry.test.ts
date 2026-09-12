import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Flock, type Actor, type SessionReading } from "@flock/core";
import { createRegistry } from "@flock/harness/registry";
import type { HarnessReader, LivenessReading, RunHint, RunRef } from "@flock/harness/reader";
import { ClaudeCodeReader } from "@flock/harness/claude-code";
import { transcriptPath } from "@flock/harness/claude-code-paths";
import { createApp } from "./index.ts";
import { actorTelemetryTotals, createTelemetryRefresher, gateTranscripts, isLoopbackRequest, sessionFromHeader } from "./telemetry.ts";

/** The slice of a card/actor payload these tests assert on. Narrow by hand rather than `any`:
 *  the route's own return type is inferred by Hono and not exported, and the point of the
 *  assertion is exactly that these keys are present in the JSON. */
type ApiBody = {
  card: { num: number };
  name: string;
  kind: string;
  telemetry: Array<Record<string, unknown>>;
  totals: { sessions: number; cards: number; costUsd: number | null; costExact: boolean; toolCalls: number | null };
  duration: { claimedAt: string | null; closedAt: string | null; ms: number | null };
};

const scoutSession = "claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c";
const scout: Actor = { name: "scout", kind: "agent", session: scoutSession };
const ada: Actor = { name: "ada", kind: "human" };

function reading(overrides: Partial<SessionReading> = {}): SessionReading {
  return { key: scoutSession, sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c", observedAt: "2026-09-11T00:00:00.000Z", ...overrides };
}

/** A `HarnessReader` whose `read` is fully scripted, and counts calls so tests can assert on
 * TTL/single-flight behaviour without touching a real transcript. */
function fakeReader(opts: { family?: string; read?: () => Promise<SessionReading | null>; resolveOk?: boolean } = {}) {
  let resolveCalls = 0;
  let readCalls = 0;
  const reader: HarnessReader = {
    family: opts.family ?? "claude-code",
    async resolve(hint: RunHint): Promise<RunRef | null> {
      resolveCalls++;
      if (opts.resolveOk === false) return null;
      return { key: hint.key, family: reader.family, sessionId: "8ea8caf2-d288-4e0a-89de-04c45158535c", cwd: hint.cwd };
    },
    async read(_ref: RunRef): Promise<SessionReading | null> {
      readCalls++;
      return opts.read ? opts.read() : reading({ toolCalls: readCalls });
    },
    async liveness(): Promise<LivenessReading> {
      return { liveness: "running" };
    },
  };
  return { reader, calls: () => ({ resolveCalls, readCalls }) };
}

function boardWithScoutCard() {
  const flock = new Flock(":memory:");
  const board = flock.createBoard(ada, { title: "Telemetry" });
  const card = flock.createCard(scout, board.id, { title: "X" });
  return { flock, board, card };
}

describe("createTelemetryRefresher: TTL and single-flight", () => {
  test("a session with no stored reading is refreshed on first read", async () => {
    const { flock, board, card } = boardWithScoutCard();
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(1);
    expect(calls().readCalls).toBe(1);
  });

  test("a fresh reading (within the TTL) is not re-read", async () => {
    const { flock, board, card } = boardWithScoutCard();
    let now = 1_000_000;
    flock.recordSessionReading(reading({ observedAt: new Date(now).toISOString(), toolCalls: 5 }));
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry, { now: () => now });

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(5);
    expect(calls().readCalls).toBe(0);
  });

  test("a reading older than the 15s TTL is refreshed", async () => {
    const { flock, board, card } = boardWithScoutCard();
    let now = 1_000_000;
    flock.recordSessionReading(reading({ observedAt: new Date(now).toISOString(), toolCalls: 5 }));
    const { reader, calls } = fakeReader({ read: async () => reading({ toolCalls: 99 }) });
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry, { now: () => now });

    now += 15_001;
    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(99);
    expect(calls().readCalls).toBe(1);
  });

  test("a session with cost is final and is never re-read, however stale", async () => {
    const { flock, board, card } = boardWithScoutCard();
    flock.recordSessionReading(
      reading({ observedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-01T00:05:00.000Z", costUsd: 1.5, toolCalls: 3 }),
    );
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(3);
    expect(calls().readCalls).toBe(0);
  });

  test("an ended session with no cost yet is still refreshed — cost lands retroactively", async () => {
    const { flock, board, card } = boardWithScoutCard();
    flock.recordSessionReading(
      reading({ observedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-01T00:05:00.000Z", liveness: "gone", lastActivityAt: "2020-01-01T00:05:00.000Z", toolCalls: 3 }),
    );
    const { reader, calls } = fakeReader({ read: async () => reading({ costUsd: 2, toolCalls: 3 }) });
    const registry = createRegistry([reader]);
    // A few minutes after it went quiet — well inside ENDED_SESSION_MAX_AGE_MS, so it is not
    // final yet and must still be re-read.
    const now = Date.parse("2020-01-01T00:10:00.000Z");
    const refresher = createTelemetryRefresher(flock, registry, { now: () => now });

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(calls().readCalls).toBe(1);
    expect(t.costUsd).toBe(2);
  });

  test("a session gone more than ENDED_SESSION_MAX_AGE_MS with still no cost is finally given up on", async () => {
    const { flock, board, card } = boardWithScoutCard();
    flock.recordSessionReading(
      reading({ observedAt: "2020-01-01T00:00:00.000Z", liveness: "gone", lastActivityAt: "2020-01-01T00:00:00.000Z", toolCalls: 3 }),
    );
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    // 8 days after lastActivityAt: past ENDED_SESSION_MAX_AGE_MS (7 days).
    const now = Date.parse("2020-01-09T00:00:00.000Z");
    const refresher = createTelemetryRefresher(flock, registry, { now: () => now });

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(calls().readCalls).toBe(0);
    expect(t.toolCalls).toBe(3);
  });

  test("concurrent refreshes of the same stale session collapse into one underlying read", async () => {
    const { flock, board, card } = boardWithScoutCard();
    let inRead = 0;
    let maxConcurrentReads = 0;
    const { reader, calls } = fakeReader({
      read: async () => {
        inRead++;
        maxConcurrentReads = Math.max(maxConcurrentReads, inRead);
        await new Promise((r) => setTimeout(r, 20));
        inRead--;
        return reading({ toolCalls: 7 });
      },
    });
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [a, b, c] = await Promise.all([
      refresher.refreshCard(board.id, card.num),
      refresher.refreshCard(board.id, card.num),
      refresher.refreshCard(board.id, card.num),
    ]);
    expect(calls().readCalls).toBe(1);
    expect(maxConcurrentReads).toBe(1);
    expect(a[0]!.toolCalls).toBe(7);
    expect(b[0]!.toolCalls).toBe(7);
    expect(c[0]!.toolCalls).toBe(7);
  });

  test("a refresh failure never throws and the stale stored reading stands", async () => {
    const { flock, board, card } = boardWithScoutCard();
    flock.recordSessionReading(reading({ observedAt: "2020-01-01T00:00:00.000Z", toolCalls: 4 }));
    const { reader } = fakeReader({
      read: async () => {
        throw new Error("transcript exploded");
      },
    });
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(4);
  });

  test("an unresolvable run (no matching reader) is skipped, not thrown", async () => {
    const { flock, board, card } = boardWithScoutCard();
    const registry = createRegistry([]); // no reader registered for "claude-code"
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.key).toBe(scoutSession);
    expect(t.toolCalls).toBeUndefined();
  });

  test("refreshActor mirrors the same TTL/single-flight rules over an actor's sessions", async () => {
    const { flock, board } = boardWithScoutCard();
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshActor(board.id, "scout");
    expect(t.toolCalls).toBe(1);
    expect(calls().readCalls).toBe(1);
  });
});

describe("cost lands retroactively: a real fixture transcript with no hook involved", () => {
  test("no cost-state yet shows no cost; appending one after the TTL surfaces it on the next view", async () => {
    const home = await mkdtemp(join(tmpdir(), "flock-telemetry-"));
    try {
      const cwd = "/Users/test/project";
      const sessionId = "44444444-4444-4444-4444-444444444444";
      const key = `claude-code:${sessionId}`;
      const transcript = transcriptPath(home, cwd, sessionId);
      await mkdir(dirname(transcript), { recursive: true });
      const lines = [
        { type: "user", sessionId, timestamp: "2026-09-11T20:00:00.000Z", message: { content: [{ type: "text", text: "hi" }] } },
        {
          type: "assistant",
          sessionId,
          timestamp: "2026-09-11T20:00:05.000Z",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "hi back" }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
          },
        },
      ];
      await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      const flock = new Flock(":memory:");
      const board = flock.createBoard(ada, { title: "B" });
      const actor: Actor = { name: "scout", kind: "agent", session: key };
      flock.createCard(actor, board.id, { title: "X" });
      // Seed the row the way this agent's own machine would on `done`/`release` (ADR 0026 §2
      // "the CLI, on done and release"): cwd known, no telemetry read yet. That is what lets
      // the server later resolve a reader against this session with no cwd of its own.
      flock.recordSessionReading({ key, sessionId, cwd, observedAt: new Date().toISOString() });

      const reader = new ClaudeCodeReader({ home });
      const registry = createRegistry([reader]);
      let now = Date.now() + 15_001; // past REFRESH_TTL_MS from the seed above
      const refresher = createTelemetryRefresher(flock, registry, { now: () => now });

      const [before] = await refresher.refreshCard(board.id, 1);
      expect(before.costUsd).toBeUndefined();

      // Only after the session itself ends does Claude Code append this line — the whole point
      // of "cost lands retroactively".
      const costState = {
        type: "cost-state",
        sessionId,
        totalCostUSD: 3.21,
        totalAPIDuration: 1_000,
        totalToolDuration: 500,
        totalDuration: 2_000,
        startTime: Date.parse("2026-09-11T20:00:00.000Z"),
        modelUsage: { "claude-sonnet-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 3.21 } },
        hasUnknownModelCost: false,
      };
      await appendFile(transcript, `${JSON.stringify(costState)}\n`);

      // Past REFRESH_TTL_MS again, measured from the virtual clock's own last value (not the
      // real observedAt the read stamped) — the same margin the TTL test above uses.
      now += 15_001;
      const [after] = await refresher.refreshCard(board.id, 1);
      expect(after.costUsd).toBeCloseTo(3.21);
      flock.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("gateTranscripts", () => {
  test("omits the transcript path off loopback and keeps every other field", () => {
    const entries = [{ ...reading({ transcript: "/Users/rob/.claude/x.jsonl" }), actor: "scout", alsoWorked: [] }];
    const gated = gateTranscripts(entries, false);
    expect(gated[0]!.transcript).toBeUndefined();
    expect(gated[0]!.key).toBe(scoutSession);
  });

  test("keeps the transcript path on loopback", () => {
    const entries = [{ ...reading({ transcript: "/Users/rob/.claude/x.jsonl" }), actor: "scout", alsoWorked: [] }];
    const gated = gateTranscripts(entries, true);
    expect(gated[0]!.transcript).toBe("/Users/rob/.claude/x.jsonl");
  });
});

describe("actorTelemetryTotals", () => {
  test("sums cost and tool calls over distinct sessions and unions alsoWorked into a card count", () => {
    const totals = actorTelemetryTotals([
      { ...reading({ costUsd: 1.5, costExact: true, toolCalls: 3 }), actor: "scout", alsoWorked: [1, 2] },
      { ...reading({ key: "claude-code:other", costUsd: 2.5, costExact: false, toolCalls: 4 }), actor: "scout", alsoWorked: [2, 3] },
    ]);
    expect(totals.sessions).toBe(2);
    expect(totals.cards).toBe(3); // {1,2,3}
    expect(totals.costUsd).toBeCloseTo(4.0);
    expect(totals.costExact).toBe(false); // one contributing session was inexact
    expect(totals.toolCalls).toBe(7);
  });

  test("cost is null (not zero) when no session in scope has a known cost", () => {
    const totals = actorTelemetryTotals([{ ...reading(), actor: "scout", alsoWorked: [] }]);
    expect(totals.costUsd).toBeNull();
    expect(totals.toolCalls).toBeNull();
    expect(totals.sessions).toBe(1);
  });
});

describe("sessionFromHeader", () => {
  test("trims and caps length; blank/absent means undefined", () => {
    expect(sessionFromHeader("  claude-code:abc  ")).toBe("claude-code:abc");
    expect(sessionFromHeader("")).toBeUndefined();
    expect(sessionFromHeader(undefined)).toBeUndefined();
    expect(sessionFromHeader("x".repeat(500))?.length).toBe(200);
  });
});

describe("isLoopbackRequest", () => {
  test("true for 127.0.0.1 and ::1, false with no requestIP on c.env", () => {
    const raw = new Request("http://localhost/");
    expect(isLoopbackRequest({ env: { requestIP: () => ({ address: "127.0.0.1" }) }, req: { raw } })).toBe(true);
    expect(isLoopbackRequest({ env: { requestIP: () => ({ address: "::1" }) }, req: { raw } })).toBe(true);
    expect(isLoopbackRequest({ env: { requestIP: () => ({ address: "10.0.0.5" }) }, req: { raw } })).toBe(false);
    expect(isLoopbackRequest({ env: {}, req: { raw } })).toBe(false);
    expect(isLoopbackRequest({ env: undefined, req: { raw } })).toBe(false);
  });
});

describe("GET /api/boards/:b/cards/:n telemetry and duration", () => {
  function appWithReader() {
    const flock = new Flock(":memory:");
    const { reader } = fakeReader({ read: async () => reading({ toolCalls: 9, transcript: "/tmp/fake.jsonl" }) });
    const registry = createRegistry([reader]);
    const app = createApp({ flock, dbPath: ":memory:", push: false, harnessRegistry: registry });
    return { flock, app };
  }

  test("card payload gains telemetry (refreshed) and duration, additively", async () => {
    const { flock, app } = appWithReader();
    const board = flock.createBoard(ada, { title: "B" });
    const card = flock.createCard(scout, board.id, { title: "X" });
    flock.claimCard(scout, board.id, card.num);

    const res = await app.request(`/api/boards/${board.id}/cards/${card.num}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiBody;
    expect(body.card.num).toBe(card.num);
    expect(Array.isArray(body.telemetry)).toBe(true);
    expect(body.telemetry[0].toolCalls).toBe(9);
    expect(body.duration.claimedAt).not.toBeNull();
    expect(body.duration.closedAt).toBeNull();
  });

  test("telemetry is [] (not absent) for a card with no session-linked event", async () => {
    const { flock, app } = appWithReader();
    const board = flock.createBoard(ada, { title: "B" });
    flock.createCard(ada, board.id, { title: "No harness" });

    const res = await app.request(`/api/boards/${board.id}/cards/1`);
    const body = (await res.json()) as ApiBody;
    expect(body.telemetry).toEqual([]);
  });

  test("transcript is omitted off loopback and present on loopback", async () => {
    const { flock, app } = appWithReader();
    const board = flock.createBoard(ada, { title: "B" });
    const card = flock.createCard(scout, board.id, { title: "X" });

    const offLoopback = await app.request(`/api/boards/${board.id}/cards/${card.num}`);
    const offBody = (await offLoopback.json()) as ApiBody;
    expect(offBody.telemetry[0].transcript).toBeUndefined();

    const onLoopback = await app.request(`/api/boards/${board.id}/cards/${card.num}`, {}, { requestIP: () => ({ address: "127.0.0.1" }) });
    const onBody = (await onLoopback.json()) as ApiBody;
    expect(onBody.telemetry[0].transcript).toBe("/tmp/fake.jsonl");
  });
});

describe("GET /api/boards/:b/actors/:name telemetry and totals", () => {
  test("actor payload gains telemetry and totals over distinct sessions, additive to the existing profile", async () => {
    const flock = new Flock(":memory:");
    const { reader } = fakeReader({ read: async () => reading({ costUsd: 2, costExact: true, toolCalls: 5 }) });
    const registry = createRegistry([reader]);
    const app = createApp({ flock, dbPath: ":memory:", push: false, harnessRegistry: registry });
    const board = flock.createBoard(ada, { title: "B" });
    flock.createCard(scout, board.id, { title: "X" });

    const res = await app.request(`/api/boards/${board.id}/actors/scout`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiBody;
    expect(body.name).toBe("scout");
    expect(body.kind).toBe("agent");
    expect(Array.isArray(body.telemetry)).toBe(true);
    expect(body.telemetry[0].costUsd).toBe(2);
    expect(body.totals.sessions).toBe(1);
    expect(body.totals.costUsd).toBe(2);
    expect(body.totals.toolCalls).toBe(5);
  });
});

describe("x-flock-session header", () => {
  test("mirrors into the actor's runtime the way harness/model/effort do", async () => {
    const flock = new Flock(":memory:");
    const app = createApp({ flock, dbPath: ":memory:", push: false });
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flock-actor": "scout",
        "x-flock-actor-kind": "agent",
        "x-flock-session": scoutSession,
      },
      body: JSON.stringify({ title: "Session Board" }),
    });
    const board = await res.json();
    const events = flock.events({ boardId: board.id });
    const created = events.find((e) => e.type === "board.created")!;
    expect(created.session).toBe(scoutSession);
  });

  test("a blank session header carries no session, same as harness/model/effort", async () => {
    const flock = new Flock(":memory:");
    const app = createApp({ flock, dbPath: ":memory:", push: false });
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent", "x-flock-session": "  " },
      body: JSON.stringify({ title: "No Session Board" }),
    });
    const board = await res.json();
    const created = flock.events({ boardId: board.id }).find((e) => e.type === "board.created")!;
    expect(created.session).toBeUndefined();
  });
});
