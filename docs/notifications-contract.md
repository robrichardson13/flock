# Notifications: the implementation contract

Companion to [ADR 0017](adr/0017-web-push-notifications.md). The ADR says *why*; this file says
*exactly what to build*, so cards #2 (core), #3 (server) and #4 (web) can be worked in parallel
without re-deciding anything. Where the two disagree, this file is the one to follow for
signatures and shapes and the ADR is the one to follow for intent.

Nothing here is optional. If something is genuinely wrong, change it here first (and say so on
the card) rather than diverging in code.

---

## 1. Core — `packages/core`

### 1.1 Schema

`SCHEMA_VERSION` in `packages/core/src/db.ts` goes **3 → 4**. Add the table to the `SCHEMA`
constant; `CREATE TABLE IF NOT EXISTS` is itself the migration for an existing database, so
`migrate()` needs no new branch. Indexes on a brand-new table may live in `SCHEMA` too (unlike the
`decisions_board_num` case, which indexed a column added by an `ALTER` that runs after `SCHEMA`).

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'human',
  board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS push_subs_actor ON push_subscriptions(actor);
CREATE INDEX IF NOT EXISTS push_subs_board ON push_subscriptions(board_id);
```

- `endpoint` is the identity of a subscription. It is the push service's URL for one browser
  profile on one device, and it is the only stable handle the browser gives us. It can be ~500
  characters; never put it in a URL path or query string.
- `board_id NULL` means **every board**. That is what the web app sends, and the only thing it
  sends today; the column exists so per-board muting can be added later without a second
  migration. Treat a non-null value as "only this board" everywhere.
- `actor_kind` is stored because the routes take it from the same headers as everything else. It
  is not a filter: suppression is by actor *name* (§1.3).
- No `last_error` column. A failing subscription is deleted, not annotated (§2.4).

### 1.2 Types and storage methods

New file `packages/core/src/notify.ts`, re-exported from `packages/core/src/index.ts` with
`export * from "./notify.ts";`. Types that the web app needs go in `types.ts` instead — see the
note at the end of this section.

```ts
/** What a browser hands back from PushManager.subscribe(), as we store it. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** null/absent = every board. A board id, never a slug. */
  boardId?: string | null;
  userAgent?: string | null;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  actor: string;
  actorKind: ActorKind;
  boardId: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}
```

Methods on `Flock` (in `flock.ts`, under a `// ---------- push ----------` heading beside the
other groups):

```ts
/**
 * Register or re-register a device. Upsert keyed on `endpoint`: a browser that re-subscribes
 * with the same endpoint rebinds the keys, actor, board scope and user agent, and keeps its
 * original `created_at`. Throws FlockError("invalid") on a missing endpoint or key.
 */
subscribePush(actor: Actor, input: PushSubscriptionInput): PushSubscriptionRecord;

/** Remove one device. Returns false when the endpoint was not registered. Idempotent. */
unsubscribePush(endpoint: string): boolean;

/**
 * Subscriptions, newest first.
 * `boardId` returns the board's own subscriptions *plus* every global (board_id IS NULL) one —
 * that is the set a board event has to notify.
 * `actor` filters to one person, for the web app's "on for this device" readback.
 */
pushSubscriptions(opts?: { boardId?: string; actor?: string }): PushSubscriptionRecord[];

/** Stamp `last_used_at` after a successful send. Silent no-op on an unknown endpoint. */
touchPushSubscription(endpoint: string): void;
```

`subscribePush` takes an `Actor` like every other write, but **emits no event**. A device
registering is plumbing, not board history: it has no board to belong to, and it would put a line
in every activity feed every time a phone re-subscribes. Same for `unsubscribePush`.

`PushSubscriptionRecord` is server-side only, so it stays in `notify.ts`. `NotificationPayload`
(§1.3) also goes in `notify.ts`; the web app does not import it — the service worker is plain JS
outside the TypeScript project, and the page never sees a payload.

### 1.3 The trigger rules, as a pure function

Also in `packages/core/src/notify.ts`. No database access, no clock, no I/O — the whole point is
that card #2 can test every rule in isolation.

```ts
/** What one notification says. Serialized to JSON and encrypted as the push payload. */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Hash route into the app, e.g. "#/b/flock/c/12". Always starts with "#/". */
  url: string;
  /**
   * Collapse key: a newer notification with the same tag replaces an older one on the device.
   * **Always exactly equal to `url`.** Safari does not reliably deliver `notification.data` to
   * `notificationclick` (MDN BCD reports `data` unsupported on Safari and iOS Safari), and `tag`
   * is a plain string that always survives — so the tag doubles as the routing carrier. It also
   * happens to give the collapse behaviour we want for free: two messages in one channel, or two
   * events on one card, replace each other instead of stacking.
   */
  tag: string;
  /** The event that produced it. For dedupe and for debugging a delivery. */
  seq: number;
  /**
   * `true` on a leading edge and on every ask/awaiting-human notification: a same-tag replacement
   * should alert (Chrome/Edge default to a silent replacement otherwise). `false` on a trailing
   * batch flush, where the count updates quietly in place. Safari/iOS and Firefox ignore the
   * field; nothing else depends on it. See ADR 0021.
   */
  renotify: boolean;
}

/** What the sender knows about the event's board and card that the event row does not carry. */
export interface NotifyContext {
  boardSlug: string;
  boardTitle: string;
  /** Title of the event's `cardNum`, when it has one. */
  cardTitle?: string;
}

export interface NotifyTarget {
  subscription: PushSubscriptionRecord;
  payload: NotificationPayload;
}

/** The notification this event deserves, or null when it deserves none. `renotify` is `true` on
 *  every rule below. */
export function notificationFor(event: Event, ctx: NotifyContext): NotificationPayload | null;

/** Every (subscription, payload) pair this event should produce. Empty when nothing applies. */
export function notifyTargets(
  event: Event,
  ctx: NotifyContext,
  subs: readonly PushSubscriptionRecord[],
): NotifyTarget[];

/** First non-empty line, collapsed whitespace, truncated with a trailing "…". Exported for tests. */
export function summarize(text: string, max?: number): string; // max default 140

/**
 * "urgent" = card.asked, card.moved -> awaiting-human (bypasses batching and presence).
 * "chatter" = message.posted (the only class that batches or is suppressed by presence).
 * Everything else is null: it never produces a notification.
 */
export function notificationClass(event: Event): "urgent" | "chatter" | null;

/**
 * Merges a batch of `count` folded messages into one notification: title becomes
 * `"<count> new in <board>"` (the board title is `latest.title` for `message.posted`), body/url/
 * tag/seq come from the latest folded message, and `renotify` is passed through explicitly by the
 * caller (`true` on a leading-edge burst, `false` on a trailing flush).
 */
export function mergedNotification(
  latest: NotificationPayload,
  count: number,
  renotify: boolean,
): NotificationPayload;

/** Distinct actor names of the targets, in first-seen order. The author never appears (§1.3's
 *  `notifyTargets` filter already excludes them). */
export function recipientsOf(targets: readonly NotifyTarget[]): string[];
```

**`notificationFor` — the complete rule table.** Every event type not listed returns `null`.

| `event.type` | Condition | `title` | `body` | `url` | `tag` |
| --- | --- | --- | --- | --- | --- |
| `message.posted` | always | `ctx.boardTitle` | `` `${event.actor}: ${summarize(data.body)}` ``, or `` `${event.actor} sent an image` `` when `data.body` is empty and `data.attachments > 0` | `#/b/<slug>/channel` | = `url` |
| `card.asked` | always | `` `#${cardNum} needs you` `` | `` `${event.actor}: ${summarize(data.question)}` `` | `#/b/<slug>/c/<n>` | = `url` |
| `card.moved` | `data.to === "awaiting-human"` | `` `#${cardNum} is waiting on you` `` | `ctx.cardTitle ?? ""` | `#/b/<slug>/c/<n>` | = `url` |

Every row above sets `renotify: true`. A merged (batched) notification is a fourth shape, produced
by `mergedNotification` (§1.4) rather than `notificationFor`: `title` becomes
`` `${count} new in ${latest.title}` `` and `body`/`url`/`tag`/`seq` are copied from the latest
folded `message.posted` payload; `renotify` is `true` on a leading-edge burst (`count > 1` the
first time a key is seen after quiet) and `false` on a trailing flush. `notificationClass(event)`
says which of the three rows above is "urgent" (`card.asked`, `card.moved` → `awaiting-human` —
bypasses batching and presence entirely) versus "chatter" (`message.posted` — the only class that
batches or can be suppressed); see ADR 0021 and §1.4.

- `card.asked` and the `card.moved` → `awaiting-human` case therefore share a tag, since they share
  a URL. `askHuman` emits only `card.asked` and a manual move emits only `card.moved`, so in
  practice one card produces one notification; the shared tag is the guard for any future path
  that does both.
- The title of an ask does **not** repeat the board name; the body already names the asker, and
  iOS prefixes the notification with the web app's own name. `message.posted` uses the board title
  as the title because a channel message has no card to name.
- `summarize` default max is 140. The whole **encrypted** payload must stay under 4 KB — that is
  APNs' limit, and exceeding it is a 413 `PayloadTooLarge`. A realistic payload measured during the
  design encrypted to 226 bytes, so 140 leaves an enormous margin.
- `data.body` on `message.posted` is raw markdown. Do not render it — `summarize` collapses it to
  one line and that is enough. (`packages/core/src/markdown.ts` is for the UI, not for this.)

**`notifyTargets` — the filter.** For each `sub` in `subs`, emit a target when **all** hold:

1. `sub.actor !== event.actor` — never notify the actor who caused the event. Exact string match
   on the name; that is the same identity the CLI's `--as`, the `x-flock-actor` header and the web
   app's `localStorage["flock.actor"]` all agree on.
2. `sub.boardId === null || sub.boardId === event.boardId`.
3. `notificationFor(event, ctx)` returned non-null (compute once, share the object across targets).

Nothing else. In particular: no filter on `actorKind`, no "is this human on this board" check, no
quiet hours, no per-event-type preference. A subscription is a standing request from one named
human for everything on the boards it is scoped to.

### 1.4 Presence and `NotificationBatcher`

New file `packages/core/src/presence.ts`, re-exported from `index.ts`. In memory, no clock reads —
`now` is always a parameter — and no dependencies. See ADR 0021.

```ts
export const PRESENCE_TTL_MS = 45_000;

export interface PresenceReport {
  client: string;
  actor: string;
  boardId: string | null;
  looking: boolean;
}

export class Presence {
  constructor(opts?: { ttlMs?: number });
  /** `looking: true` upserts `{ actor, boardId, expiresAt: now + ttlMs }` keyed by `client`;
   *  `looking: false` deletes that client's entry. */
  report(r: PresenceReport, now: number): void;
  /** True iff some (unexpired) entry has this exact actor and this exact boardId. `boardId: null`
   *  (Home) never matches, since `isLooking`'s `boardId` parameter is always a non-null string. */
  isLooking(actor: string, boardId: string, now: number): boolean;
  /** Live entry count after pruning stale ones. For tests. */
  size(now: number): number;
}
```

New file `packages/core/src/batching.ts`, re-exported from `index.ts`.

```ts
export const BATCH_WINDOW_MS = 60_000;

export interface Dispatch { actor: string; boardId: string; payload: NotificationPayload }

export type IsLooking = (actor: string, boardId: string, now: number) => boolean;

export class NotificationBatcher {
  /** `isLooking` is injected, not a `Presence` instance, so this module has no dependency on
   *  presence.ts. */
  constructor(opts: { isLooking: IsLooking; windowMs?: number });

  /**
   * Every event goes through here, even one that notifies nobody, so the author-seen reset (D9 in
   * the spec / ADR 0021) applies uniformly: the event's own actor has their pending batch on this
   * board dropped and zeroed regardless of whether `payload` is null. When `payload` is non-null
   * and `notificationClass(event) === "urgent"`, every recipient gets an immediate `Dispatch` and
   * no batch state is touched. When it is `"chatter"`, each recipient is offered to the
   * leading-edge throttle: `isLooking` true drops the pending batch and dispatches nothing; a
   * quiet key dispatches immediately (plain if this is the first message since last seen,
   * `mergedNotification` otherwise) and opens a `windowMs` window; a key already inside its window
   * folds the payload with no dispatch.
   */
  onEvent(
    event: Event,
    payload: NotificationPayload | null,
    recipients: readonly string[],
    now: number,
  ): Dispatch[];

  /** Every key whose window has closed and has a folded payload pending: dispatches
   *  `mergedNotification(latest, count, false)` and opens the next window. A key whose actor
   *  `isLooking` is dropped (batch and count reset) instead of flushed. */
  due(now: number): Dispatch[];

  /** Earliest pending flush across every key, or null. For tests. */
  nextDueAt(): number | null;
}
```

---

## 2. Server — `packages/server`

### 2.1 Dependency

Add `"web-push": "^3.6.7"` to `packages/server/package.json` dependencies. Core keeps none.

Verified working under Bun 1.3.4 during the design: `generateVAPIDKeys()`, VAPID JWT signing,
`aes128gcm` payload encryption, a real `sendNotification` POST against a TLS `Bun.serve`, and
`WebPushError` carrying `statusCode` and `endpoint`. Crucially, the payload Bun encrypts is
**correct**, not merely well-formed: a realistic notification encrypted under Bun 1.3.4 was
decrypted byte-identically by Node 24's `http_ece` per RFC 8291. See ADR 0017 for why that
particular check mattered.

One gotcha that shapes the tests: **`web-push` calls `node:https` unconditionally** (see
`web-push-lib.js`), so a plain-`http` stub push service is unreachable — §4.2.

### 2.2 VAPID keys

New file `packages/server/src/push.ts`.

```ts
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/**
 * The server's VAPID identity. Resolution order:
 *   1. FLOCK_VAPID_PUBLIC_KEY + FLOCK_VAPID_PRIVATE_KEY (both, or neither) — for a deploy with
 *      no durable disk, where a generated file would be lost on every redeploy and
 *      silently invalidate every subscription.
 *   2. `<home>/vapid.json`, if it parses and has both keys.
 *   3. Generated with webpush.generateVAPIDKeys() and written to `<home>/vapid.json` with mode
 *      0600, creating `<home>` if needed.
 * `subject` is FLOCK_VAPID_SUBJECT when set, else "https://github.com/robrichardson13/flock".
 * It is an operator contact the push service may use to reach whoever is sending; it is not
 * authentication and flock never sends mail to it. It must be an `https:` URL or a `mailto:` URI,
 * and it must be externally resolvable: APNs rejects a placeholder like `mailto:flock@localhost`
 * with 403 BadJwtToken, which is why the project URL and not a fake address is the default.
 */
export function loadOrCreateVapidKeys(home: string): VapidKeys;
```

`home` is `flockHome()` — `$FLOCK_HOME`, else `~/.flock`. The server may not import
`packages/cli/src/paths.ts` (wrong direction), so `ServerOptions` grows a field the CLI fills in,
exactly as `installScriptPath` already does:

```ts
export interface ServerOptions {
  // ...existing...
  /** flockHome(): where VAPID keys are read and written. Defaults to ~/.flock when absent. */
  flockHome?: string;
  /** Off switch. Default true. `FLOCK_NO_PUSH=1` also turns it off. */
  push?: boolean;
}
```

`packages/cli/src/dev.ts`'s `serve` path passes `flockHome: flockHome()`. `vapid.json` is written
under a directory already in `.gitignore` via `.flock/`; nothing new to ignore.

### 2.3 Routes

All under `/api/push`, all taking the actor from `actorOf(c)` like every other route.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/push/key` | — | `200 { "enabled": true, "publicKey": "B..." }` or `200 { "enabled": false, "reason": "push is disabled" }` |
| `GET` | `/api/push/subscriptions` | — | `200 PushSubscriptionRecord[]` for the calling actor, **with `keys` omitted** |
| `POST` | `/api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth }, boardId?, userAgent? }` | `201 PushSubscriptionRecord` (keys omitted) |
| `DELETE` | `/api/push/subscriptions` | `{ endpoint }` | `204` (also `204` when it was not registered) |
| `POST` | `/api/push/test` | — | `200 { "sent": n, "pruned": m }` |
| `POST` | `/api/presence` | `{ client: string, board: string \| null, looking: boolean }` | `204`; `400 { error, code: "invalid" }` on a bad body; **never** `404` |

`POST /api/presence` (§1.4, §3.7) is mounted whether or not push is enabled: it is tiny, in memory,
and a device with no subscription of its own still needs to suppress a device that does. Validation:
`client` a non-empty string ≤ 64 characters; `looking` a boolean; `board` a string or `null`/absent
— any violation is 400 `invalid`. `board`, when given, is resolved with `flock.board(slug)`; an
**unknown slug is stored as `boardId: null`, not 404**, since presence is best-effort and a stale
tab pointed at a deleted board should not spam the console. The actor comes from `actorOf(c)` like
every other route; `presence.report({ client, actor, boardId, looking }, now())` is called with the
same clock (`now`, defaulting to `Date.now`, a `ServerOptions` test seam shared with the pump) that
drives the batch windows below, so a server-side test can move both in lockstep.

- `publicKey` is the base64url-encoded uncompressed P-256 point, 87 characters, exactly as
  `generateVAPIDKeys()` returns it. The web app converts it to a `Uint8Array` itself (§3.3).
- `DELETE` carries a JSON body rather than a query parameter because an endpoint can exceed a
  comfortable URL length. `fetch` and Hono both allow it.
- `keys` are never sent back to a client. They are the device's decryption secret and the browser
  already has them; echoing them buys nothing and widens what a shared-machine browser tab leaks.
- `POST /api/push/test` sends a fixed payload (`title: "flock"`, `body: "Notifications are
  working."`, `url: "#/"`, `tag: "test"`) to every subscription belonging to the calling actor and
  reports how many were sent and how many were pruned. This is what card #5's iOS checklist uses;
  without it the only way to test delivery is to get a second actor to post a message.
- Validation: a missing or non-string `endpoint`, `keys.p256dh` or `keys.auth` is
  `FlockError("...", "invalid")` → 400, via the existing `app.onError`.
- Errors follow the existing conventions: nothing here can 404 or 409.

### 2.4 The sender

Also in `packages/server/src/push.ts`.

```ts
/** Injected so tests never touch the network. Resolves on 2xx; rejects with a WebPushError-shaped
 *  error carrying `statusCode` and `endpoint` otherwise. */
export type PushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
) => Promise<{ statusCode: number }>;

export interface PushPump {
  /** Deliver everything this one event calls for. Exported for tests; the loop calls it. */
  deliver(event: Event): Promise<{ sent: number; pruned: number }>;
  /** Flush trailing batch flushes whose window has closed. The tick calls it after draining
   *  events each poll; tests call it directly against a fake `now`. */
  flush(): Promise<{ sent: number; pruned: number }>;
  /** Stop the tail. Called from the server's shutdown path and from tests. Drops pending batch
   *  state rather than flushing it (ADR 0021's §2.7: a restart-equivalent shutdown never awaits a
   *  send). */
  stop(): void;
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
  /** Who is looking at what board, for suppressing chatter (§1.4). Default: a fresh `Presence`,
   *  i.e. nobody looking. */
  presence?: Presence;
  /** Clock. Default `Date.now`. Tests inject a fake clock to drive the batch window and presence
   *  TTL without real timers. */
  now?: () => number;
}): PushPump;
```

**How it tails.** The same source SSE uses — `flock.events({ since })` over the whole database,
no `boardId` — but its own independent loop, started once in `createApp` and living for the life
of the process. It is deliberately *not* wired into the SSE handler: SSE streams exist only while
a browser has the page open, and the entire point of push is to reach a device with no page open.
Cursor starts at `flock.lastSeq()` so a restart does not re-notify the backlog.

**Per tick** (unchanged 500ms cadence; no new timers), per ADR 0021 §4 of the spec:

```
for event in flock.events({ since }):
    ctx = resolve board/card, skip if either throws                  (unchanged)
    payload = notificationFor(event, ctx)                            (null for most events)
    subs = payload ? flock.pushSubscriptions({ boardId: event.boardId }) : []
    recipients = recipientsOf(notifyTargets(event, ctx, subs))       (author + scope filter unchanged)
    for d in batcher.onEvent(event, payload, recipients, now()): sendAll([d])
for d in batcher.due(now()): sendAll([d])   # the tick's own call to flush()
```

1. Resolve the context exactly as before: `flock.board(event.boardId)` for slug and title;
   `flock.card(event.boardId, event.cardNum)` for `cardTitle` when `event.cardNum !== null`. Skip
   the event if either throws (a board deleted between the write and the tail).
2. Every event — even one `notificationFor` returns `null` for — goes through
   `batcher.onEvent(...)`, so the author-seen batch reset (§1.4) applies uniformly.
3. `onEvent` returns zero or more `Dispatch`es to send **now**: an urgent bypass (every recipient,
   immediately) or a leading-edge throttle dispatch. Trailing flushes never come from `onEvent` —
   only from `due()`/`flush()`.
4. `flush()` (`batcher.due(now())`) runs once per tick, after every event in the batch has been
   drained, and is also exposed for tests to call directly with a fake `now`.
5. `sendAll(dispatches)`: for each `Dispatch`, `flock.pushSubscriptions({ boardId: d.boardId, actor:
   d.actor })` — read fresh at send time, so a device subscribed or pruned mid-window is handled
   correctly — then `send(sub, JSON.stringify(d.payload))` for every one of that actor's
   subscriptions for that board. **Every dispatch, and every subscription within a dispatch, is
   sent in parallel with `Promise.allSettled`** (ADR 0021 / review finding S1): one recipient's
   slow send, thrown error, or failed database write must never delay or drop another recipient's
   push, including an ask or a different key's trailing flush the same tick already resolved. Each
   `touchPushSubscription`/`unsubscribePush` write is its own try/catch for the same reason. A
   web-push send carries a 10 second timeout (`webpush.sendNotification(..., { timeout: 10_000 })`)
   so one unreachable push service cannot stall the batch indefinitely.
6. Success → `flock.touchPushSubscription(endpoint)`.
7. Failure:
   - `statusCode` **404 or 410** → `flock.unsubscribePush(endpoint)`. Gone means gone: the browser
     profile was cleared, the home-screen app was deleted, or the subscription expired.
   - `statusCode` **403** → also prune, and log once. 403 is "this subscription was made with a
     different VAPID key", which is unrecoverable for that device.
   - **413** (payload too large) → log, keep the subscription. A bug on our side, not the device's.
   - **429** → log, keep. Back-pressure, not a dead device.
   - anything else, including a network error with no `statusCode` → log one line to stderr, keep.
8. Never let a send failure escape the loop. One bad endpoint must not stop the tail.

Logging is `console.error` with a `[push]` prefix, matching `[board-create ...]` elsewhere; a
failed fan-out dispatch logs `[push] sendDispatch failed for <actor> on board <id>: <reason>`.

`stop()` clears the poll interval and replaces the batcher with a fresh `NotificationBatcher`,
dropping every pending count and trailing flush rather than awaiting one last `flush()` — see ADR
0020's restart consequence.

`POST /api/push/test` is untouched by any of this: it bypasses `notifyTargets`, the batcher and
presence entirely, sending a fixed payload straight through `send`.

### 2.5 Serving the service worker

`packages/web/public/sw.js` is copied verbatim into `packages/web/dist/` by Vite, so
`scripts/gen-assets.ts` picks it up as `/sw.js` with no change to either. The static handlers in
`packages/server/src/index.ts` already map `.js` to `text/javascript; charset=utf-8` — the MIME is
correct as-is, and serving from the root path is what gives the worker scope `/`.

One change is required: **both** static branches (the embedded-assets one and the `staticDir` one)
currently send `cache-control: public, max-age=31536000, immutable` to anything with an extension.
That is right for Vite's hashed bundles and wrong for `/sw.js`, whose filename never changes.
Special-case it to `cache-control: no-cache` in both branches. (Browsers do bypass the HTTP cache
for the worker script itself by default, but an `immutable` year on a file we update in place is a
trap set for whoever adds `updateViaCache` or a proxy later.)

No `Service-Worker-Allowed` header is needed: a worker served from `/` already has the maximum
scope we want.

---

## 3. Web — `packages/web`

### 3.1 The service worker: `packages/web/public/sw.js`

Path and directory are load-bearing. `public/` is copied unhashed to the dist root, which is the
only way to get a stable `/sw.js` with scope `/` without touching `vite.config.ts`. It also means
the file is **plain JavaScript outside the TypeScript project** — no imports, no JSX, no
transpilation. Keep it short enough to read in one sitting.

It must do exactly three things and nothing else:

```js
// Take over as soon as a new version is served: this worker caches nothing, so there is no
// in-flight state to protect and a stale push handler is the only failure mode worth avoiding.
self.addEventListener("install", (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// EVERY push must end in a visible notification. We subscribe with userVisibleOnly: true, and
// WebKit revokes the whole subscription if a push arrives and nothing is shown — so the fallback
// below is not politeness, it is what keeps the subscription alive when a payload is malformed.
self.addEventListener("push", (event) => {
  let p = { title: "flock", body: "Something needs you.", url: "#/", tag: "#/" };
  try { if (event.data) p = { ...p, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      // The tag is the route (see NotificationPayload): Safari does not reliably hand `data`
      // back to notificationclick, and the tag always survives. `data` is set anyway for the
      // browsers that do honour it — the click handler prefers it and falls back to the tag.
      tag: p.tag || p.url,
      data: { url: p.url },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // ADR 0021: alert on a same-tag replacement for a leading-edge burst or an ask, stay quiet
      // for a trailing flush. Guarded against an empty tag (Chrome throws if renotify is true with
      // one) even though tag is never empty in practice — belt and braces. Safari, iOS Safari and
      // Firefox ignore the field.
      renotify: p.renotify === true && !!(p.tag || p.url),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const n = event.notification;
  const url = (n.data && n.data.url) || n.tag || "#/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      await c.focus();
      // postMessage is the primary route, not the fallback. `client.navigate` requires the
      // client to be *controlled* by this worker, which includeUncontrolled:true explicitly
      // does not guarantee, and a hash-only navigate is not guaranteed to re-run a hash router
      // anyway. The page listens for this message and sets location.hash itself.
      c.postMessage({ type: "flock:navigate", url });
      return;
    }
    await self.clients.openWindow(new URL(url, self.location.origin).href);
  })());
});
```

**There is no `fetch` handler and there must not be one.** flock's assets are content-hashed and
served immutable; offline is out of scope. A caching worker would be a brand-new and entirely
separate class of stale-app bug, and it would land on the one platform (a home-screen install)
where a stuck cache is hardest for a user to clear.

`showNotification` fields beyond `title`, `body`, `tag`, `data`, `icon`, `badge` and (since ADR
0020) `renotify` are not used. MDN's compat data records `actions`, `requireInteraction`, `image`
and `vibrate` as unsupported on Safari and iOS Safari, so a design that leaned on any of them would
work on the desktop and quietly do nothing on the primary target. `renotify` is the one exception,
and it is still safe to set unconditionally: it is an enhancement Chrome/Edge honour and every other
target silently ignores, never gating any behaviour those platforms need. `icon` and `badge` are
set because they cost nothing and help on Chrome and Android; expect iOS to ignore `badge` (WebKit
bug 280160) and to use the home-screen icon regardless.

### 3.2 The page side: `packages/web/src/push.ts`

The testable seam is a pure function; everything that touches a browser API sits behind it.

```ts
/** Everything the decision depends on, read off the environment by the caller. */
export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  /** navigator.standalone === true, or display-mode: standalone matches. */
  isStandalone: boolean;
  isIOS: boolean;
  permission: NotificationPermission | "unavailable";
  /** This device has a subscription registered with the server. */
  subscribed: boolean;
}

export type PushState =
  | { kind: "on" }
  | { kind: "off" }                    // supported, permission "default" or granted-but-unsubscribed
  | { kind: "blocked" }                // permission "denied"
  | { kind: "needs-install" }          // iOS, not standalone
  | { kind: "insecure" }               // not a secure context
  | { kind: "unsupported" }
  | { kind: "server-off" };            // browser can, server has no VAPID key — see below

/** Pure. Unit-tested exhaustively in push.test.ts. */
export function pushState(env: PushEnv): PushState;

export function readPushEnv(subscribed: boolean): PushEnv;   // reads the real browser
export async function enablePush(publicKey: string): Promise<PushState>;  // must be called from a user gesture
export async function disablePush(): Promise<PushState>;
export async function currentSubscription(): Promise<PushSubscription | null>;
```

**`server-off` is a seventh kind, layered on top, not produced by `pushState`.** A server with no
VAPID key is not a fact about the browser — `pushState(env)` never returns it, and its own
precedence above is unchanged. It is applied afterward by a second, pure helper:

```ts
/** Layers the server's own availability over the browser's state. Pure. */
export function withServerKey(state: PushState, key: { enabled: boolean; publicKey?: string } | null): PushState;
```

Precedence: everything but `off` outranks it — a device already `on` stays on, since the key only
matters for a *new* subscription, and `insecure`/`needs-install`/`unsupported`/`blocked` all name a
problem that would still be true with a key. A key that has not resolved yet (`key === null`) is
assumed to work rather than guessed at, so the row never flashes `server-off` while the fetch below
is still in flight.

`pushState` precedence, highest first: `insecure` → `needs-install` → `unsupported` → `blocked` →
`on`/`off`. Rationale: name the thing the user has to fix *first*. The ordering of the middle two
is the one that matters. In a plain iOS Safari tab `navigator.serviceWorker` exists but both
`PushManager` and the whole `Notification` interface are undefined — the naive read is
"unsupported", and the true answer is "add it to your Home Screen and it will work". So
`isIOS && !isStandalone` must be tested **before** the capability check, or the app tells iPhone
users it cannot do the thing it can do.

Conversely `isSecureContext` is checked before everything: over `http://` on a LAN or Tailscale
address the worker cannot register at all, and no amount of installing fixes that.

`isIOS`: `/iPad|iPhone|iPod/.test(navigator.platform)` is dead on iPadOS; use
`navigator.maxTouchPoints > 1 && /Mac|iP(hone|ad|od)/.test(navigator.userAgent)`.

### 3.3 The subscribe flow

The constraint is Apple's: `Notification.requestPermission()` must be reached from the gesture's
own handler with nothing slow awaited first. `GET /api/push/key` is a network call, so it cannot
sit inside `enablePush()` above that line — the fix is to fetch the key *before* the click ever
happens, not to reorder the prompt after it. `enablePush` therefore takes the key as an argument
instead of fetching it itself:

```ts
export async function enablePush(publicKey: string): Promise<PushState>
```

and its numbered flow has no fetch above `requestPermission()`:

1. `const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" })`, then
   `await navigator.serviceWorker.ready`.
2. `const permission = await Notification.requestPermission()`. **This call must be reached from a
   user gesture** — nothing else is awaited before it. Apple's wording is "call the push
   subscription method immediately from the gesture's event handler code". Registering the worker
   first is fine (Apple's own guidance).
3. Bail to `{ kind: "blocked" }` unless `permission === "granted"`.
4. ```ts
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,              // required; iOS and Chrome both reject false
     applicationServerKey: urlBase64ToUint8Array(publicKey),
   });
   ```
5. `await api.pushSubscribe({ ...sub.toJSON(), userAgent: navigator.userAgent })` —
   `PushSubscription.toJSON()` already yields `{ endpoint, keys: { p256dh, auth } }`, the exact
   request shape in §2.3. Send no `boardId`: subscriptions are global (§1.1).
6. Return `{ kind: "on" }`.

**Where the key comes from.** A module-level cache in `push.ts`, fire-and-remember:

```ts
export function primePushKey(): Promise<{ enabled: boolean; publicKey?: string; reason?: string }>;
/** Synchronous read, for the click handler. Null = not resolved yet. */
export function pushKeyNow(): { enabled: boolean; publicKey?: string; reason?: string } | null;
```

`primePushKey()` is called from two places, neither of them a click handler: **App root mount**, in
the same effect that already registers the service worker — so the key is in hand long before
anyone reaches the row — and again whenever the panel opens, to recover from a failed first
attempt. It re-fetches only after a rejection, never after a plain `{ enabled: false }` answer,
since that is a real cacheable answer and not an error.

The click handler reads `pushKeyNow()` first. When the key is already primed (the normal case), it
awaits nothing new before calling `enablePush(key.publicKey)` — the gesture chain stays unbroken.
A key-less server (`!key.enabled || !key.publicKey`) resolves straight to `{ kind: "server-off" }`
with no OS prompt fired at all. Only on the cold path — the key has not resolved yet at click time
— does the handler fall back to `await primePushKey()` before proceeding; that is exactly today's
risk and no worse than the old unconditional fetch, just rare instead of routine. The whole call is
wrapped in a `.catch` that stores the thrown `Error.message` as `pushError` — the toggle handler
never had one before this pass.

`disablePush()`: `await sub.unsubscribe()` on the browser side **and** `DELETE
/api/push/subscriptions` with the endpoint, in that order, ignoring a failure of either so the
toggle never gets stuck on.

`urlBase64ToUint8Array` is five lines and belongs in `push.ts`; it is pure and gets a unit test.

Add to `packages/web/src/api.ts`:

```ts
pushKey: () => req<{ enabled: boolean; publicKey?: string; reason?: string }>("GET", "/push/key"),
pushSubscriptions: () => req<PushSubscriptionSummary[]>("GET", "/push/subscriptions"),
pushSubscribe: (input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }) =>
  req<PushSubscriptionSummary>("POST", "/push/subscriptions", input),
pushUnsubscribe: (endpoint: string) => req<void>("DELETE", "/push/subscriptions", { endpoint }),
pushTest: () => req<{ sent: number; pruned: number }>("POST", "/push/test"),
```

`req` already sends `x-flock-actor` from `localStorage["flock.actor"]`, so the server attributes
the subscription with no extra work.

### 3.4 Where it lives in the UI

**One panel, one quiet entrance.** There is no `Notifications` row on Home and no section for it —
`packages/web/src/Notifications.tsx` exports only `TREATMENT` and `PushPanel` now; `PushRow` and
its `Notifications` section head are gone, and the CSS that only served that row (`.push-row`,
`.push-icon*`, `.push-dot*`) was deleted with it. The entrance is a single icon-only button, `Icons.bell`
(`Icons.bellOff` in `blocked`), beside the avatar in the top bar — `aria-label`/`title` both
`"Notifications"` — on Home and on a board, desktop and phone alike:

- Desktop (`AppTopBar` in `shell.tsx`): the button sits beside `.me-btn`, which is back to being a
  plain rename trigger (`onClick={onRename}`) — the two-item `Menu` this pass had briefly added
  is gone.
- Phone (`TopBar.tsx`): the button sits beside the avatar on the `home` shape, and beside the team
  stack on the `board` shape — the phone `TopBar` previously carried the identity control (and, for
  one pass, this entrance) only on `home`; the bell now reaches a board directly instead. The
  avatar itself is back to firing `onRename` directly, with no `ActionSheet`.

Both buttons carry a small warn-coloured dot (`.notify-dot`, `--status-blocked`) only when this
device's `PushState["kind"]` is `blocked` — every other state (including `on`) shows a bare bell,
so the entrance stays quiet rather than reporting status. The panel's own open state and this
device's `PushState` live in `App.tsx` (`pushKind`/`pushBusy`/`pushError`/`pushPanelOpen`), threaded
down via `onOpenNotifications` (and, for the dot, `pushKind`) through `Home`, `TopBar`, `BoardView`
and `AppTopBar`, so the one button per screen opens the one panel instance.

Reachable from a board as well as Home: a subscription is one device saying yes to everything, not
a fact about one board, so the entrance travels with the identity control rather than living only
on the screen that is the app.

**Seven states**, one `TREATMENT` record exported from `Notifications.tsx` keyed by
`PushState["kind"]`. The entrance button only ever reads two of its fields (`icon`, for the
bell/bellOff swap, and implicitly `kind === "blocked"` for the dot); everything else in the table
is the panel's:

| kind | icon | panel body | button |
| --- | --- | --- | --- |
| `on` | `bell` | lead line + `Send a test notification` + the Devices list | `Turn off` |
| `off` | `bell` | lead line only | `Turn on notifications` |
| `blocked` | `bellOff` | warn `.push-note`: "Notifications are blocked for this site. flock can't ask again." + an unblock hint line | none |
| `needs-install` | `bell` | attention `.push-note` with the three `Add to Home Screen` steps as a `<ol className="push-steps">` | none |
| `server-off` | `bellOff` | neutral `.push-note`: "This flock server has no notification key, so it can't send anything yet." + a `FLOCK_VAPID_PUBLIC_KEY`/`FLOCK_VAPID_PRIVATE_KEY` hint | none |
| `insecure` | `bellOff` | neutral `.push-note`: "Notifications need HTTPS. Open flock over https://, or on localhost." | none |
| `unsupported` | `bellOff` | neutral `.push-note`: "This browser doesn't support notifications. Chrome, Edge, Firefox and Safari 16.4+ do." | none |

`server-off` (§3.2) is new since the original contract: a key-less server used to fall through to
`unsupported`, which told the user their browser couldn't do something it actually could. It now
gets its own honest, muted state, and — because the key is prefetched (§3.3) rather than fetched
after the prompt — the entrance never fires an OS permission dialog it cannot make good on.
`blocked`/`needs-install`/`insecure`/`unsupported`/`server-off` all render no button in the panel,
because no button would work; the bell stays tappable in every state so the explanation is always
one tap away.

**Feedback.** Busy disables the panel's acting button, sets `aria-busy="true"`, and swaps its label
to `Turning on…`/`Turning off…`. Success is the state change itself — `on` shows the test-send
button and the Devices section, and the entrance drops its dot the next time `blocked` stops being
true; no toast. A failure renders `.inline-error` in the panel next to the button.
`onEnablePush`/`onDisablePush` in `App.tsx` both carry the `.catch` the original toggle handler
never had.

**Test send and the device list**, `on` only, inside the panel (`packages/web/src/Notifications.tsx`
and `packages/web/src/devices.ts`): a `Send a test notification` button over `api.pushTest()`,
result rendered as a `.push-hint` (`Sent to 1 device.` / `Sent to {n} devices.` /
`No devices to send to.` — never claiming success on `{ sent: 0 }`); and a `Devices` section over
`api.pushSubscriptions()`, fetched on panel open and re-fetched after a successful enable, disable
or remove. This device is identified by matching `currentSubscription()?.endpoint`, labelled
`This device`, and has no remove button (turning off is the remove for this device); every other
row gets a `.icon-btn` trash button calling `api.pushUnsubscribe` then refetching, no confirm
dialog. The raw user agent never appears as visible text — `deviceLabel(userAgent)` (pure, tested
in `devices.test.ts`) renders a short platform/browser label and the full string sits only in the
row's `title`. A failed test send or remove renders `.inline-error`, never a silent no-op. The list
scrolls inside `.sheet-body` and stays under `--vvh * 0.88`, same as every other `Sheet`.

Colour comes from existing tokens only (`--text`, `--muted`, `--danger`, `--dot-working`,
`--status-await`, `--status-blocked`, `--warn-bg`/`--warn-line`, `--attention-bg`/`--attention-line`,
`--bg-3`, `--line`); the `bun test` contrast gate over `styles.css` still passes. New rules live in
`styles.css` and define no hex.

**Preserve the iOS standalone work.** `main.tsx`'s viewport handling (`snapBack`, `revealField`,
`healViewport`, `repaintShell`, `installNoScrollFocus`) and the `--vvh` shell exist because of
real, measured iOS 26 bugs and are not to be touched, and `main.tsx` was not touched by this pass.
The notifications row is ordinary content inside the existing scroller: it adds no fixed
positioning, no new scroll container, and no viewport meta change. The panel is a plain `Sheet`
(`className="push-sheet"`, `hideClose`, a `.btn.btn-block.btn-ghost.sheet-cancel` reading `Done`) —
it inherits `--sab-in` and the `calc(var(--vvh) * 0.88)` cap from `Sheet` itself rather than
re-implementing either, so it stays inside the 793pt standalone viewport for free.

### 3.5 Receiving `flock:navigate`

In `App.tsx`, beside the existing `hashchange` listener:

```ts
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "flock:navigate" && typeof e.data.url === "string") {
    window.location.hash = e.data.url.replace(/^#/, "#");
  }
});
```

Setting `location.hash` (not `replaceState`) is right here: a tap on a notification is a fresh
navigation and should be in the back stack.

### 3.6 Manifest

**No change required.** `packages/web/public/manifest.webmanifest` is already `"display":
"standalone"`, `"scope": "/"`, `"start_url": "/"`, with 192px and 512px PNG icons — which is
exactly what an iOS home-screen install needs. `index.html` already carries
`apple-mobile-web-app-capable`, the `manifest` link, and the status-bar-style meta.

Do not change `display`, `scope` or `start_url`. `display` in particular is the gate: WebKit names
`standalone` and `fullscreen` as what makes a site a Home Screen web app, and MDN's compat data
puts it more sharply — the `Notification` interface is undefined on iOS "unless the page is a web
app saved to the home screen" and "the app's manifest must have a non-default `display` value".
Setting it back to `browser` (the default) would silently turn notifications off on iPhone while
everything kept working on the desktop.

### 3.7 The presence client: `packages/web/src/presence.ts`

New file. Pure logic, plus one hook wired into `Shell` (always mounted, so this runs on Home too).
See ADR 0021.

```ts
export const HEARTBEAT_MS = 15_000;   // matches PRESENCE_TTL_MS's three-heartbeat budget (§1.4)
export const IDLE_MS = 180_000;

export interface LookingInputs { visible: boolean; focused: boolean; lastInputAt: number; now: number }

/** Pure. `visibilityState === "visible" && document.hasFocus() && now - lastInputAt < IDLE_MS`. */
export function isLooking(inputs: LookingInputs): boolean;

export interface PresenceState { looking: boolean; board: string | null; lastSentAt: number }
export type PresenceAction = "send" | "beat" | "none";

/** Pure. "send" on any change of `looking` or `board` (including the first evaluation, `prev ===
 *  null`); "beat" while still looking once `HEARTBEAT_MS` has elapsed since the last send;
 *  otherwise "none". */
export function presenceStep(
  prev: PresenceState | null,
  next: { looking: boolean; board: string | null },
  now: number,
): PresenceAction;

/** One heartbeat per page load, wired into `Shell`. */
export function usePresence(actor: string, hash: string): void;
```

**Client id.** A module-level id generated once (`crypto.randomUUID()`, falling back to
`Math.random` only if `crypto.randomUUID` is unavailable) and held in ordinary module memory —
**never `sessionStorage`**, which Chrome copies into a duplicated tab and would merge two tabs'
presence into one (§1.4).

**Board.** Parsed from the hash directly (`#/b/<slug>/...` → `<slug>`; anything else, Home
included, → `null`) by a small local matcher that mirrors `App.tsx`'s route parsing without
importing it, so `presence.ts` has no dependency on the shell that mounts it.

**When it sends**, all driven by one `useEffect` in `usePresence`:

- Nothing at all while `actor` is empty (before `/api/me` resolves).
- Immediately on `visibilitychange`, `focus`, `blur`, `pageshow`, and on the board changing
  (hash-driven, since `usePresence` re-runs its effect on `[actor, board]`) — any of these can flip
  `looking` or `board`, and `presenceStep` fires `"send"` on either changing.
- Every `HEARTBEAT_MS` while still looking, via a 5 second re-evaluation interval that also catches
  the idle threshold lapsing (`IDLE_MS`) with no event of its own to trigger it.
- Once more with `looking: false` the moment looking stops, including on `pagehide` — sent via
  `fetch(..., { keepalive: true })` (`api.presence(body, { keepalive: true })`) so the leave signal
  survives the page going away; `sendBeacon` is not used because it cannot carry the
  `x-flock-actor` header.

`lastInputAt` is bumped by `pointerdown`, `keydown`, `wheel`, `touchstart`, `scroll` (capture
phase), and `pointermove` throttled to once per second, plus on the focus/visible transitions
themselves.

**`api.ts`** gains a `keepalive` passthrough on `req()` and:

```ts
presence: (body: { client: string; board: string | null; looking: boolean }, opts?: { keepalive?: boolean }) =>
  req<void>("POST", "/presence", body, undefined, opts),
```

**`App.tsx`**: `usePresence(actor, hash)` is mounted in `Shell`, right after the `actor` state
declaration; `main.tsx` is untouched, same as ADR 0017's iOS viewport work.

---

## 4. Testing

No real push service is involved at any layer.

### 4.1 Core — `packages/core/test/notify.test.ts`

`notificationFor` and `notifyTargets` are pure, so this is table-driven and cheap. Cover:

- Each of the three triggering rules: title, body, url and tag exactly.
- `card.moved` to a status that is not `awaiting-human` → `null`. Every other event type → `null`.
- `message.posted` with an empty body and one attachment → the "sent an image" body.
- A body longer than 140 characters → truncated with "…"; a multi-line body → first line only.
- **Author suppression**: a subscription whose `actor` equals `event.actor` gets nothing, and a
  second subscription with a different actor still does.
- Board scope: `boardId: null` matches every board; a specific `boardId` matches only its own.
- No subscriptions → `[]`, and no `notificationFor` call is observable as having any effect.

Storage tests (`packages/core/test/push.test.ts`, `:memory:` as usual): subscribe is an upsert on
endpoint and preserves `createdAt`; `unsubscribePush` returns false for an unknown endpoint;
`pushSubscriptions({ boardId })` returns board-scoped *and* global rows; deleting a board cascades
its scoped subscriptions away; `touchPushSubscription` moves `lastUsedAt`.

Add a `SCHEMA_VERSION` test if one does not exist: opening a database stamped 5 with this binary
still throws `SchemaVersionError`, and a v3 database opens and gains the new table.

`packages/core/test/presence.test.ts`: `report` with `looking: true` makes `isLooking` true for
that exact actor+board only (a different actor, a different board, and `boardId: null` all false);
TTL boundary at `t + PRESENCE_TTL_MS - 1` (true) and `t + PRESENCE_TTL_MS` (false); `looking: false`
removes the entry immediately; two clients of one actor are tracked independently (one leaving
doesn't clear the other); a client re-reporting a different board moves rather than duplicates;
`size()` prunes stale entries.

`packages/core/test/batching.test.ts` (stub `IsLooking` backed by a `Set`): a lone message
dispatches at once, plain payload, `renotify: true`; a second and third message inside the window
produce no dispatch and `due()` before `t0 + W` is empty; `due(t0 + W)` flushes one merged dispatch
(`"<n> new in <board>"`, latest body, `renotify: false`); a flush reopens the next window, so a
message right after it folds and a fully quiet window's next message is a fresh leading edge with
the accumulated count; `card.asked` and `card.moved` → `awaiting-human` mid-window dispatch
immediately with `renotify: true` and leave the message key's count/pending untouched; `isLooking`
true at offer time drops the pending batch with no dispatch, true at `due()` time drops it instead
of flushing; the recipient's own event on that board resets their key, on another board it does
not; keys are independent across actors and boards and the event's own author never appears as a
recipient.

`packages/core/test/notify.test.ts` (extended): `renotify: true` on all three `notificationFor`
rules; a `notificationClass` table covering every event type; `mergedNotification`'s title/body/
url/tag/seq and both `renotify` values; `recipientsOf` dedupes and preserves first-seen order.

### 4.2 Server — `packages/server/src/push.test.ts`

The injected `PushSend` is the whole strategy. A fake that records `(endpoint, payload)` and can
be told to reject with `{ statusCode: 410 }` covers everything worth testing:

- A `message.posted` event reaches every subscriber but the author.
- A 410 (and a 404, and a 403) prunes that subscription and leaves the others alone.
- A 429 and a 413 do **not** prune.
- A rejection with no `statusCode` does not prune and does not stop the pump.
- A success stamps `lastUsedAt`.
- The pump starts at `lastSeq()` and does not replay events written before it started.
- The payload is valid JSON and under 4 KB for a maximal message.

Routes get `app.request()` tests beside the existing ones in `index.test.ts` style: subscribe
returns 201 and never echoes `keys`; a second subscribe with the same endpoint is an upsert, not a
duplicate; DELETE for an unknown endpoint is still 204; a body missing `keys.auth` is 400;
`GET /api/push/key` returns the 87-character public key.

VAPID: point `flockHome` at a temp directory, assert `vapid.json` is created with mode 0600, that a
second call returns the identical keys, and that `FLOCK_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY` win over
the file.

**Batching and presence** (fake `now`, huge `intervalMs` so the real timer never fires; tests drive
`deliver`/`flush` directly): a burst of messages inside the window yields exactly one send, then
`now += BATCH_WINDOW_MS; await pump.flush()` sends one more, merged; `stop()` with a pending batch
sends nothing even after advancing the clock and calling `flush()`; a `Presence` reporting one actor
looking at the board suppresses that actor's channel message only (another recipient still gets it)
and does not suppress an ask to the looking actor; the pump's own `setInterval` tick flushes a due
batch on its own with no new event to trigger it (a real short interval plus a real sleep, not a
manual `flush()` call); a `POST /api/presence` sent through a real `app.request()` suppresses a
subsequent `flock.say` through the actual pump and `Presence` end to end, then un-suppresses once
that actor stops reporting looking.

**Send isolation (S1)**: a throwing send for one actor's dispatch does not stop another actor's ask
in the same batch; two dispatches are demonstrably sent in parallel, not sequentially (gate one
send, assert the other has already started before the first resolves); a throwing database write
(`touchPushSubscription`/`unsubscribePush`) for one endpoint does not block bookkeeping for another.

`app.request()` tests for `POST /api/presence`: 204 on a valid body, including with `push: false`;
400 on a missing `client`; 400 on a non-boolean `looking`; an unknown board slug is still 204, never
404.

**Not** in `bun test`: a round trip through the real `web-push` transport. It needs a TLS listener
because `web-push` calls `node:https` unconditionally, which means a self-signed certificate and
`NODE_TLS_REJECT_UNAUTHORIZED=0` in the suite — too much machinery for what it proves. It was
proven by hand during the design (a TLS `Bun.serve` returning 201/404/410; `WebPushError` carried
`statusCode` and `endpoint` as expected) and the result is recorded in the ADR.

### 4.3 Web — `packages/web/src/push.test.ts`

`pushState` is pure and enumerable: one case per `PushState`, plus the precedence cases that are
easy to get wrong — iOS Safari tab (service worker present, `PushManager` absent, not standalone)
must be `needs-install`, not `unsupported`; an insecure context must be `insecure` even when
everything else is present. `urlBase64ToUint8Array` gets a known-vector test against the 87-char
key format.

The service worker itself, the permission prompt, and the subscribe round trip are not unit
testable and are not faked. They are card #5's manual iOS checklist.

`packages/web/src/presence.test.ts`: `isLooking` truth table (hidden, unfocused, idle boundary at
exactly `IDLE_MS - 1` true and `IDLE_MS` false); `presenceStep` sends on the first evaluation and on
any change of `looking` or `board`, beats once `HEARTBEAT_MS` has elapsed while still looking, and
never beats while not looking.

### 4.4 Card #5's manual checklist

1. Serve over a secure context: `localhost` or any HTTPS origin. A Tailscale/LAN `http://` URL
   will not register a worker — confirm the row says "insecure" there. Note that the phone cannot
   use the Mac's `localhost`: the iPhone steps below need an HTTPS origin, not a dev server.
2. iPhone Safari, plain tab: the row says *Add to Home Screen*.
3. Add to Home Screen, open the installed app, tap "Turn on notifications", accept the iOS prompt.
4. `POST /api/push/test` (or the UI's own test affordance) → a banner arrives.
5. Background the app. From another device or the CLI, `flock say <board> "..."` as a *different*
   actor → a banner arrives. Say it as the *same* actor → nothing arrives.
6. `flock ask <board> <n> "..."` as an agent → a banner naming the card arrives; tapping it opens
   the app on `#/b/<slug>/c/<n>`.
7. Delete the home-screen app, reinstall, subscribe again → the old row is pruned on the next
   failed send, and there is exactly one live subscription.
8. Desktop Chrome and desktop Safari 16+: enable, background the window, confirm a banner. Neither
   needs installing — macOS Safari supports push from an ordinary webpage, so the `needs-install`
   state must **not** appear there.
9. Batching and presence (ADR 0021), one actor on both a desktop Mac and the iPhone standalone app:
   board focused on the Mac → an agent's `flock say` does not buzz the phone; blur the Mac (or move
   focus to another app) → the next `say` buzzes with the accumulated count; ten `say`s within 5
   seconds → one alert immediately, then one quiet "10 new in …" update roughly a minute later;
   `flock ask` buzzes both devices regardless of presence on either. Use a throwaway board or
   `FLOCK_DB` pointed at the scratchpad, deleted (or discarded) before close-out.
