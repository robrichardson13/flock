import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { notifyTargets, type Event, type Flock, type NotifyContext } from "@flock/core";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const DEFAULT_SUBJECT = "https://github.com/robrichardson13/flock";

/**
 * The server's VAPID identity. Resolution order:
 *   1. FLOCK_VAPID_PUBLIC_KEY + FLOCK_VAPID_PRIVATE_KEY (both, or neither) — for a deploy with
 *      no durable disk, e.g. Railway, where a generated file would be lost on every redeploy and
 *      silently invalidate every subscription.
 *   2. `<home>/vapid.json`, if it parses and has both keys.
 *   3. Generated with webpush.generateVAPIDKeys() and written to `<home>/vapid.json` with mode
 *      0600, creating `<home>` if needed.
 * `subject` is FLOCK_VAPID_SUBJECT when set, else "https://github.com/robrichardson13/flock". It
 * is an operator contact the push service may use to reach whoever is sending; it is not
 * authentication and flock never sends mail to it. It must be an `https:` URL or a `mailto:` URI,
 * and it must be externally resolvable: APNs rejects a placeholder like `mailto:flock@localhost`
 * with 403 BadJwtToken, which is why the project URL and not a fake address is the default.
 */
export function loadOrCreateVapidKeys(home: string): VapidKeys {
  const subject = process.env.FLOCK_VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT;

  const envPublic = process.env.FLOCK_VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.FLOCK_VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, subject };

  const file = join(home, "vapid.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject };
      }
    } catch {
      // Fall through and regenerate rather than crashing the server over a corrupt file.
    }
  }

  const generated = webpush.generateVAPIDKeys();
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey }, null, 2), {
    mode: 0o600,
  });
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject };
}

/**
 * Injected so tests never touch the network. Resolves on 2xx; rejects with a WebPushError-shaped
 * error carrying `statusCode` and `endpoint` otherwise.
 */
export type PushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<{ statusCode: number }>;

export interface PushPump {
  /** Deliver everything this one event calls for. Exported for tests; the loop calls it. */
  deliver(event: Event): Promise<{ sent: number; pruned: number }>;
  /** Stop the tail. Called from the server's shutdown path and from tests. */
  stop(): void;
}

/** web-push's sendNotification with setVapidDetails(keys) applied. Exported so the test route can
 *  share it with the pump rather than building its own sender. */
export function defaultSend(keys: VapidKeys): PushSend {
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return async (sub, payload) => {
    const result = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
    );
    return { statusCode: result.statusCode };
  };
}

/** True for status codes meaning "this device is gone; stop trying it". */
function isPruneStatus(statusCode: unknown): boolean {
  return statusCode === 404 || statusCode === 410 || statusCode === 403;
}

export function startPushPump(opts: {
  flock: Flock;
  keys: VapidKeys;
  /** Defaults to web-push's sendNotification with setVapidDetails(keys) applied. */
  send?: PushSend;
  /** Poll interval. Default 500ms — the same cadence the SSE loop uses. */
  intervalMs?: number;
  /** Where to start. Default flock.lastSeq() — a restart never replays history. */
  since?: number;
}): PushPump {
  const { flock } = opts;
  const send = opts.send ?? defaultSend(opts.keys);
  const intervalMs = opts.intervalMs ?? 500;
  let since = opts.since ?? flock.lastSeq();
  let stopped = false;
  let inFlight = false;

  async function deliver(event: Event): Promise<{ sent: number; pruned: number }> {
    let ctx: NotifyContext;
    try {
      const board = flock.board(event.boardId);
      const cardTitle = event.cardNum !== null ? flock.card(event.boardId, event.cardNum).title : undefined;
      ctx = { boardSlug: board.slug, boardTitle: board.title, cardTitle };
    } catch {
      // Board (or card) is gone by the time we got here; nothing sensible to notify about.
      return { sent: 0, pruned: 0 };
    }

    const subs = flock.pushSubscriptions({ boardId: event.boardId });
    const targets = notifyTargets(event, ctx, subs);
    if (targets.length === 0) return { sent: 0, pruned: 0 };

    let sent = 0;
    let pruned = 0;
    const results = await Promise.allSettled(
      targets.map((target) => send(target.subscription, JSON.stringify(target.payload))),
    );
    results.forEach((result, i) => {
      const endpoint = targets[i]!.subscription.endpoint;
      if (result.status === "fulfilled") {
        flock.touchPushSubscription(endpoint);
        sent++;
        return;
      }
      const statusCode = (result.reason as { statusCode?: number } | undefined)?.statusCode;
      if (isPruneStatus(statusCode)) {
        flock.unsubscribePush(endpoint);
        pruned++;
        if (statusCode === 403) console.error(`[push] pruning ${endpoint}: 403 (wrong VAPID key)`);
      } else {
        console.error(`[push] send to ${endpoint} failed: ${statusCode ?? (result.reason as Error)?.message ?? result.reason}`);
      }
    });
    return { sent, pruned };
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const events = flock.events({ since });
      for (const event of events) {
        since = event.seq;
        try {
          await deliver(event);
        } catch (err) {
          // A single bad event must never stop the tail.
          console.error(`[push] error delivering event #${event.seq}:`, err);
        }
      }
    } catch (err) {
      console.error("[push] tail error:", err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void tick();
  }, intervalMs);
  // Never keep the process alive on its own.
  if (typeof timer.unref === "function") timer.unref();

  return {
    deliver,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
