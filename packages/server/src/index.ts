import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, extname, isAbsolute, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import {
  Flock,
  FlockError,
  HookError,
  MAX_ATTACHMENT_BYTES,
  exportBoard,
  findHook,
  importBoard,
  mergeBoardInput,
  normalizeFields,
  normalizeRuntime,
  parseHookOutput,
  runHook,
  DB_DIRNAME,
  type Actor,
  type CardStatus,
  type DecisionSelector,
  type HookRef,
} from "@flock/core";
import { defaultSend, loadOrCreateVapidKeys, startPushPump, type PushPump, type PushSend } from "./push.ts";

const BOARD_CREATE_HOOK = "board-create";

export interface ServerOptions {
  flock: Flock;
  dbPath: string;
  /** Directory holding the built web app (index.html + assets). Optional. */
  staticDir?: string;
  /**
   * Request path ("/index.html", "/assets/index-abc.js") to the file's location on disk. Set by a
   * compiled binary, where the web app is embedded and `staticDir` points into `/$bunfs` at
   * nothing. Preferred over `staticDir` when present. See `scripts/gen-assets.ts`.
   */
  assets?: Record<string, string>;
  /**
   * Absolute path to `scripts/install.sh`. Set by the CLI from `runtime.ts`'s embedded import,
   * which works in both a checkout and a compiled binary — unlike resolving it from
   * `import.meta.dir`, which points into `/$bunfs` at nothing inside a binary. Missing or unset
   * makes `GET /install.sh` 404, which keeps that route testable.
   */
  installScriptPath?: string;
  /** flockHome(): where VAPID keys are read and written. Defaults to ~/.flock when absent. */
  flockHome?: string;
  /** Off switch. Default true. `FLOCK_NO_PUSH=1` also turns it off. */
  push?: boolean;
  /** Test seam: replaces the pump's real web-push sender. Ignored when push is disabled. */
  pushSend?: PushSend;
}

function defaultHuman(): string {
  try {
    return process.env.FLOCK_ACTOR ?? userInfo().username;
  } catch {
    return "human";
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * Read a request body while enforcing a byte cap without buffering past it. A declared
 * `content-length` over the cap is rejected immediately; otherwise the body is read chunk
 * by chunk (since `content-length` can be absent, non-numeric, chunked, or simply wrong)
 * and aborted the moment the running total exceeds the cap.
 */
async function readBoundedBody(req: Request, cap: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > cap) {
      throw new FlockError(`attachment is ${n} bytes; the limit is 5 MiB`, "invalid", 413);
    }
  }
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new FlockError(`attachment exceeds the limit of 5 MiB`, "invalid", 413);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** RFC 6266 content-disposition: a plain ASCII filename when safe, else the encoded `filename*` form. */
function contentDispositionFor(name: string): string {
  const isSafeAscii = /^[\x20-\x7e]+$/.test(name) && !/["\\]/.test(name);
  if (isSafeAscii) return `inline; filename="${name}"`;
  return `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The `project` of a board-creating request. It must be absolute: core resolves a relative path
 * against `process.cwd()`, which over HTTP is the *server's* working directory, so `"../etc"` would
 * quietly scope the board to a directory the caller never named. An existing path is canonicalized
 * (symlinks, `..`, trailing slashes) exactly as core does for a hook's `project`, so the board key
 * matches the `process.cwd()` the CLI sees from inside that directory. A path that does not exist
 * yet is left as given: `flock board new --project` allows one, and this route is not stricter.
 */
function requestProject(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new FlockError("project must be a string", "invalid");
  const project = raw.trim();
  if (!project) return undefined;
  if (!isAbsolute(project)) throw new FlockError(`project must be an absolute path, got "${project}"`, "invalid");
  try {
    const canonical = realpathSync(project);
    if (statSync(canonical).isDirectory()) return canonical;
  } catch {
    // Not there yet; keep what the caller asked for rather than inventing a directory.
  }
  return project;
}

/** The selector shared by the archive and restore routes. A body naming no field is rejected: core
 *  treats an empty selector as `invalid` too, but rejecting here keeps the 400 message specific. */
function decisionSelector(body: Record<string, unknown>): DecisionSelector {
  const { nums, card, author, before } = body as DecisionSelector;
  if (nums === undefined && card === undefined && author === undefined && before === undefined) {
    throw new FlockError("a selector is required");
  }
  return { nums, card, author, before };
}

/** A hook's stderr is only interesting to the operator on success; on failure it goes to the client. */
function logHookStderr(mode: string, stderr: string): void {
  if (stderr.trim()) console.error(`[${BOARD_CREATE_HOOK} ${mode}] ${stderr}`);
}

export function createApp({ flock, dbPath, staticDir, assets, installScriptPath, flockHome, push, pushSend }: ServerOptions) {
  const app = new Hono();
  app.use("/api/*", cors());

  const pushEnabled = (push ?? true) && process.env.FLOCK_NO_PUSH !== "1";
  const resolvedHome = flockHome ?? (process.env.FLOCK_HOME ? resolve(process.env.FLOCK_HOME) : join(homedir(), DB_DIRNAME));
  const vapid = pushEnabled ? loadOrCreateVapidKeys(resolvedHome) : null;
  const send: PushSend | null = vapid ? (pushSend ?? defaultSend(vapid)) : null;
  let pump: PushPump | null = null;
  if (vapid && send) {
    pump = startPushPump({ flock, keys: vapid, send });
  }

  const actorOf = (c: { req: { header(n: string): string | undefined } }): Actor => {
    const name = c.req.header("x-flock-actor")?.trim() || defaultHuman();
    const kind = c.req.header("x-flock-actor-kind") === "agent" ? "agent" : "human";
    const runtime = normalizeRuntime({
      harness: c.req.header("x-flock-harness"),
      model: c.req.header("x-flock-model"),
      effort: c.req.header("x-flock-effort"),
    });
    return { name, kind, ...runtime };
  };

  app.onError((err, c) => {
    if (err instanceof FlockError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message ?? "internal error", code: "internal" }, 500);
  });

  app.get("/api/me", (c) => c.json({ actor: actorOf(c), dbPath }));
  app.get("/api/actors", (c) => c.json(flock.listActors()));
  app.get("/api/needs-me", (c) => c.json(flock.needsHuman()));

  // ----- boards -----
  app.get("/api/boards", (c) => c.json(flock.boardSummaries({ includeArchived: c.req.query("all") === "1" })));
  app.post("/api/boards", async (c) => {
    const body = await c.req.json<{ title: string; slug?: string; body?: string; project?: string }>();
    if (!body.title?.trim()) throw new FlockError("title is required");
    return c.json(flock.createBoard(actorOf(c), { ...body, project: requestProject(body.project) ?? null }), 201);
  });

  // ----- board-creation hook -----
  app.get("/api/hooks/board-create", async (c) => {
    let ref: HookRef | null;
    try {
      ref = findHook(BOARD_CREATE_HOOK);
    } catch (err) {
      if (err instanceof HookError) return c.json({ enabled: false, warning: err.message });
      throw err;
    }
    if (!ref) return c.json({ enabled: false });

    // No explicit timeout: core's per-mode default is 5s for `describe`, and leaving it unset is
    // what lets FLOCK_HOOK_TIMEOUT_MS override it, as docs/hooks/board-create.md promises.
    const result = await runHook(ref.path, "describe", { event: BOARD_CREATE_HOOK, actor: actorOf(c), dbPath });
    logHookStderr("describe", result.stderr);
    if (!result.ok) {
      return c.json({
        enabled: true,
        fields: [],
        warning: result.timedOut ? "describe timed out" : `describe exited ${result.exitCode}`,
      });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseHookOutput(result.stdout);
    } catch (err) {
      return c.json({ enabled: true, fields: [], warning: err instanceof Error ? err.message : "invalid describe output" });
    }
    return c.json({ enabled: true, ...normalizeFields(parsed) });
  });

  app.post("/api/boards/hook", async (c) => {
    if (c.req.header("x-flock-hook") !== "1") {
      return c.json({ error: "x-flock-hook header required", code: "hook_header_required" }, 403);
    }
    const body = await c.req.json<{ title?: string; inputs?: Record<string, string | boolean | number> }>();
    if (!body.title?.trim()) throw new FlockError("title is required");

    let ref: HookRef | null;
    try {
      ref = findHook(BOARD_CREATE_HOOK);
    } catch (err) {
      if (err instanceof HookError) return c.json({ error: err.message, code: err.code }, 502);
      throw err;
    }
    if (!ref) return c.json({ error: `no "${BOARD_CREATE_HOOK}" hook is installed`, code: "no_hook" }, 404);

    const actor = actorOf(c);
    const result = await runHook(ref.path, "create", { event: BOARD_CREATE_HOOK, actor, title: body.title, inputs: body.inputs ?? {}, dbPath });
    if (!result.ok) {
      return c.json(
        {
          error: result.timedOut ? "board-create hook timed out" : `board-create hook exited ${result.exitCode}`,
          code: result.timedOut ? "hook_timeout" : "hook_failed",
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
        502,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseHookOutput(result.stdout);
    } catch (err) {
      if (err instanceof HookError) {
        return c.json({ error: err.message, code: err.code, exitCode: result.exitCode, stderr: result.stderr }, 502);
      }
      throw err;
    }

    logHookStderr("create", result.stderr);
    const merged = mergeBoardInput({ title: body.title }, parsed);
    if (!merged.title?.trim()) throw new FlockError("hook output cleared the required title");
    return c.json(flock.createBoard(actor, { ...merged, title: merged.title }), 201);
  });

  app.post("/api/boards/import", async (c) => {
    const body = await c.req.json<{ markdown: string; slug?: string; title?: string; project?: string }>();
    // The whole body reaches importBoard, so `project` gets the same absolute-path rule as above.
    const warnings: string[] = [];
    const board = importBoard(flock, actorOf(c), body.markdown, { ...body, project: requestProject(body.project) ?? null, warnings });
    for (const w of warnings) console.error(`[board import] warning: ${w}`);
    return c.json(board, 201);
  });
  app.get("/api/boards/:b", (c) => c.json(flock.snapshot(c.req.param("b"))));
  app.patch("/api/boards/:b", async (c) => c.json(flock.updateBoard(actorOf(c), c.req.param("b"), await c.req.json())));
  app.delete("/api/boards/:b", (c) => {
    flock.deleteBoard(actorOf(c), c.req.param("b"));
    return c.body(null, 204);
  });
  // One actor as this board knows them, for the web's actor sheet: mirrors Flock.actorProfile.
  app.get("/api/boards/:b/actors/:name", (c) => c.json(flock.actorProfile(c.req.param("b"), decodeURIComponent(c.req.param("name")))));
  app.get("/api/boards/:b/export", (c) => c.text(exportBoard(flock, c.req.param("b")), 200, { "content-type": "text/markdown; charset=utf-8" }));

  // ----- cards -----
  app.get("/api/boards/:b/cards", (c) => {
    const q = c.req.query();
    return c.json(
      flock.listCards(c.req.param("b"), {
        status: q.status ? (q.status.split(",") as CardStatus[]) : undefined,
        assignee: q.assignee,
        label: q.label,
        frontier: q.frontier === "1" || q.frontier === "true",
        open: q.open === "1" || q.open === "true",
        held: q.held === "1" || q.held === "true" ? true : undefined,
      }),
    );
  });
  app.post("/api/boards/:b/cards", async (c) => {
    const body = await c.req.json();
    if (!body.title?.trim()) throw new FlockError("title is required");
    return c.json(flock.createCard(actorOf(c), c.req.param("b"), body), 201);
  });
  app.get("/api/boards/:b/cards/:n", (c) => {
    const b = c.req.param("b");
    const n = c.req.param("n");
    return c.json({ card: flock.card(b, n), comments: flock.comments(b, n), blocks: flock.dependents(b, n).map((d) => d.num) });
  });
  app.patch("/api/boards/:b/cards/:n", async (c) => c.json(flock.updateCard(actorOf(c), c.req.param("b"), c.req.param("n"), await c.req.json())));

  const cardAction = (name: string, fn: (actor: Actor, b: string, n: string, body: any) => unknown) =>
    app.post(`/api/boards/:b/cards/:n/${name}`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(fn(actorOf(c), c.req.param("b"), c.req.param("n"), body));
    });
  cardAction("claim", (a, b, n, body) => flock.claimCard(a, b, n, { force: !!body.force }));
  cardAction("release", (a, b, n) => flock.releaseCard(a, b, n));
  cardAction("hold", (a, b, n, body) => flock.holdCard(a, b, n, { reason: body.reason }));
  cardAction("unhold", (a, b, n) => flock.unholdCard(a, b, n));
  cardAction("toggle-task", (a, b, n, body) =>
    flock.toggleCardTask(a, b, n, Number(body.index), typeof body.checked === "boolean" ? body.checked : undefined),
  );
  cardAction("assign", (a, b, n, body) => flock.assignCard(a, b, n, body.assignee ?? null));
  cardAction("move", (a, b, n, body) => flock.moveCard(a, b, n, body.status, { reason: body.reason, attachments: body.attachments }));
  cardAction("close", (a, b, n, body) => flock.closeCard(a, b, n, { resolution: body.resolution, status: body.status }));
  cardAction("ask", (a, b, n, body) => {
    if (!body.question?.trim()) throw new FlockError("question is required");
    return flock.askHuman(a, b, n, body.question);
  });
  cardAction("answer", (a, b, n, body) => {
    if (!body.answer?.trim()) throw new FlockError("answer is required");
    return flock.answerHuman(a, b, n, body.answer);
  });
  cardAction("comments", (a, b, n, body) => {
    // The same shape the channel's POST takes: ids from /attachments, bound to this comment.
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((x: unknown) => typeof x !== "string"))) {
      throw new FlockError("attachments must be an array of ids");
    }
    if (!body.body?.trim() && !body.attachments?.length) throw new FlockError("body or attachments is required");
    return flock.addComment(a, b, n, body.body ?? "", body.kind ?? "comment", { attachments: body.attachments });
  });
  cardAction("blockers", (a, b, n, body) => flock.addBlocker(a, b, n, body.by));
  app.delete("/api/boards/:b/cards/:n/blockers/:by", (c) =>
    c.json(flock.removeBlocker(actorOf(c), c.req.param("b"), c.req.param("n"), c.req.param("by"))),
  );

  // ----- attachments -----
  app.post("/api/boards/:b/attachments", async (c) => {
    const mime = c.req.header("content-type") ?? "application/octet-stream";
    const bytes = await readBoundedBody(c.req.raw, MAX_ATTACHMENT_BYTES);
    const widthHeader = c.req.header("x-flock-width");
    const heightHeader = c.req.header("x-flock-height");
    let name: string | null = null;
    const rawName = c.req.header("x-flock-filename");
    if (rawName) {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = null;
      }
    }
    const att = flock.attach(actorOf(c), c.req.param("b"), {
      mime,
      bytes,
      name,
      width: widthHeader ? Number(widthHeader) : null,
      height: heightHeader ? Number(heightHeader) : null,
    });
    return c.json(att, 201);
  });
  app.get("/api/boards/:b/attachments/:id", (c) => {
    const { meta, bytes } = flock.attachment(c.req.param("b"), c.req.param("id"));
    const etag = `"${meta.sha256.slice(0, 16)}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const headers: Record<string, string> = {
      "content-type": meta.mime,
      "content-length": String(meta.size),
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
    };
    if (meta.name) headers["content-disposition"] = contentDispositionFor(meta.name);
    return c.body(Buffer.from(bytes), 200, headers);
  });

  // ----- channel + decisions -----
  app.get("/api/boards/:b/messages", (c) => c.json(flock.messages(c.req.param("b"), { limit: Number(c.req.query("limit") ?? 200) })));
  app.post("/api/boards/:b/messages", async (c) => {
    const body = await c.req.json();
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((a: unknown) => typeof a !== "string"))) {
      throw new FlockError("attachments must be an array of ids");
    }
    if (!body.body?.trim() && !body.attachments?.length) throw new FlockError("body or attachments is required");
    return c.json(flock.say(actorOf(c), c.req.param("b"), body.body ?? "", { attachments: body.attachments }), 201);
  });
  app.get("/api/boards/:b/decisions", (c) => {
    const archivedQ = c.req.query("archived");
    const archived: boolean | "all" | undefined = archivedQ === "all" ? "all" : archivedQ === "1" ? true : undefined;
    const cardQ = c.req.query("card");
    return c.json(
      flock.decisions(c.req.param("b"), {
        archived,
        card: cardQ !== undefined ? Number(cardQ) : undefined,
        author: c.req.query("author"),
      }),
    );
  });
  app.post("/api/boards/:b/decisions", async (c) => {
    const body = await c.req.json();
    if (!body.gist?.trim()) throw new FlockError("gist is required");
    return c.json(
      flock.decide(actorOf(c), c.req.param("b"), body.gist, body.card ?? null, {
        supersedes: body.supersedes !== undefined ? Number(body.supersedes) : undefined,
      }),
      201,
    );
  });
  app.post("/api/boards/:b/decisions/archive", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const changed = flock.archiveDecisions(actorOf(c), c.req.param("b"), decisionSelector(body), { reason: body.reason });
    return c.json({ archived: changed });
  });
  app.post("/api/boards/:b/decisions/restore", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const changed = flock.restoreDecisions(actorOf(c), c.req.param("b"), decisionSelector(body));
    return c.json({ restored: changed });
  });

  // ----- events -----
  app.get("/api/boards/:b/events", async (c) => {
    const board = flock.board(c.req.param("b"));
    const since = Number(c.req.query("since") ?? 0);
    if (c.req.query("wait") === "1") {
      return c.json(await flock.waitForEvents({ boardId: board.id, since, timeoutMs: Number(c.req.query("timeout") ?? 30000) }));
    }
    if (c.req.query("tail") === "1") {
      return c.json(flock.events({ boardId: board.id, tail: true, limit: Number(c.req.query("limit") ?? 500) }));
    }
    return c.json(flock.events({ boardId: board.id, since }));
  });
  app.get("/api/events", (c) => c.json(flock.events({ since: Number(c.req.query("since") ?? 0) })));

  const sse = (boardId: string | undefined) => (c: any) =>
    streamSSE(c, async (stream) => {
      let since = Number(c.req.query("since") ?? flock.lastSeq(boardId));
      let alive = true;
      stream.onAbort(() => {
        alive = false;
      });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ since }) });
      let ticks = 0;
      while (alive) {
        const events = flock.events({ boardId, since });
        for (const e of events) {
          since = e.seq;
          await stream.writeSSE({ event: e.type, id: String(e.seq), data: JSON.stringify(e) });
        }
        if (++ticks % 30 === 0) await stream.writeSSE({ event: "ping", data: "{}" });
        await stream.sleep(500);
      }
    });
  app.get("/api/boards/:b/stream", (c) => sse(flock.board(c.req.param("b")).id)(c));
  app.get("/api/stream", (c) => sse(undefined)(c));

  // ----- push -----
  app.get("/api/push/key", (c) => {
    if (!vapid) return c.json({ enabled: false, reason: "push is disabled" });
    return c.json({ enabled: true, publicKey: vapid.publicKey });
  });
  app.get("/api/push/subscriptions", (c) =>
    c.json(flock.pushSubscriptions({ actor: actorOf(c).name }).map(({ keys, ...rest }) => rest)),
  );
  app.post("/api/push/subscriptions", async (c) => {
    const body = await c.req.json<{
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
      boardId?: string | null;
      userAgent?: string | null;
    }>();
    if (typeof body.endpoint !== "string" || !body.endpoint) throw new FlockError("endpoint is required", "invalid");
    if (typeof body.keys?.p256dh !== "string" || !body.keys.p256dh) throw new FlockError("keys.p256dh is required", "invalid");
    if (typeof body.keys?.auth !== "string" || !body.keys.auth) throw new FlockError("keys.auth is required", "invalid");
    const record = flock.subscribePush(actorOf(c), {
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      boardId: body.boardId ?? null,
      userAgent: body.userAgent ?? null,
    });
    const { keys, ...rest } = record;
    return c.json(rest, 201);
  });
  app.delete("/api/push/subscriptions", async (c) => {
    const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
    if (typeof body.endpoint === "string" && body.endpoint) flock.unsubscribePush(body.endpoint);
    return c.body(null, 204);
  });
  app.post("/api/push/test", async (c) => {
    if (!send) return c.json({ sent: 0, pruned: 0 });
    const actor = actorOf(c);
    const subs = flock.pushSubscriptions({ actor: actor.name });
    let sent = 0;
    let pruned = 0;
    const payload = JSON.stringify({ title: "flock", body: "Notifications are working.", url: "#/", tag: "test", seq: flock.lastSeq() });
    const results = await Promise.allSettled(subs.map((sub) => send(sub, payload)));
    results.forEach((result, i) => {
      const endpoint = subs[i]!.endpoint;
      if (result.status === "fulfilled") {
        flock.touchPushSubscription(endpoint);
        sent++;
      } else {
        const statusCode = (result.reason as { statusCode?: number } | undefined)?.statusCode;
        if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
          flock.unsubscribePush(endpoint);
          pruned++;
        }
      }
    });
    return c.json({ sent, pruned });
  });

  app.get("/install.sh", (c) => {
    if (!installScriptPath || !existsSync(installScriptPath)) return c.text("install.sh not found\n", 404);
    return c.text(readFileSync(installScriptPath, "utf8"), 200, { "content-type": "text/x-shellscript; charset=utf-8" });
  });

  // ----- static web app -----
  const shell = assets?.["/index.html"];
  if (assets && shell) {
    // Compiled binary: the dist is embedded, so serve it out of the manifest rather than off disk.
    app.get("*", async (c) => {
      const path = new URL(c.req.url).pathname;
      const embedded = path === "/" ? undefined : assets[path];
      if (embedded && extname(path)) {
        return c.body(await Bun.file(embedded).arrayBuffer(), 200, {
          "content-type": MIME[extname(path)] ?? "application/octet-stream",
          "cache-control": path === "/sw.js" ? "no-cache" : "public, max-age=31536000, immutable",
        });
      }
      return c.html(await Bun.file(shell).text());
    });
  } else if (staticDir && existsSync(join(staticDir, "index.html"))) {
    app.get("*", (c) => {
      const path = new URL(c.req.url).pathname;
      const file = join(staticDir, path);
      if (path !== "/" && !path.includes("..") && existsSync(file) && extname(file)) {
        return c.body(readFileSync(file), 200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "cache-control": path === "/sw.js" ? "no-cache" : "public, max-age=31536000, immutable",
        });
      }
      return c.html(readFileSync(join(staticDir, "index.html"), "utf8"));
    });
  } else {
    app.get("/", (c) => c.text("flock api is up. Build the web app with `bun run build` to serve the UI here.\n"));
  }

  return app;
}

export interface ServeOptions extends ServerOptions {
  port?: number;
  hostname?: string;
}

export function serve(opts: ServeOptions) {
  const app = createApp(opts);
  // Default matches the CLI's: every interface, so a caller that skips `resolveHost` (dev.ts) still
  // gets ADR 0015's default rather than silently falling back to loopback.
  const server = Bun.serve({ port: opts.port ?? 4747, hostname: opts.hostname ?? "0.0.0.0", fetch: app.fetch, idleTimeout: 255 });
  return server;
}
