import { describe, expect, test } from "bun:test";
import { Flock, type Actor, type SessionReading } from "@flock/core";
import { createRegistry } from "@flock/harness/registry";
import type { HarnessReader, LivenessReading, RunHint, RunRef } from "@flock/harness/reader";
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

  test("an ended session is never re-read, however stale", async () => {
    const { flock, board, card } = boardWithScoutCard();
    flock.recordSessionReading(reading({ observedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-01T00:05:00.000Z", toolCalls: 3 }));
    const { reader, calls } = fakeReader();
    const registry = createRegistry([reader]);
    const refresher = createTelemetryRefresher(flock, registry);

    const [t] = await refresher.refreshCard(board.id, card.num);
    expect(t.toolCalls).toBe(3);
    expect(calls().readCalls).toBe(0);
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
