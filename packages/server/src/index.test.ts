import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flock } from "@flock/core";
import { createApp } from "./index.ts";

function fresh() {
  const flock = new Flock(":memory:");
  const app = createApp({ flock, dbPath: ":memory:", push: false });
  return { flock, app };
}

describe("actorOf", () => {
  test("x-flock-harness/model/effort headers land runtime on the emitted event", async () => {
    const { flock, app } = fresh();
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flock-actor": "scout",
        "x-flock-actor-kind": "agent",
        "x-flock-harness": "claude-code@2.1.261",
        "x-flock-model": "Opus-5",
        "x-flock-effort": "HIGH",
      },
      body: JSON.stringify({ title: "Runtime Board" }),
    });
    expect(res.status).toBe(201);
    const board = await res.json();

    const events = flock.events({ boardId: board.id });
    const created = events.find((e) => e.type === "board.created")!;
    expect(created.harness).toBe("claude-code@2.1.261");
    expect(created.model).toBe("opus-5");
    expect(created.effort).toBe("high");

    const actor = flock.listActors().find((a) => a.name === "scout")!;
    expect(actor.model).toBe("opus-5");
  });

  test("no runtime headers means no runtime on the event", async () => {
    const { flock, app } = fresh();
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "Plain Board" }),
    });
    const board = await res.json();
    const events = flock.events({ boardId: board.id });
    const created = events.find((e) => e.type === "board.created")!;
    expect(created.harness).toBeUndefined();
    expect(created.model).toBeUndefined();
    expect(created.effort).toBeUndefined();
  });
});

describe("GET /api/boards", () => {
  test("returns board summaries carrying state, counts, lastEvent and team, plus the base board fields", async () => {
    const { flock, app } = fresh();
    const board = flock.createBoard({ name: "ada", kind: "human" }, { title: "Summaries Board" });
    const card = flock.createCard({ name: "ada", kind: "human" }, board.id, { title: "One" });
    flock.claimCard({ name: "scout", kind: "agent" }, board.id, card.num);

    const res = await app.request("/api/boards");
    expect(res.status).toBe(200);
    const boards = (await res.json()) as any[];
    const b = boards.find((x) => x.id === board.id)!;

    expect(b.id).toBe(board.id);
    expect(b.slug).toBe(board.slug);
    expect(b.title).toBe(board.title);
    expect(b.project).toBe(board.project);
    expect(b.status).toBe(board.status);
    expect(b.state).toBe("working");
    expect(b.counts.doing).toBe(1);
    expect(b.lastEvent.type).toBe("card.claimed");
    expect(Array.isArray(b.team)).toBe(true);
    expect(b.team[0].name).toBe("scout");
    expect(b.doing).toBeInstanceOf(Array);
  });
});

function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

async function makeBoard(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
    body: JSON.stringify({ title: "Attachments Board" }),
  });
  return (await res.json()) as { id: string; slug: string };
}

describe("move / reopen", () => {
  test("reopening a done card without a reason is a 400", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const cardRes = await app.request(`/api/boards/${board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "A card" }),
    });
    const card = await cardRes.json();
    await app.request(`/api/boards/${board.id}/cards/${card.num}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ resolution: "shipped" }),
    });

    const res = await app.request(`/api/boards/${board.id}/cards/${card.num}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ status: "todo" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reason/i);

    const stillDone = await app.request(`/api/boards/${board.id}/cards/${card.num}`);
    expect((await stillDone.json()).card.status).toBe("done");
  });

  test("reopening with a reason succeeds and the reason lands as a comment", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const cardRes = await app.request(`/api/boards/${board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "A card" }),
    });
    const card = await cardRes.json();
    await app.request(`/api/boards/${board.id}/cards/${card.num}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ resolution: "shipped" }),
    });

    const res = await app.request(`/api/boards/${board.id}/cards/${card.num}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ status: "todo", reason: "the fix regressed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("todo");

    const detail = await (await app.request(`/api/boards/${board.id}/cards/${card.num}`)).json();
    expect(detail.comments.some((c: any) => c.body === "the fix regressed")).toBe(true);
  });
});

describe("attachments", () => {
  test("POST raw bytes returns 201 + JSON meta", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const bytes = pngBytes(128);
    const res = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(bytes),
    });
    expect(res.status).toBe(201);
    const meta = await res.json();
    expect(meta.mime).toBe("image/png");
    expect(meta.size).toBe(128);
    expect(meta).not.toHaveProperty("bytes");
  });

  test("GET returns identical bytes with the right content-type and immutable cache-control", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const bytes = pngBytes(200);
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(bytes),
    });
    const meta = await postRes.json();
    const getRes = await app.request(`/api/boards/${board.id}/attachments/${meta.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(getRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(getRes.headers.get("etag")).toBeTruthy();
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect([...got]).toEqual([...bytes]);
  });

  test("GET with the wrong board is 404", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const other = await makeBoard(app);
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(pngBytes()),
    });
    const meta = await postRes.json();
    const getRes = await app.request(`/api/boards/${other.id}/attachments/${meta.id}`);
    expect(getRes.status).toBe(404);
  });

  test("POST message with attachments returns 201 and carries them", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(pngBytes()),
    });
    const att = await postRes.json();
    const msgRes = await app.request(`/api/boards/${board.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "a picture", attachments: [att.id] }),
    });
    expect(msgRes.status).toBe(201);
    const msg = await msgRes.json();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].id).toBe(att.id);
  });

  test("POST message with empty body + one attachment is 201", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(pngBytes()),
    });
    const att = await postRes.json();
    const msgRes = await app.request(`/api/boards/${board.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "", attachments: [att.id] }),
    });
    expect(msgRes.status).toBe(201);
  });

  test("POST comment with attachments returns them, and the attachment fetches back", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const cardRes = await app.request(`/api/boards/${board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "A card" }),
    });
    const card = await cardRes.json();
    const bytes = pngBytes(96);
    const attRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(bytes),
    });
    const att = await attRes.json();
    const res = await app.request(`/api/boards/${board.id}/cards/${card.num}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "a picture", attachments: [att.id] }),
    });
    expect(res.status).toBe(200);
    const comment = await res.json();
    expect(comment.attachments).toHaveLength(1);
    expect(comment.attachments[0].id).toBe(att.id);
    expect(comment.attachments[0]).not.toHaveProperty("bytes");

    // GET /cards/:n hands the same attachments back with the thread.
    const cardGet = await app.request(`/api/boards/${board.id}/cards/${card.num}`);
    const detail = await cardGet.json();
    expect(detail.comments[0].attachments[0].id).toBe(att.id);

    // The one attachment route serves comment attachments as well as message ones.
    const getRes = await app.request(`/api/boards/${board.id}/attachments/${att.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await getRes.arrayBuffer())]).toEqual([...bytes]);
  });

  test("POST comment with empty body + one attachment is accepted; with neither is 400", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const cardRes = await app.request(`/api/boards/${board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "A card" }),
    });
    const card = await cardRes.json();
    const attRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: Buffer.from(pngBytes()),
    });
    const att = await attRes.json();
    const ok = await app.request(`/api/boards/${board.id}/cards/${card.num}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "", attachments: [att.id] }),
    });
    expect(ok.status).toBe(200);
    const bad = await app.request(`/api/boards/${board.id}/cards/${card.num}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "   " }),
    });
    expect(bad.status).toBe(400);
    const notAList = await app.request(`/api/boards/${board.id}/cards/${card.num}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ body: "hi", attachments: "nope" }),
    });
    expect(notAList.status).toBe(400);
  });

  test("oversized POST is 413", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const res = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "content-length": String(5 * 1024 * 1024 + 1),
        "x-flock-actor": "scout",
        "x-flock-actor-kind": "agent",
      },
      body: Buffer.from(pngBytes()),
    });
    expect(res.status).toBe(413);
  });

  test("a body over the cap is rejected even when content-length lies (streamed, not fully buffered)", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const cap = 5 * 1024 * 1024;
    const over = pngBytes(cap + 1024);
    // A stream body has no content-length header at all, so the fast-path guard can't catch
    // it; this exercises the chunk-by-chunk read-and-abort path instead.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunkSize = 64 * 1024;
        for (let i = 0; i < over.length; i += chunkSize) controller.enqueue(over.subarray(i, i + chunkSize));
        controller.close();
      },
    });
    const req = new Request(`http://local/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: stream,
      // @ts-expect-error - required by undici to send a streaming body
      duplex: "half",
    });
    const res = await app.request(req);
    expect(res.status).toBe(413);
  });

  test("a CRLF-laden filename does not 500 on GET; sanitized name is stored and served safely", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-flock-actor": "scout",
        "x-flock-actor-kind": "agent",
        "x-flock-filename": encodeURIComponent('evil\r\nX-Injected: 1"\\.png'),
      },
      body: Buffer.from(pngBytes()),
    });
    expect(postRes.status).toBe(201);
    const meta = await postRes.json();
    expect(meta.name).not.toMatch(/[\r\n"\\]/);

    const getRes = await app.request(`/api/boards/${board.id}/attachments/${meta.id}`);
    expect(getRes.status).toBe(200);
    const disposition = getRes.headers.get("content-disposition")!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain('filename*=UTF-8\'\'evil.html');
  });

  test("attaching a filename that attempts content-disposition parameter injection is served as a single inert param", async () => {
    const { app } = fresh();
    const board = await makeBoard(app);
    const injected = 'a"; filename*=UTF-8\'\'evil.html; x="';
    const postRes = await app.request(`/api/boards/${board.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-flock-actor": "scout",
        "x-flock-actor-kind": "agent",
        "x-flock-filename": encodeURIComponent(injected),
      },
      body: Buffer.from(pngBytes()),
    });
    const meta = await postRes.json();
    const getRes = await app.request(`/api/boards/${board.id}/attachments/${meta.id}`);
    const disposition = getRes.headers.get("content-disposition")!;
    // Sanitization strips quotes/backslashes at the core, so the attacker's payload can no
    // longer close the quoted filename value early: the whole thing must come back as one
    // inert quoted string, not a real second `filename*` parameter.
    expect(disposition).toMatch(/^inline; filename="[^"]*"$/);
  });
});

describe("board-creation hook routes", () => {
  let hooksDir: string;
  const priorHooksDir = process.env.FLOCK_HOOKS_DIR;

  beforeEach(() => {
    hooksDir = mkdtempSync(join(tmpdir(), "flock-server-hooks-"));
    process.env.FLOCK_HOOKS_DIR = hooksDir;
  });

  afterEach(() => {
    if (priorHooksDir === undefined) delete process.env.FLOCK_HOOKS_DIR;
    else process.env.FLOCK_HOOKS_DIR = priorHooksDir;
    rmSync(hooksDir, { recursive: true, force: true });
  });

  function installHook(script: string) {
    const path = join(hooksDir, "board-create");
    writeFileSync(path, script);
    chmodSync(path, 0o700);
  }

  test("no hook: GET reports disabled, POST reports 404 no_hook", async () => {
    const { app } = fresh();

    const getRes = await app.request("/api/hooks/board-create");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ enabled: false });

    const postRes = await app.request("/api/boards/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-hook": "1" },
      body: JSON.stringify({ title: "New board", inputs: {} }),
    });
    expect(postRes.status).toBe(404);
    const body = await postRes.json();
    expect(body.code).toBe("no_hook");
  });

  test("POST without x-flock-hook header is a 403 hook_header_required, before the hook even runs", async () => {
    installHook(`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  create) echo "should not run" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`);
    const { app } = fresh();
    const res = await app.request("/api/boards/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hooked board", inputs: {} }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "x-flock-hook header required", code: "hook_header_required" });
  });

  test("POST with x-flock-hook header runs the hook as before", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-server-project-"));
    try {
      installHook(`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  create)
    printf '{"project":"${projectDir}"}\\n'
    ;;
  *) exit 0 ;;
esac
`);
      const { app } = fresh();
      const res = await app.request("/api/boards/hook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-flock-hook": "1" },
        body: JSON.stringify({ title: "Hooked board", inputs: {} }),
      });
      expect(res.status).toBe(201);
      const board = await res.json();
      expect(board.title).toBe("Hooked board");
      expect(board.project).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("describe: GET runs the hook and returns its declared fields", async () => {
    installHook(`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  describe)
    echo '{"title":"New workspace","submit":"Create","fields":[{"name":"repo","label":"Repository","type":"text","required":true}]}'
    ;;
  *) exit 1 ;;
esac
`);
    const { app } = fresh();
    const res = await app.request("/api/hooks/board-create");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.title).toBe("New workspace");
    expect(body.submit).toBe("Create");
    expect(body.fields).toEqual([{ name: "repo", label: "Repository", type: "text", required: true }]);
  });

  test("describe failing degrades to enabled with empty fields and a warning", async () => {
    installHook(`#!/usr/bin/env bash
case "\${1:-}" in
  describe) echo "boom" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`);
    const { app } = fresh();
    const res = await app.request("/api/hooks/board-create");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: true, fields: [], warning: expect.any(String) });
  });

  test("create returning a project directory produces a 201 board scoped to it", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-server-project-"));
    try {
      installHook(`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  create)
    printf '{"project":"${projectDir}"}\\n'
    ;;
  *) exit 0 ;;
esac
`);
      const { app } = fresh();
      const res = await app.request("/api/boards/hook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent", "x-flock-hook": "1" },
        body: JSON.stringify({ title: "Hooked board", inputs: {} }),
      });
      expect(res.status).toBe(201);
      const board = await res.json();
      expect(board.title).toBe("Hooked board");
      // The hook route canonicalizes the path it is handed (symlinks resolved), so the board key
      // matches what `flock` run from inside that directory resolves process.cwd() to.
      expect(board.project).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("create exiting non-zero is a 502 hook_failed carrying stderr", async () => {
    installHook(`#!/usr/bin/env bash
case "\${1:-}" in
  create) echo "nb ws create failed" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`);
    const { app } = fresh();
    const res = await app.request("/api/boards/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-hook": "1" },
      body: JSON.stringify({ title: "Hooked board", inputs: {} }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("hook_failed");
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toContain("nb ws create failed");
  });

  test("create returning invalid output is a 502 hook_output_invalid", async () => {
    installHook(`#!/usr/bin/env bash
case "\${1:-}" in
  create) echo "not json" ;;
  *) exit 0 ;;
esac
`);
    const { app } = fresh();
    const res = await app.request("/api/boards/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-hook": "1" },
      body: JSON.stringify({ title: "Hooked board", inputs: {} }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("hook_output_invalid");
  });

  test("POST /api/boards accepts an optional project field, canonicalized", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flock-server-project-"));
    try {
      const { app } = fresh();
      const res = await app.request("/api/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Plain project board", project: `${projectDir}/` }),
      });
      expect(res.status).toBe(201);
      const board = await res.json();
      expect(board.project).toBe(realpathSync(projectDir));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("POST /api/boards/import rejects a relative project too", async () => {
    const { app } = fresh();
    const res = await app.request("/api/boards/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "# Imported\n", project: "./somewhere" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("absolute");
  });

  test("POST /api/boards rejects a relative project with a 400 rather than resolving it against the server's cwd", async () => {
    const { app } = fresh();
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Relative", project: "../../etc" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid");
    expect(body.error).toContain("absolute");
    expect(await (await app.request("/api/boards")).json()).toEqual([]);
  });

  test("POST /api/boards treats a blank project as none", async () => {
    const { app } = fresh();
    const res = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Blank project", project: "   " }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).project).toBe(null);
  });
});

describe("DELETE /api/boards/:b", () => {
  test("204 and the board is gone", async () => {
    const { flock, app } = fresh();
    const board = await makeBoard(app);
    const res = await app.request(`/api/boards/${board.slug}`, {
      method: "DELETE",
      headers: { "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(flock.findBoard(board.slug)).toBeNull();
    expect((await app.request(`/api/boards/${board.slug}`)).status).toBe(404);
  });

  test("404 for an unknown board", async () => {
    const { app } = fresh();
    const res = await app.request("/api/boards/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("honours the actor headers", async () => {
    const { flock, app } = fresh();
    const board = await makeBoard(app);
    await app.request(`/api/boards/${board.slug}`, {
      method: "DELETE",
      headers: { "x-flock-actor": "reaper", "x-flock-actor-kind": "agent" },
    });
    const actor = flock.listActors().find((a) => a.name === "reaper")!;
    expect(actor.kind).toBe("agent");
  });
});

describe("PATCH /api/boards/:b", () => {
  test("renames the board and honours the actor headers", async () => {
    const { flock, app } = fresh();
    const board = await makeBoard(app);
    const res = await app.request(`/api/boards/${board.slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-flock-actor": "renamer", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ title: "Renamed Board" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe("Renamed Board");
    expect(flock.board(board.id).title).toBe("Renamed Board");

    const events = flock.events({ boardId: board.id });
    const emitted = events.find((e) => e.type === "board.updated")!;
    expect(emitted.actor).toBe("renamer");
  });

  test("404 for an unknown board", async () => {
    const { app } = fresh();
    const res = await app.request("/api/boards/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

describe("GET /api/boards/:b/actors/:name", () => {
  test("returns the actor with every card they touched and the roles they played", async () => {
    const { flock, app } = fresh();
    const ada = { name: "ada", kind: "human" as const };
    const scout = { name: "scout", kind: "agent" as const, model: "opus-5" };
    const board = flock.createBoard(ada, { title: "Actor Board" });
    const held = flock.createCard(ada, board.id, { title: "Held" });
    const spoke = flock.createCard(ada, board.id, { title: "Spoke" });
    flock.claimCard(scout, board.id, held.num);
    flock.addComment(scout, board.id, spoke.num, "a note");

    const res = await app.request(`/api/boards/${board.slug}/actors/scout`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.name).toBe("scout");
    expect(p.kind).toBe("agent");
    expect(p.model).toBe("opus-5");
    expect(p.cards.map((c: { num: number }) => c.num).sort()).toEqual([held.num, spoke.num].sort());
    expect(p.cards.find((c: { num: number }) => c.num === held.num).roles).toEqual(["holding", "claimed"]);
  });

  test("404 for someone this board has never seen, and names with spaces survive the URL", async () => {
    const { flock, app } = fresh();
    const ada = { name: "ada", kind: "human" as const };
    const board = flock.createBoard({ name: "Ada Lovelace", kind: "human" }, { title: "Names" });
    flock.createCard(ada, board.id, { title: "One" });

    expect((await app.request(`/api/boards/${board.slug}/actors/ghost`)).status).toBe(404);
    const res = await app.request(`/api/boards/${board.slug}/actors/${encodeURIComponent("Ada Lovelace")}`);
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Ada Lovelace");
  });
});

describe("POST /api/boards/:b/cards/:n/hold and /unhold", () => {
  test("hold sets held state via actor headers; claim after is 409; unhold then claim succeeds", async () => {
    const { flock, app } = fresh();
    const ada = { name: "ada", kind: "human" as const };
    const board = flock.createBoard(ada, { title: "Hold Board" });
    const card = flock.createCard(ada, board.id, { title: "Do the thing" });

    const holdRes = await app.request(`/api/boards/${board.slug}/cards/${card.num}/hold`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "rob", "x-flock-actor-kind": "human" },
      body: JSON.stringify({ reason: "waiting on design" }),
    });
    expect(holdRes.status).toBe(200);
    const held = await holdRes.json();
    expect(held.held).toBe(true);
    expect(held.heldBy).toBe("rob");
    expect(held.holdReason).toBe("waiting on design");

    const claimRes = await app.request(`/api/boards/${board.slug}/cards/${card.num}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({}),
    });
    expect(claimRes.status).toBe(409);
    const err = await claimRes.json();
    expect(err.error).toContain("is on hold");

    // --force must not override a hold.
    const forcedRes = await app.request(`/api/boards/${board.slug}/cards/${card.num}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({ force: true }),
    });
    expect(forcedRes.status).toBe(409);

    const unholdRes = await app.request(`/api/boards/${board.slug}/cards/${card.num}/unhold`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "rob", "x-flock-actor-kind": "human" },
    });
    expect(unholdRes.status).toBe(200);
    const unheld = await unholdRes.json();
    expect(unheld.held).toBe(false);

    const claimAgain = await app.request(`/api/boards/${board.slug}/cards/${card.num}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flock-actor": "scout", "x-flock-actor-kind": "agent" },
      body: JSON.stringify({}),
    });
    expect(claimAgain.status).toBe(200);
  });

  test("hold with no body/reason is accepted; unhold on an unheld card is a no-op 200", async () => {
    const { flock, app } = fresh();
    const ada = { name: "ada", kind: "human" as const };
    const board = flock.createBoard(ada, { title: "Hold Board 2" });
    const card = flock.createCard(ada, board.id, { title: "Another" });

    const holdRes = await app.request(`/api/boards/${board.slug}/cards/${card.num}/hold`, {
      method: "POST",
      headers: { "x-flock-actor": "rob", "x-flock-actor-kind": "human" },
    });
    expect(holdRes.status).toBe(200);
    const held = await holdRes.json();
    expect(held.held).toBe(true);
    expect(held.holdReason).toBeNull();

    await app.request(`/api/boards/${board.slug}/cards/${card.num}/unhold`, {
      method: "POST",
      headers: { "x-flock-actor": "rob", "x-flock-actor-kind": "human" },
    });
    const again = await app.request(`/api/boards/${board.slug}/cards/${card.num}/unhold`, {
      method: "POST",
      headers: { "x-flock-actor": "rob", "x-flock-actor-kind": "human" },
    });
    expect(again.status).toBe(200);
    expect((await again.json()).held).toBe(false);
  });
});
