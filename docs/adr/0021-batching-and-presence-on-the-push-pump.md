# ADR 0021: Notification batching and presence on the push pump

**Status:** accepted, 2026-09-11

The exact signatures, constants and routes this decision implies are in
[docs/notifications-contract.md](../notifications-contract.md) §1.3, §1.4, §2.3, §2.4, §3.1 and
§3.7. This file is the reasoning.

## Context

ADR 0017 shipped one push per event, sent the moment the pump's 500ms tail sees it, and filtered
only on "not the author". That is right for an ask — the product exists to get a human's attention
on a card — and wrong for a busy channel: a conducted run posts a status line every few seconds for
minutes, and Rob asked for two things on top of the existing pump rather than a redesign of it.

**Batching.** Channel chatter should coalesce into one alert, then one quietly-updating count,
instead of buzzing on every line.

**Presence.** A device actively looking at a board already sees its channel messages; pushing them
too is redundant and, on iOS, a redundant lock-screen buzz for something already on screen reads as
broken.

Both are small and both compose with what ADR 0017 built rather than replacing any of it: no schema
change, no new config knob, no change to the push wire protocol (VAPID, subscription shape). The
payload JSON gains one optional field, `renotify`, which old service workers ignore.

## Decision

### Batching is a leading-edge throttle, keyed by (recipient actor, board), for channel messages only

Only `message.posted` batches. `card.asked` and `card.moved` → `awaiting-human` are sent
immediately and never touch batch state — asks are the reason flock exists, they are rare, and
delaying or folding one buys almost nothing while costing the one thing that matters. They also
carry a per-card tag, so they never stack against the channel notification anyway.

The key is the recipient actor and the board, not the subscription (device) and not the card.
Every device of one person should say the same thing — keying per endpoint would give the Mac and
the phone independent windows and counts for the same human, and presence is already per actor.
Messages have no card, and the existing tag is already one per board's channel, so the key maps
onto exactly the notification grain the UI already has.

The throttle is leading-edge, not a debounce: the first message after a quiet period dispatches at
once (`packages/core/src/batching.ts`'s `NotificationBatcher.onEvent`), and later messages inside
the window fold into one payload that flushes when the window ends (`due()`). A pure debounce (wait
a short window before ever sending) was rejected — it delays the common case, a single status line,
and has no ceiling under a sustained stream. Leading-edge throttle has neither problem and needs no
separate cap.

The window is `BATCH_WINDOW_MS = 60_000`. Thirty seconds was considered and rejected: agent runs
post in bursts spaced 20–60 s apart, so a 30 s window would re-alert on nearly every burst.
120 s and up starts to feel broken ("I got the notification two minutes late"). A minute is still
timely for "someone said something in the channel", which is the non-urgent class by construction —
anything urgent is an ask, and asks bypass this entirely.

A merged notification's title is `"<n> new in <board>"` with the latest message as the body, same
tag/route as an unmerged message so the device holds one updating notification per board channel.
`n` counts messages since the recipient last looked at that board (reset per the presence rule
below, or by the recipient's own write to the board), so it stays honest even after a lock-screen
swipe.

The batcher lives in `packages/core/src/batching.ts` and takes `isLooking` as an injected function
(`IsLooking`), not a `Presence` instance, so it has no dependency on the presence module and could
be built and tested against a stub before presence existed.

A restart drops pending batches and resets counts: the batcher is in-memory, like the pump's
cursor, and `stop()` swaps in a fresh `NotificationBatcher` rather than flushing on the way out —
flushing means awaited network sends during shutdown, and the daemon's restart path kills the child
anyway. This matches ADR 0017's existing stance that a missed notification during a restart is an
acceptable loss for something whose whole value is timeliness.

### `renotify` fixes a latent same-tag bug and marks a leading edge vs. a quiet update

The payload gains `renotify: boolean`, `true` on all three `notificationFor` rules (every ask, and
a leading-edge or new-burst channel message) and passed through explicitly as `false` on a trailing
flush. Chrome and Edge silently swallow the alert on a same-tag notification replacement unless
`renotify` is set — without it, a new burst arriving after an old same-tag notification is still on
screen lands with no buzz at all, a bug that predates this ADR. `sw.js` passes the field straight
through to `showNotification`, guarded against firing `renotify: true` with an empty tag (Chrome
throws), which cannot happen in practice since tag is always the route. Safari, iOS Safari and
Firefox ignore the field; nothing depends on it, keeping ADR 0017's rule that nothing depends on
`renotify` true even though it is now set.

### Presence is a client heartbeat held in memory by a core `Presence` model, not SSE and not the service worker

`POST /api/presence`, body `{ client, board, looking }`, actor from the same `x-flock-actor` header
every route uses, mounted in `createApp` whether or not push is enabled — it is tiny, in memory,
and a device with no subscription of its own (a desktop Mac) still needs to suppress a device that
does (a phone).

`client` is a random id generated once per page load and held in module memory, not
`sessionStorage` — Chrome copies `sessionStorage` into a duplicated tab, which would merge two
tabs' presence into one and defeat independent per-tab tracking. `board` is the slug parsed from
the hash route, or `null` on Home; an unknown slug resolves to `boardId: null` rather than 404ing,
since presence is best-effort and a 404 would spam the console over a board deleted out from under
an open tab.

**"Looking"** requires the tab to be visible, focused, and to have had user input in the last three
minutes (`IDLE_MS = 180_000`), on that specific board. Focus is required, not just visibility,
because a common pattern is a focused terminal with the board merely visible on another monitor —
that is "might glance", not "looking", and a false buzz costs a glance while a false suppression
costs a missed message. Idle is required for the same reason: a board left open on screen while
away from the desk should not silently suppress channel pushes until the screen locks. Idleness can
only be computed on the client, which is the only place with input events; the server only needs
"is there a fresh looking report".

The client reports on every change of `(looking, board)` immediately, every `HEARTBEAT_MS = 15_000`
while still looking, and once more with `looking: false` on the way out (blur, hide, or
`pagehide`), sent with `fetch(..., { keepalive: true })` — `sendBeacon` cannot carry the
`x-flock-actor` header — so the leave signal survives the page going away. Nothing is sent while
the actor name is still empty (first load, before `/api/me` resolves).

The server holds presence in a core `Presence` class, keyed by `client` so two tabs of one person
track independently, with `PRESENCE_TTL_MS = 45_000` — three heartbeats, tolerating two lost beats
on a flaky connection and bounding false presence after a crash or a lost leave beacon to 45
seconds. For channel messages, the only thing presence suppresses, a 45 s tail of stale "looking"
is harmless: the cost is at most one suppressed message the recipient does not immediately see, not
one lost outright, since it is still sitting in the channel. There is no persistence; after a
restart everyone is absent until their next beat, so the only failure mode is an extra
notification, never a lost one.

### Presence suppresses only channel messages, for that actor across every device

Looking at a board on any one device silences that board's channel messages on every device that
actor has subscribed — the Mac being focused on a board suppresses the phone too. This is the Slack
rule (active on desktop, no mobile push) narrowed to the one board in view, because flock has no
in-app surface for any other board. The notification's only job is to get the person to the board;
if they are already there, on any device, the job is done.

Presence never suppresses an ask, on any device. Browser presence has failure modes acceptable for
chat and not for an ask: focused-but-away within the idle window, a lost leave beacon inside the
TTL, a phone pocketed seconds after being looked at. A redundant ask popup costs a glance; a missed
one stalls an agent indefinitely.

### Being seen resets the batch: presence and the recipient's own writes both count

A key whose actor `isLooking` on that board — checked both at offer time and on every `due()`
tick — has its pending batch dropped and its count zeroed. Opening the board from a notification
tap therefore clears the count; the next message is a fresh leading edge. Any event authored by the
recipient on that board, of any type, resets the same key: writing to a board (posting, answering,
moving a card, from the CLI or the web) is at least as strong a signal of attention as a heartbeat,
and it is free — every event already flows through `NotificationBatcher.onEvent` before it decides
whether to dispatch anything, so the author-seen reset applies uniformly even to events that notify
nobody.

### No schema change, no config knobs

Presence and batch state are process memory, like the existing pump cursor: both are transient by
nature (presence lives 45 s, a batch 60 s), and losing them on restart costs at most one missed
low-urgency update, never a stuck or duplicated one. No `SCHEMA_VERSION` bump, so no shared-DB or
worktree lockout. The four new constants (`BATCH_WINDOW_MS`, `PRESENCE_TTL_MS` in core;
`HEARTBEAT_MS`, `IDLE_MS` in web) are not wired to `config.json` or an environment variable — the
constructor options that make them adjustable in tests exist for tests only. If a number proves
wrong, it is a one-line change, and adding a knob is easy to do later without a migration.

## Consequences

- **A restart drops pending batches and resets counts.** A trailing flush already in flight is
  lost; the leading-edge alert already fired, and every message is still visible in the channel, so
  the loss is a quiet count reset, not a missed conversation.
- **A same-name actor on two people's devices suppresses each other.** Presence and batching are
  both keyed by actor name, exactly like ADR 0017's author filter. On a personal instance this does
  not arise; it is the same trust model ADR 0017 already accepted.
- **Safari, iOS Safari and Firefox ignore `renotify`.** There the alert behaviour on a same-tag
  replacement is whatever the platform does; batching still caps the buzz rate at one push per key
  per minute regardless, since nothing depends on the field being honoured.
- **Presence adds one small `POST` roughly every 15 seconds per focused tab**, plus one on every
  visibility/focus/board change and one on the way out. It is a 204 with a tiny JSON body against
  an in-memory map; the existing SSE tail already polls at 500 ms, so this is a small addition to
  request volume, not a new order of magnitude.
- **`stop()` never flushes.** A pending trailing batch is dropped, not sent, on shutdown — matching
  ADR 0017's stance that a missed notification during a restart is acceptable for a feature whose
  whole value is timeliness.
- **The merged count can look surprising across a flush-then-look sequence**, but is correct by
  construction: `count` is "since last seen" and is untouched by a flush itself, only by a presence
  reset or the recipient's own write, so a swiped-away notification's count is never silently lost.

## Alternatives considered

**SSE-based presence.** Rejected: `EventSource` cannot set headers, so the server has no way to
know which actor holds a stream (the actor travels as `x-flock-actor` on `fetch` only, and
`EventSource` cannot send custom headers). `Shell` always holds one `/api/stream` connection
regardless of which board, if any, is on screen, so an open stream says only "a tab exists," not
"someone is looking at this board." Desktop browsers also keep a stream open in background and
unfocused tabs indefinitely, and while iOS does tear the connection down on backgrounding, it does
so with enough lag, and with no signal distinguishing a background transition from an ordinary
network blip, that the server could not tell the two apart. Visibility, focus and idleness are only
knowable inside the page, so the page has to report them explicitly.

**Service-worker-side suppression.** Rejected. Suppressing in the `push` handler
(`clients.matchAll()` → a focused client on this board → skip `showNotification`) fails on every
axis that matters here: Safari revokes the whole subscription after a push that shows nothing
(the exact constraint ADR 0017's "every push must end in a visible notification" already works
around), Chrome's `userVisibleOnly` enforcement replaces a suppressed push with a generic "this
site has been updated in the background" notification that is worse than the one being suppressed,
a worker can only see its own device's clients so "looking on the Mac, don't buzz the phone" is not
implementable there at all, and by the time the worker sees the push, sending it has already spent
the batching, radio wake-up and push-service quota the suppression was meant to save. Server-side is
the only place that sees every device and can decide before sending.

**Schema-backed presence.** A `presence` table was not seriously pursued: presence is inherently
transient (a 45 s TTL), so persisting it buys nothing a restart's own re-heartbeat within 15 s
doesn't already provide, and it would be the first table in flock whose rows are meant to expire
rather than accumulate as board history.

**Config knobs for the batch window, TTL, heartbeat or idle threshold.** Rejected for now: these
are four constants with reasoned defaults above, not per-deployment policy, and `config.json` is
documented as "only for turning something off" (ADR 0017). Making one configurable later, if a
number proves wrong in practice, is a one-line change; pre-building the knob is speculative.

**Suppressing an ask on only the device that is looking**, by carrying a subscription endpoint in
the heartbeat instead of only an actor. Considered and deferred: it would remove one redundant
desktop popup at the cost of a second suppression rule, and exactly the failure mode §"Presence
suppresses only channel messages" already rejects for asks in general — a phone pocketed seconds
after being looked at would then also miss the ask on that device specifically.

**Per-subscription (per-device) batch keys instead of per-actor.** Rejected: it would give a
person's Mac and phone independent windows and independently wrong counts for what is, from the
user's point of view, one conversation they have or have not seen.

**Persisted batch state across a restart.** Rejected along with the schema-backed presence
alternative above, for the same reason ADR 0017 already accepts losing pending push state on
restart: the feature's whole value is timeliness, and a restart is rare enough that losing at most
one pending count is an acceptable trade against the complexity of persisting transient state.
