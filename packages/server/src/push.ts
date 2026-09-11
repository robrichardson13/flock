import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import {
  notificationFor,
  notifyTargets,
  recipientsOf,
  NotificationBatcher,
  Presence,
  type Dispatch,
  type Event,
  type Flock,
  type NotifyContext,
} from "@flock/core";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const DEFAULT_SUBJECT = "https://github.com/robrichardson13/flock";

/**
 * The server's VAPID identity. Resolution order:
 *   1. FLOCK_VAPID_PUBLIC_KEY + FLOCK_VAPID_PRIVATE_KEY (both, or neither) — for a deploy with
 *      no durable disk, where a generated file would be lost on every redeploy and
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
  /** Flush any trailing batch flushes whose window has closed. The tick calls it; tests call it. */
  flush(): Promise<{ sent: number; pruned: number }>;
  /** Stop the tail. Called from the server's shutdown path and from tests. Drops pending batches. */
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
  /** Who is looking at what board, for suppressing chatter (D8). Default: nobody looking. */
  presence?: Presence;
  /** Clock. Default Date.now. Tests inject a fake clock to drive the batch window without timers. */
  now?: () => number;
}): PushPump {
  const { flock } = opts;
  const send = opts.send ?? defaultSend(opts.keys);
  const intervalMs = opts.intervalMs ?? 500;
  const now = opts.now ?? Date.now;
  const presence = opts.presence ?? new Presence();
  let since = opts.since ?? flock.lastSeq();
  let stopped = false;
  let inFlight = false;
  let batcher = newBatcher();

  function newBatcher(): NotificationBatcher {
    return new NotificationBatcher({ isLooking: presence.isLooking.bind(presence) });
  }

  /** send(d) per §4: fan one Dispatch out to that actor's subscriptions for that board, today's prune/touch/log rules. */
  async function sendDispatch(d: Dispatch): Promise<{ sent: number; pruned: number }> {
    const subs = flock.pushSubscriptions({ boardId: d.boardId, actor: d.actor });
    if (subs.length === 0) return { sent: 0, pruned: 0 };
    let sent = 0;
    let pruned = 0;
    const payload = JSON.stringify(d.payload);
    const results = await Promise.allSettled(subs.map((sub) => send(sub, payload)));
    results.forEach((result, i) => {
      const endpoint = subs[i]!.endpoint;
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

  async function sendAll(dispatches: readonly Dispatch[]): Promise<{ sent: number; pruned: number }> {
    let sent = 0;
    let pruned = 0;
    for (const d of dispatches) {
      const result = await sendDispatch(d);
      sent += result.sent;
      pruned += result.pruned;
    }
    return { sent, pruned };
  }

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

    const payload = notificationFor(event, ctx);
    const subs = payload ? flock.pushSubscriptions({ boardId: event.boardId }) : [];
    const targets = payload ? notifyTargets(event, ctx, subs) : [];
    const recipients = recipientsOf(targets);

    // Every event goes through the batcher, even one that notifies nobody, so the author-seen
    // reset (D9) applies uniformly. onEvent returns dispatches that go out now (an urgent bypass,
    // or a leading-edge throttle); trailing flushes come from due()/flush(), not from here.
    const dispatches = batcher.onEvent(event, payload, recipients, now());
    return sendAll(dispatches);
  }

  /** Trailing flushes whose window has closed (§2.3's due()). The tick calls it; tests call it. */
  async function flush(): Promise<{ sent: number; pruned: number }> {
    return sendAll(batcher.due(now()));
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
      await flush();
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
    flush,
    stop() {
      stopped = true;
      clearInterval(timer);
      // Drop pending state (§2.7): a restart-equivalent shutdown never awaits a flush.
      batcher = newBatcher();
    },
  };
}
