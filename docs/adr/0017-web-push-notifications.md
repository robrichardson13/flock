# ADR 0017: Server-sent Web Push, aimed at the iOS home-screen app

**Status:** accepted, 2026-09-11

The exact signatures, schema, routes, file paths and UI states this decision implies are in
[docs/notifications-contract.md](../notifications-contract.md). This file is the reasoning; that
one is what cards #2–#4 build against.

## Context

flock's whole premise is that a human watches a board and steps in when a card says
`awaiting-human`. Today that only works while the web app is open in front of you. Two things
should reach a person who is not looking: a message landing in a board's channel, and a card
needing them — `flock ask`, or any move into `awaiting-human`.

The target is the phone, specifically the flock web app installed to the iOS home screen from
Safari. Desktop browsers should work, but they are not what this is for: the desktop already has
the tab open.

That target rules out almost everything. On iOS:

- The in-page `Notification` API does not exist in a plain Safari tab. Not "permission denied" —
  the whole interface is `undefined` unless the site was added to the Home Screen (MDN compat data;
  WebKit's iOS 16.4 announcement). So there is no page-side toast to fall back on.
- The app must be added to the Home Screen, and its manifest must carry a non-default `display`.
  There is no way around this and no way to prompt for it from script.
- Permission must be requested from a real user gesture — Apple's wording is to call the
  subscription method "immediately from the gesture's event handler code".
- Service workers and `PushManager` are secure-context only. `localhost` qualifies; the LAN and
  Tailscale `http://` URLs that ADR 0015 advertises do not.

And the mechanism flock already has does not survive the case that matters. `useCoalescedRefetch`
and the SSE stream at `/api/boards/:b/stream` only exist while a page is open and foregrounded; iOS
tears the connection down when the app is backgrounded, which is exactly the moment a notification
would be worth something. **Notifications have to be pushed by the server to the device, not
derived by the client from a stream it is no longer holding.**

## Decision

### Web Push, sent by the server from its own tail of the events table

The server runs one push pump for the life of the process: an independent poll of
`flock.events({ since })` across every board, cursored from `flock.lastSeq()` at startup so a
restart never replays a backlog. It is deliberately *not* hooked into the SSE handler — SSE
connections exist only while someone has the page open, and the entire point of push is to reach a
device with no page open. Same source of truth, separate consumer.

### `web-push`, not a hand-rolled sender

RFC 8291's `aes128gcm` payload encryption and RFC 8292's VAPID JWTs are both implementable on
WebCrypto, and flock's taste runs to few dependencies. We took the library anyway. The crypto is
exacting, wrong output fails at the device with no diagnostic we can see, and the one thing a
hand-rolled version would buy — no dependency — buys nothing in `packages/server`, which already
has Hono. `packages/core` stays dependency-free; `web-push` lives in the server alone.

The real question was whether it works on Bun. There is a known Bun bug where `web-push` payloads
fail AES-GCM decryption in the browser (oven-sh/bun#6455), fixed on main in July 2026 — *after* the
Bun 1.3.4 this repo pins. So it was checked rather than assumed, in three steps:

1. `generateVAPIDKeys()`, `setVapidDetails`, and JWT signing all work under Bun 1.3.4.
2. A real `sendNotification` against a TLS `Bun.serve` returns 201; a 404 and a 410 each throw a
   `WebPushError` carrying `statusCode` and `endpoint`, so the pruning rule below is implementable
   exactly as written.
3. The decisive one: a realistic notification encrypted by `web-push` under Bun 1.3.4 was decrypted
   **byte-identically by Node 24's `http_ece`** per RFC 8291. The payload is correct, not merely
   well-formed. bun#6455 does not affect this version.

One consequence of the library worth writing down: it calls `node:https` unconditionally, so no
plain-`http` stub can stand in for a push service. Tests inject the sender instead.

### VAPID keys live beside the rest of flock's state, not in the database

`$FLOCK_HOME/vapid.json` (so `~/.flock/vapid.json` by default), mode 0600, generated on first use.
`FLOCK_VAPID_PUBLIC_KEY` + `FLOCK_VAPID_PRIVATE_KEY` override it.

They are a property of the server deployment, not of the board data. The database is shared across
worktrees and can be swapped for an isolated one (`--isolated`, `FLOCK_DB`); the keys must not move
when it does, or every subscribed device silently dies. `~/.flock` is already where `run/`,
`logs/`, `update.json`, `skill.json` and `config.json` live, and it already follows `FLOCK_HOME`.
The env override exists for a deployment with no durable disk, where a generated file is lost on
every redeploy.

The subject defaults to `https://github.com/robrichardson13/flock`, not a `mailto:`. It has to be a
real, externally resolvable `https:` URL or `mailto:` URI: APNs rejects a placeholder such as
`mailto:flock@localhost` with 403 `BadJwtToken`.

### Subscriptions are rows in the database, keyed by endpoint

A new `push_subscriptions` table, `SCHEMA_VERSION` 3 → 4 by the existing additive rule — a new
`CREATE TABLE IF NOT EXISTS` in `SCHEMA` is its own migration, so `migrate()` gains nothing. A
subscription carries the push endpoint (unique), the device's `p256dh`/`auth` keys, the actor name
that registered it, an optional board scope, and created/last-used stamps.

These belong in the database rather than beside the keys because they reference boards and cascade
with them, and because `Flock` is where every domain rule lives. But registering a device emits
**no event**: it has no board to belong to, it is not something anyone did to the work, and it
would put a line in an activity feed every time a phone re-subscribes.

Scope is stored but unused for now — the web app always registers globally. The column is there so
per-board muting is a feature, not a migration.

### The trigger rules are one pure function in core

`notificationFor(event, ctx)` and `notifyTargets(event, ctx, subs)` in
`packages/core/src/notify.ts`: no database, no clock, no I/O. Three rules fire and everything else
returns null —

- `message.posted` → the board title, `"<actor>: <first line>"`, opening `#/b/<slug>/channel`.
- `card.asked` → `"#<n> needs you"`, the question, opening `#/b/<slug>/c/<n>`.
- `card.moved` with `to === "awaiting-human"` → `"#<n> is waiting on you"`, opening the same card.

**Never notify the actor who caused the event.** One filter, `sub.actor !== event.actor`, on the
same actor-name identity that `--as`, `x-flock-actor` and the web app's `localStorage["flock.actor"]`
already share. It is the rule most likely to be got wrong and the one most obviously wrong when it
is, so it is a pure predicate with its own test rather than a condition buried in the sender.

Nothing else filters. No per-event-type preferences, no quiet hours, no "is this human on this
board". A subscription is one standing request from one named person.

### The notification's tag *is* its route

MDN's compat data reports `notification.data` as unsupported on Safari and iOS Safari. Since that
is the primary target, routing cannot live there. The payload's `tag` is therefore set to exactly
the hash route, and the service worker reads `data.url ?? notification.tag`. This is not a
workaround so much as a coincidence worth taking: making the route the collapse key gives the
behaviour we wanted anyway — two messages in one channel, or two events on one card, replace each
other on the lock screen instead of stacking.

For the same reason nothing depends on `actions`, `renotify`, `requireInteraction`, `image` or
`vibrate`; all of them are unsupported on Safari, and a design leaning on any would work on the
desktop and quietly do nothing on the phone.

### The service worker is `packages/web/public/sw.js`, and it caches nothing

`public/` is copied verbatim and unhashed into `dist/`, so the file lands at `/sw.js` with no
change to `vite.config.ts`; `scripts/gen-assets.ts` picks it up like any other asset, and the
server's existing MIME map already serves `.js` correctly. Serving it from the root path is what
gives it scope `/`, so no `Service-Worker-Allowed` header is needed. The one server change is a
carve-out from the blanket `cache-control: immutable` that the static handlers put on anything with
an extension — right for Vite's content-hashed bundles, wrong for a filename that never changes.

**It has no `fetch` handler and must never grow one.** flock's assets are already hashed and served
immutable, offline is out of scope, and a caching worker would be a new and separate class of
stale-app bug landing on the one platform where a stuck cache is hardest for a user to clear.

It does always call `showNotification`, including on a malformed payload. We subscribe with
`userVisibleOnly: true` and WebKit revokes the subscription outright if a push arrives and nothing
is shown, so the fallback notification is what keeps the subscription alive, not politeness.

### The toggle is one row at the foot of Home

A subscription is one device saying yes to everything, so it belongs on the screen that is the app
rather than inside one board — and it lands in sight of "Waiting on you", which is the list
notifications exist to get you to. A real button with a direct `onClick`, no confirm step and
nothing awaited before the permission call, because iOS will not show the prompt otherwise.

The row says what is actually wrong rather than "unsupported", which is the failure mode that would
make this feature look broken to the person it is for. Six states, and the ordering between two of
them is the whole point: in a plain iOS Safari tab the capability check says "unsupported" while
the truth is "add it to your Home Screen and it will work", so the install check comes first.

## Consequences

- **iOS users must Add to Home Screen.** There is no prompt for it and no way around it. The UI
  explains it; nothing else can.
- **Notifications need a secure context: `localhost` or any HTTPS origin.** The LAN and
  Tailscale `http://` URLs that `flock up` prints (ADR 0015) do not qualify, and a service worker
  will not register there at all. Someone who lives on the Tailscale URL gets no notifications,
  and the row tells them why. Making those URLs HTTPS is a separate problem and not one this ADR
  opens.
- **Regenerating or losing the VAPID keys invalidates every subscription.** Devices then fail with
  403 and are pruned on the next send; each has to be re-enabled by hand. On an ephemeral
  filesystem, set `FLOCK_VAPID_PUBLIC_KEY`/`FLOCK_VAPID_PRIVATE_KEY` or this happens on every
  redeploy.
- **`SCHEMA_VERSION` 4 means an older flock binary refuses a database this one has opened**, per
  the existing guard. That is the guard working as designed, but it is a real upgrade ordering
  constraint for anyone running an installed binary and a checkout against `~/.flock/flock.db`.
- **A dead device is deleted, not remembered.** 404, 410 and 403 prune; 413 and 429 do not. There is
  no record of a subscription that used to exist, which is the right trade for something a browser
  can recreate with one tap.
- **The push pump runs whether or not anyone is subscribed.** It is one 500ms poll of a table the
  SSE loop already polls at the same cadence, and it does no work when `notifyTargets` is empty.
- **Nothing is notified about a board the subscriber has never seen.** Subscriptions are global by
  design, so a human with one device subscribed gets every board on that server. On a personal
  instance this is what you want; on a shared one it would not be, and the `board_id` column is
  already there for the day that matters.
- **The iOS standalone viewport work is untouched.** `main.tsx`'s `snapBack`, `revealField`,
  `healViewport`, `repaintShell` and `installNoScrollFocus`, and the `--vvh` shell, all stay exactly
  as they are; the notifications row is ordinary content in the existing scroller and adds no fixed
  positioning, no new scroll container and no viewport meta.

## Alternatives considered

**Declarative Web Push (iOS 18.4+).** A payload carrying `"web_push": 8030` and a `notification`
object is handled by Safari with no service worker at all, and degrades cleanly on older browsers,
so it looked close to free. It is not usable here: its `navigate` member requires an absolute URL,
and the push sender has no reliable idea what flock's public origin is. By ADR 0015 one server
answers on loopback, on every LAN address, on a Tailscale name and on a configured https URL
simultaneously, and the push pump runs outside any HTTP request that could tell it which one the
subscriber used. A
hash fragment resolved by the service worker against its own origin is the only form of route that
is correct for every subscriber. Revisit if an explicit public-origin setting ever exists.

**Polling from the page, or a foreground-only Notification API.** Both die with the SSE stream the
moment iOS backgrounds the app, which is the only case this feature exists for.

**Hand-rolled VAPID + `aes128gcm` on WebCrypto.** Rejected above: exacting crypto, invisible
failures, and no dependency saved where it counts.

**Keys or subscriptions in `config.json`.** The keys are secrets and belong in their own 0600 file,
not in a user-editable config documented as "only for turning something off". Subscriptions are
board-referencing rows and belong in the database.

**A `notifications` event type, or a `notified` flag on events.** Rejected: it would make delivery
part of board history, which it is not, and every board's activity feed would fill with plumbing.
The pump's cursor is in memory and starts at `lastSeq()`; a missed notification during a restart is
an acceptable loss for something whose whole value is timeliness.

## Amendment, 2026-09-11

The single-row UI this ADR shipped with — a bare toggle at the foot of Home — worked but read as
bolted on next to the rest of the app's polish. After Rob's design pass, it became a real
`Notifications` section on Home whose row opens a `Sheet` panel, reachable a second way from the
identity control (desktop `Menu`, phone `ActionSheet`); see
[docs/notifications-contract.md §3.4](../notifications-contract.md#34-where-it-lives-in-the-ui) for
the shipped shape. Nothing here changes: the protocol, the server routes, the schema and the
trigger rules are exactly what this ADR decided.

The design pass also added a seventh `PushState` kind, `server-off`, because the original UI's
`unsupported` state was covering for it dishonestly. A server with no VAPID key used to make the
row tell the user their *browser* couldn't do notifications — the row had no way to distinguish "the
browser can't" from "the server never configured a key", so it picked the wrong lie. `server-off`
says the true thing, and — because the VAPID key is now prefetched at App mount instead of fetched
after `Notification.requestPermission()` (§3.3) — a key-less server can be detected before the OS
prompt would have fired at all, not merely explained after the fact.

## Amendment, 2026-09-11

"Nothing else filters. No per-event-type preferences, no quiet hours, no 'is this human on this
board'" above now has one exception: a channel message (`message.posted` only, never an ask) is
suppressed for a recipient who is actively looking at that board on any device, and the pump folds
a burst of channel messages into one leading-edge alert plus one trailing merged update rather than
sending every one. Both are decided in full, including every rejected alternative, in
[ADR 0020](0020-batching-and-presence-on-the-push-pump.md); see
[docs/notifications-contract.md](../notifications-contract.md) §1.3, §1.4, §2.3, §2.4, §3.1 and §3.7
for the shipped shapes. `renotify`, noted above as unused, is now set as an enhancement
(`true` on a leading edge and every ask, `false` on a trailing flush) so Chrome/Edge alert correctly
on a same-tag replacement — this does not contradict "nothing depends on `renotify`", since Safari,
iOS Safari and Firefox still ignore it and the batching cadence caps the alert rate regardless.
Nothing else here changes: the protocol, the trigger rules' author filter, and the schema are
exactly what this ADR decided.
