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

/** The notification this event deserves, or null when it deserves none. */
export function notificationFor(event: Event, ctx: NotifyContext): NotificationPayload | null;

/** Every (subscription, payload) pair this event should produce. Empty when nothing applies. */
export function notifyTargets(
  event: Event,
  ctx: NotifyContext,
  subs: readonly PushSubscriptionRecord[],
): NotifyTarget[];

/** First non-empty line, collapsed whitespace, truncated with a trailing "…". Exported for tests. */
export function summarize(text: string, max?: number): string; // max default 140
```

**`notificationFor` — the complete rule table.** Every event type not listed returns `null`.

| `event.type` | Condition | `title` | `body` | `url` | `tag` |
| --- | --- | --- | --- | --- | --- |
| `message.posted` | always | `ctx.boardTitle` | `` `${event.actor}: ${summarize(data.body)}` ``, or `` `${event.actor} sent an image` `` when `data.body` is empty and `data.attachments > 0` | `#/b/<slug>/channel` | = `url` |
| `card.asked` | always | `` `#${cardNum} needs you` `` | `` `${event.actor}: ${summarize(data.question)}` `` | `#/b/<slug>/c/<n>` | = `url` |
| `card.moved` | `data.to === "awaiting-human"` | `` `#${cardNum} is waiting on you` `` | `ctx.cardTitle ?? ""` | `#/b/<slug>/c/<n>` | = `url` |

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
 *      no durable disk, e.g. Railway, where a generated file would be lost on every redeploy and
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
  /** Stop the tail. Called from the server's shutdown path and from tests. */
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
}): PushPump;
```

**How it tails.** The same source SSE uses — `flock.events({ since })` over the whole database,
no `boardId` — but its own independent loop, started once in `createApp` and living for the life
of the process. It is deliberately *not* wired into the SSE handler: SSE streams exist only while
a browser has the page open, and the entire point of push is to reach a device with no page open.
Cursor starts at `flock.lastSeq()` so a restart does not re-notify the backlog.

**Per event:**

1. Resolve the context. `flock.board(event.boardId)` for slug and title; `flock.card(event.boardId,
   event.cardNum)` for `cardTitle` when `event.cardNum !== null`. Skip the event if either throws
   (a board deleted between the write and the tail).
2. `const subs = flock.pushSubscriptions({ boardId: event.boardId })`.
3. `notifyTargets(event, ctx, subs)`. Empty → done, no work.
4. Send each target: `send(target.subscription, JSON.stringify(target.payload))`, all in parallel
   with `Promise.allSettled`.
5. Success → `flock.touchPushSubscription(endpoint)`.
6. Failure:
   - `statusCode` **404 or 410** → `flock.unsubscribePush(endpoint)`. Gone means gone: the browser
     profile was cleared, the home-screen app was deleted, or the subscription expired.
   - `statusCode` **403** → also prune, and log once. 403 is "this subscription was made with a
     different VAPID key", which is unrecoverable for that device.
   - **413** (payload too large) → log, keep the subscription. A bug on our side, not the device's.
   - **429** → log, keep. Back-pressure, not a dead device.
   - anything else, including a network error with no `statusCode` → log one line to stderr, keep.
7. Never let a send failure escape the loop. One bad endpoint must not stop the tail.

Logging is `console.error` with a `[push]` prefix, matching `[board-create ...]` elsewhere.

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

`showNotification` fields beyond `title`, `body`, `tag`, `data`, `icon` and `badge` are not used.
MDN's compat data records `actions`, `renotify`, `requireInteraction`, `image` and `vibrate` as
unsupported on Safari and iOS Safari, so a design that leaned on any of them would work on the
desktop and quietly do nothing on the primary target. `icon` and `badge` are set because they cost
nothing and help on Chrome and Android; expect iOS to ignore `badge` (WebKit bug 280160) and to
use the home-screen icon regardless.

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
  | { kind: "unsupported" };

/** Pure. Unit-tested exhaustively in push.test.ts. */
export function pushState(env: PushEnv): PushState;

export function readPushEnv(subscribed: boolean): PushEnv;   // reads the real browser
export async function enablePush(): Promise<PushState>;      // must be called from a user gesture
export async function disablePush(): Promise<PushState>;
export async function currentSubscription(): Promise<PushSubscription | null>;
```

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

`enablePush()`, in order, with every step inside the same user-gesture task:

1. `const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" })`, then
   `await navigator.serviceWorker.ready`.
2. `const permission = await Notification.requestPermission()`. **This call must be reached from a
   user gesture** — do not `await` anything slow before it that could break the gesture chain on
   iOS. Apple's wording is "call the push subscription method immediately from the gesture's event
   handler code". Registering the worker first is fine; a network fetch before it is not, which is
   why `GET /api/push/key` comes after the prompt and not before it.
3. Bail to `{ kind: "blocked" }` unless `permission === "granted"`.
4. `const { publicKey } = await api.pushKey()`.
5. ```ts
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,              // required; iOS and Chrome both reject false
     applicationServerKey: urlBase64ToUint8Array(publicKey),
   });
   ```
6. `await api.pushSubscribe({ ...sub.toJSON(), userAgent: navigator.userAgent })` —
   `PushSubscription.toJSON()` already yields `{ endpoint, keys: { p256dh, auth } }`, the exact
   request shape in §2.3. Send no `boardId`: subscriptions are global (§1.1).
7. Return `{ kind: "on" }`.

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

A single row at the **foot of Home** — the last child of `.screen-body.home` in `App.tsx`'s `Home`,
after the boards list, in `<section className="settings">`. On both phone and desktop.

Home, not a board: a subscription is one device saying yes to everything, and Home is the screen
that is the app rather than a screen that is one board. It also puts the toggle in sight of
"Waiting on you", which is the list notifications exist to get you to.

The row renders per `PushState`:

| state | what it shows |
| --- | --- |
| `on` | "Notifications are on for this device." + a "Turn off" button |
| `off` | A "Turn on notifications" button. Below it, muted: "Get a notification when someone posts in a channel, or when a card needs you." |
| `blocked` | "Notifications are blocked. Turn them back on in your browser or device settings." No button — `requestPermission` cannot recover from `denied`. |
| `needs-install` | "Add flock to your Home Screen — Share → Add to Home Screen — then turn notifications on from there." No button. |
| `insecure` | "Notifications need a secure connection. Open flock over HTTPS, or on localhost." No button. |
| `unsupported` | "This browser doesn't support notifications." No button. |

The button is a real `<button>` with a direct `onClick` that calls `enablePush()` — no confirm
dialog, no `await` before the permission call. iOS will not show the system prompt otherwise.

Colour comes from existing tokens only (`--text`, `--muted`, `--line`, `--accent`, `--warn`); the
`bun test` contrast gate over `styles.css` must still pass. New rules go in `styles.css` and
define no hex.

**Preserve the iOS standalone work.** `main.tsx`'s viewport handling (`snapBack`, `revealField`,
`healViewport`, `repaintShell`, `installNoScrollFocus`) and the `--vvh` shell exist because of
real, measured iOS 26 bugs and are not to be touched. The notifications row is ordinary content
inside the existing scroller: it adds no fixed positioning, no new scroll container, and no
viewport meta change.

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

### 4.4 Card #5's manual checklist

1. Serve over HTTPS (Railway) or `localhost`. A Tailscale/LAN `http://` URL will not register a
   worker — confirm the row says "insecure" there. Note that the phone cannot use the Mac's
   `localhost`: the iPhone steps below need the HTTPS deployment, not a dev server.
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
