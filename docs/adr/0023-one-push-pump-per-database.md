# ADR 0023: One push pump per database, held by a lease

**Status:** accepted, 2026-09-12

## Context

The phone showed the same notification three times inside the same minute: three identical "4 new
in flock" rows in the iOS tray, plus one "#51 needs you", with a badge of 6.

The subscription table was innocent. `push_subscriptions.endpoint` is `UNIQUE` and `subscribePush`
is an `ON CONFLICT(endpoint) DO UPDATE` upsert, so a browser that re-subscribes rebinds its row and
never adds a second one; 404, 410 and 403 already prune. The database held exactly one row for the
device — one endpoint, one phone.

The servers were the problem. `flock status` listed three `serve` processes, each on its own ports
and each with `"db": "/Users/robrichardson/.flock/flock.db"`: the canonical checkout plus two
worktree dev environments. That is the normal state of this machine, and ADR 0003 designed for it —
a checkout per feature, all of them on the shared database by default (ADR 0021). What nobody
designed for is that `createApp` starts a push pump unconditionally whenever VAPID resolves. Three
apps meant three pumps, each tailing the same `events` table from its own in-memory `since`, each
with its own `NotificationBatcher`, each fanning out to the same one endpoint. One channel burst
became three deliveries. The badge of 6 is the arithmetic: 3 batches + 3 asks. The three asks shared
the tag `#/b/flock-2/c/51` and collapsed into one visible row; the three batch pushes did not.

Nothing about this is specific to duplicate checkouts. An installed daemon running beside a
checkout does it too, and so would two instances of a hosted deploy on one volume.

Three ways out were on the table:

1. **Don't run a pump in a checkout.** Wrong shape: which process should notify is not a property
   of how flock was installed, and it would leave a machine with no daemon silently unnotified.
2. **Deduplicate at delivery** — record every `(endpoint, notification)` pair and skip a repeat.
   Needs a durable, pruned log of everything ever sent, to fix a problem that is really about two
   processes doing one job.
3. **Elect one deliverer.** The database is the resource they share and the only thing all of them
   can see, so it is where the election belongs.

## Decision

**Exactly one process delivers push for a given database at a time, chosen by a lease in that
database.**

- A `push_lease` table holds one row, `id = 'singleton'`: the owner's id, its pid, when it first
  took the lease, and an expiry in epoch milliseconds. `expires_at` is a number rather than the ISO
  string the rest of the schema uses because it is only ever compared against the pump's injected
  clock, never shown to anyone. Schema version 7.
- `Flock.acquirePushLease({ owner, ttlMs, at, pid })` claims or renews it in one upserting
  statement, so it is atomic under SQLite's write lock. The `WHERE` clause lets a writer through
  only when it already owns the lease (a renewal) or when the incumbent's has expired (a takeover
  after a crash or a `kill -9`). It returns whether the caller holds the lease afterwards. A ttl
  outside 1..60000 ms and an empty owner are rejected: a typo must not mute push for hours.
- Every pump tick claims the lease before it does anything else. The holder tails and delivers as
  before. A follower fast-forwards `since` to `lastSeq()` and drops its batcher, so when it does
  take over it starts from now instead of replaying a backlog its predecessor already sent, and no
  half-built batch escapes late.
- The claim fails **closed**. If it throws, this process does not deliver on that tick. A late
  notification is better than the same one on every device, and the next tick is 500ms away.
- `stop()` releases the lease, so a restart takes over at once instead of waiting out the ttl. The
  release is owner-scoped: a process that already lost the lease can never evict its successor.
- The ttl defaults to ten tick intervals, floored at five seconds. Renewal happens every tick
  (500ms by default), so a killed leader is replaced within seconds while a merely slow tick never
  hands delivery away mid-batch. Each transition logs one line, so `flock logs` says which process
  is delivering and which are standing by.

`deliver()` and `flush()` stay unguarded: they are the test seam and are called directly only by
tests and the `/api/push/test` route. The tail is the only thing the lease gates.

## Consequences

One event is one notification per device however many servers are up. The cost is that push now
depends on a small piece of shared state: if the lease row is somehow stuck with a live owner that
has stopped ticking, nothing is delivered until it expires — bounded at 60 seconds by the ttl
ceiling, and five in practice.

There is no cleanup migration to write. The duplicate rows people assume are behind a bug like this
never existed; the schema already prevented them. Existing databases pick the table up on their
next open, and the lease is claimed on the first tick after that.

Presence (ADR 0021) is per-process and stays that way. It is reported over HTTP to whichever server
the browser is talking to, and only the leader's copy now has any effect on delivery — which is a
separate problem, tracked on its own card: a phone talking to server A while server B holds the
lease will not have its presence honoured.
