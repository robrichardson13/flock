import { describe, expect, test } from "bun:test";
import { Flock } from "@flock/core";
import { createApp } from "./index.ts";

function fresh() {
  const flock = new Flock(":memory:");
  const app = createApp({ flock, dbPath: ":memory:" });
  return { flock, app };
}

const headers = { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" };

async function newBoard(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/boards", { method: "POST", headers, body: JSON.stringify({ title: "Board" }) });
  return res.json();
}

describe("decisions routes", () => {
  test("POST records a decision; GET lists standing decisions", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const res = await app.request(`/api/boards/${board.slug}/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gist: "Use SQLite" }),
    });
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(d.num).toBe(1);
    expect(d.gist).toBe("Use SQLite");

    const list = await (await app.request(`/api/boards/${board.slug}/decisions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].num).toBe(1);
  });

  test("POST with supersedes archives the prior decision", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const first = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "v1" }) })
    ).json();
    const second = await (
      await app.request(`/api/boards/${board.slug}/decisions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ gist: "v2", supersedes: first.num }),
      })
    ).json();
    expect(second.num).toBe(2);

    const standing = await (await app.request(`/api/boards/${board.slug}/decisions`)).json();
    expect(standing.map((d: any) => d.num)).toEqual([2]);

    const all = await (await app.request(`/api/boards/${board.slug}/decisions?archived=all`)).json();
    expect(all).toHaveLength(2);
    const archivedFirst = all.find((d: any) => d.num === first.num);
    expect(archivedFirst.archivedAt).toBeTruthy();
    expect(archivedFirst.supersededBy).toBe(second.num);
  });

  test("supersedes naming an already-archived decision is a 409 conflict", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const first = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "v1" }) })
    ).json();
    await app.request(`/api/boards/${board.slug}/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gist: "v2", supersedes: first.num }),
    });
    const res = await app.request(`/api/boards/${board.slug}/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gist: "v3", supersedes: first.num }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict");
  });

  test("supersedes naming an unknown decision is a 404", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const res = await app.request(`/api/boards/${board.slug}/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ gist: "v1", supersedes: 99 }),
    });
    expect(res.status).toBe(404);
  });

  test("GET filters by archived=1, card and author", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const card = await (
      await app.request(`/api/boards/${board.slug}/cards`, { method: "POST", headers, body: JSON.stringify({ title: "Card" }) })
    ).json();
    const d1 = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "on card", card: card.num }) })
    ).json();
    await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "no card" }) });

    await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({ nums: [d1.num] }) });

    const archivedOnly = await (await app.request(`/api/boards/${board.slug}/decisions?archived=1`)).json();
    expect(archivedOnly.map((d: any) => d.num)).toEqual([d1.num]);

    const byCard = await (await app.request(`/api/boards/${board.slug}/decisions?archived=all&card=${card.num}`)).json();
    expect(byCard.map((d: any) => d.num)).toEqual([d1.num]);

    const byAuthor = await (await app.request(`/api/boards/${board.slug}/decisions?archived=all&author=scout`)).json();
    expect(byAuthor).toHaveLength(2);
  });

  test("POST .../archive with explicit nums archives and returns the changed rows", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const d = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "gone soon" }) })
    ).json();
    const res = await app.request(`/api/boards/${board.slug}/decisions/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nums: [d.num], reason: "stale" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toHaveLength(1);
    expect(body.archived[0].archiveReason).toBe("stale");
  });

  test("POST .../archive with an unknown num is a 404", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const res = await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({ nums: [42] }) });
    expect(res.status).toBe(404);
  });

  test("POST .../archive with no selector at all is a 400", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const res = await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  test("POST .../archive with an empty nums array archives nothing", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    for (const gist of ["keep one", "keep two"]) {
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist }) });
    }
    const res = await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({ nums: [] }) });
    expect(res.status).toBe(200);
    expect((await res.json()).archived).toEqual([]);
    expect(await (await app.request(`/api/boards/${board.slug}/decisions`)).json()).toHaveLength(2);
  });

  test("POST .../restore round-trips an archived decision back to standing", async () => {
    const { app } = fresh();
    const board = await newBoard(app);
    const d = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "will return" }) })
    ).json();
    await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({ nums: [d.num] }) });
    const res = await app.request(`/api/boards/${board.slug}/decisions/restore`, { method: "POST", headers, body: JSON.stringify({ nums: [d.num] }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restored[0].archivedAt).toBeNull();

    const standing = await (await app.request(`/api/boards/${board.slug}/decisions`)).json();
    expect(standing.map((x: any) => x.num)).toEqual([d.num]);
  });

  test("a decision.archived event carries the actor and reaches the events feed", async () => {
    const { app, flock } = fresh();
    const board = await newBoard(app);
    const d = await (
      await app.request(`/api/boards/${board.slug}/decisions`, { method: "POST", headers, body: JSON.stringify({ gist: "watch me" }) })
    ).json();
    await app.request(`/api/boards/${board.slug}/decisions/archive`, { method: "POST", headers, body: JSON.stringify({ nums: [d.num] }) });
    const events = flock.events({ boardId: board.id });
    const archived = events.find((e) => e.type === "decision.archived");
    expect(archived?.actor).toBe("scout");
    expect((archived?.data as any).num).toBe(d.num);
  });
});
