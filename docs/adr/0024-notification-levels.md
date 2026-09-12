# ADR 0024: Notification levels, declared by the agent and filtered by the human

**Status:** proposed, 2026-09-12

Builds on [ADR 0017](0017-web-push-notifications.md) (the pump and the trigger rules),
[ADR 0021](0021-batching-and-presence-on-the-push-pump.md) (batching and presence) and
[ADR 0023](0023-one-push-pump-per-database.md) (the delivery lease). The signatures, routes and
constants this implies land in [docs/notifications-contract.md](../notifications-contract.md); this
file is the reasoning.

## Context

Today a push is produced by three rules in `notificationFor` (`packages/core/src/notify.ts`):
`card.asked`, `card.moved` → `awaiting-human`, and `message.posted`. The first two are the reason
flock exists. The third is every line a conducted run posts, and a run posts a lot of them.
ADR 0021 made that bearable — one alert, then a quietly-updating count, suppressed while the person
is looking at the board — but it only changed the *rate*. The set of things worth a buzz is still
"everything anyone says", and the only control the human has is the one button in the notifications
sheet, which is really the browser subscription: on, or nothing at all.

Rob asked for the missing axis. He named four kinds of notification he'd choose between:

- **needs-me** — an agent asked him something, or a card is `awaiting-human`. Non-negotiable.
- **review requested** — a PR is up, or screenshots are attached for him to look at. Not blocking,
  but he wants to know now rather than at the next glance.
- **settled** — nothing has happened for a while, worth a check-in.
- **everything** — today's behaviour, kept as an option.

And he asked for the other half of it: the agent posting the message should be the one to say
whether it deserves a notification, with the human's settings deciding which of those declarations
actually reach a device — possibly differently per board.

That split is the interesting part. A heuristic over message text will never reliably tell "the
screenshots are up" from "starting card 41"; the conductor already knows which one it just wrote.
But an agent's judgement cannot be the last word either, or every agent that wants attention gets
it. So: the author *classifies*, the human *subscribes*.

Constraint: card 54 is live in presence.ts, the push client, and the server's presence logging.
Nothing here touches those files. The settled timer needs presence, so it takes `isLooking` as an
injected function, the way `NotificationBatcher` already does.

## Decision

### Three levels on a post, ordered, with a fourth kind that is not a post at all

A notification-producing event carries exactly one level:

| Level | Means | Reaches the human as |
| --- | --- | --- |
| `needs-me` | The board is blocked on the human. | Always, unless they turn it off. |
| `review` | Something is ready for the human to look at; nothing is blocked. | On by default. |
| `info` | Progress, status, plans, findings. | Off by default. This is "everything". |

`settled` is deliberately not in that list. It is not a property of any post — it is the *absence*
of posts — so it is synthesized by the server (below) and appears only as a fourth toggle in the
settings. Squeezing it into the ordering would have made the ordering a lie: a quiet board is not
more urgent than a PR and less urgent than an ask, it is orthogonal to both.

The three levels are ordered `needs-me > review > info` for one purpose: presentation, and the
precedence rule below. Delivery does not use the order (see "the toggles are independent").

### The level is on the event, not on the message

`event.data.level` carries it. No column on `messages` or `comments`, and no new event types.

The level describes *delivery*, not content: it is what the author asked the pump to do with this
post, and the pump reads events. Putting it in `data` means the pump gets it for free, `flock log
--json` shows it for free, and the only schema change in this ADR is the settings table.

The cost is that the level cannot be re-derived for an old event — an event written before this
ships has no `level` key. That is fine: delivery is live-only, the pump never replays history
(ADR 0017), and a missing key resolves through the same fallback chain as everything else.

### Precedence: intrinsic, then the author's flag, then a heuristic, then `info`

Resolved by one pure function, `levelFor(event, ctx): NotifyLevel | null` in
`packages/core/src/notify.ts`, in this order. First match wins.

1. **Intrinsic.** `card.asked` and `card.moved` → `awaiting-human` are `needs-me`, always. An
   explicit flag on them is ignored — `ask` cannot be downgraded. The whole product is one promise:
   if an agent parks a card on the human, the human hears about it.
2. **The author's declaration.** `--level review|info` on `flock say` and `flock comment`, and the
   `x-flock-notify` request header on the API's equivalents. Wins over every heuristic below.
3. **Heuristics**, in order:
   - a `comment.posted` carrying one or more image attachments → `review`. Screenshots exist to be
     looked at, and d13 already requires them on any card with a visible result, so the common case
     needs no flag at all.
   - a `message.posted` or `comment.posted` whose body contains a GitHub pull-request URL
     (`github.com/<owner>/<repo>/pull/<n>`) → `review`. That is d12's "Land: <feature>" moment, and
     it is the one text pattern specific enough to match on.
4. **Default `info`.** Anything else an agent posts.

An event that produces no notification today still produces none: `levelFor` returns `null` for
every type outside `notificationFor`'s three, and this ADR adds no new triggers.

**A human's own post never pushes to that human.** That is today's author filter in `notifyTargets`
(`sub.actor === event.actor`), unchanged, and it is why nothing here needs a rule about levels on
human writes: whatever Rob types in the channel is classified like any other post and then filtered
out of his own device before it can reach one.

### `needs-me` cannot be claimed by a channel message

`flock say --level needs-me` and `flock comment --level needs-me` are refused (exit 1) with a
pointer to `flock ask`.

`needs-me` is not a mood, it is a claim that the board has something the human can act on and
close. A channel line cannot be answered, cannot be released, and does not appear in
`flock needs-me`. If an agent needs the human, the card is the place, and `ask` already puts it
there. Reserving the level this way also keeps it trustworthy: an agent that wants attention badly
enough to lie can still set `review`, which is why `review` is a "look at this" and not a "do
this".

`review` and `info` are both fair game for `say` and `comment`, because both are genuinely things a
human might want pushed or not want pushed, and neither makes a promise about board state.

### Settings are per actor, with a per-board override, and the toggles are independent

Four toggles — `needs-me`, `review`, `info`, `settled` — plus one number, the settled threshold.
Defaults: **needs-me on, review on, info off, settled off**, threshold 20 minutes.

Independent toggles, not a single verbosity threshold. A threshold ("only what needs me" / "+
reviews" / "everything") is tidier and was the first shape considered, but it cannot express
`settled` at all, and `settled` is exactly the setting Rob described as orthogonal — "nothing has
happened, check in" is not a rung on a loudness ladder. Once one setting has to sit outside the
ladder, the ladder stops paying for itself. Independent toggles also let a mixed choice exist
("reviews yes, chatter no, and ping me when it goes quiet"), which is the shape he actually
described. Nothing enforces monotonicity: `info` on with `review` off is a strange choice but a
legible one, and silently flipping a toggle the user just set is worse than honouring it. The UI
orders them urgent-to-chatty so the sensible reading is the obvious one.

**Per actor, not per subscription.** Presence and batching are already keyed by actor (ADR 0021)
because every device of one person should say the same thing. Per-device settings would let the
phone and the Mac disagree about what matters, which is a per-device *mute* — and the browser
subscription already is that.

**Storage** is one new core table, `notify_settings`:

```sql
CREATE TABLE IF NOT EXISTS notify_settings (
  actor             TEXT    NOT NULL,
  board_id          TEXT    NOT NULL DEFAULT '',   -- '' = this actor's global default
  needs_me          INTEGER,                       -- NULL = inherit
  review            INTEGER,
  info              INTEGER,
  settled           INTEGER,
  settled_after_ms  INTEGER,
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (actor, board_id)
);
```

`board_id` is `NOT NULL DEFAULT ''` rather than nullable because SQLite treats NULLs in a unique
index as distinct, so a nullable `board_id` in the primary key would happily store a hundred global
rows for one actor. The sentinel is ugly in one place and correct everywhere else.

Every flag column *is* nullable, and that is load-bearing: `NULL` means "inherit", which is what
makes a per-board override a real override rather than a copy. `resolveNotifySettings(global,
board)` reads, per field, the board row's non-null value, else the global row's non-null value,
else the built-in default. A board row with every field NULL is indistinguishable from no override,
which is what "Use the same as all boards" writes.

Migration is additive and needs no backfill: absence of a row *is* the default. Nothing is written
until the human touches a toggle. `SCHEMA_VERSION` goes 7 → 8. The held harness PR also claims 8 on
its branch; whichever lands second renumbers to 9, and if that is the harness PR the change is one
constant and one migration guard on its side.

**How today's on/off maps.** It does not move. The button in the notifications sheet is the browser
subscription — one device, on or gone — and it stays the master switch, above the levels. The
levels are what a subscribed device then hears. An existing user, having no rows, lands on the
defaults: asks and reviews yes, channel chatter no. That is a real behaviour change for anyone
subscribed today, and it is the point of the card; the "Everything" toggle restores it exactly.

### `settled` is a bounded timer on the leaseholder, one push per quiet period

ADR 0023 already guarantees exactly one process delivers push for a database. That process runs the
timer, inside its existing 500ms tick — no new loop, no new process, and a takeover mid-quiet
simply restarts the clock rather than double-firing.

The model is a `SettledTracker` in `packages/core/src/settled.ts`, constructed with `isLooking` the
same way `NotificationBatcher` is, so it has no dependency on presence.ts (card 54's file) and can
be tested against a stub clock and a stub predicate.

The rule, per (recipient actor, board):

- Any event on the board **whose author is not the recipient** arms the timer and clears the fired
  flag. A person's own last word is not a board going quiet on them.
- On a tick, a board that has been armed and has seen no event for `settled_after_ms` fires **one**
  notification and sets the fired flag. Nothing fires again on that board until a new event arms it
  afresh. That is what "never repeated" means here: the flag, not a cooldown.
- It does not fire if presence says the recipient is looking at that board. They can see that it is
  quiet.
- The threshold is clamped to `[5 minutes, 24 hours]`. A threshold below the batch window would let
  a settled push land inside a still-flushing message batch and read as a duplicate; a day is the
  point past which the feature is a reminder, not a check-in.

The notification is `"<board> is quiet"` / `"Nothing for <n> minutes."`, with url and tag
`#/b/<slug>/cards`. Tag equals url, as the contract requires, and it is a tag no other notification
uses, so a settled ping never replaces a pending ask and never gets replaced by one.

**Interaction with batching and presence.** Settled sits beside the batcher, not inside it: it does
not fold into a message batch, does not reset one, and is not counted in "<n> new in <board>". It
is chatter-class for presence (suppressed while looking), and urgent-class for batching (never
delayed), because a check-in that arrives late is a check-in about the wrong moment.

**Bounded.** State is one small record per (actor, board) with a hard cap of 200 keys, evicting the
least recently armed — a database with thousands of boards must not grow the pump's memory without
limit. In-memory only, dropped on restart like the batcher and the pump cursor: a missed check-in
is the cheapest possible loss, and persisting it would mean a restart storm of check-ins about
boards that went quiet while the server was down.

### The settings live in the sheet that already exists, and the bell tells the truth

`packages/web/src/Notifications.tsx` gains one section between the on/off button and Devices, shown
only when push is on — settings for notifications you are not receiving is a puzzle, not a feature.
Four rows, each a switch with a title and one line of explanation:

- **Needs me** — "A card is waiting on your answer."
- **Review requested** — "A PR is up, or screenshots are ready to look at."
- **Everything else** — "Every channel message and card update."
- **Quiet check-in** — "One ping when a board goes quiet." With a small threshold select
  (10 / 20 / 60 minutes / 3 hours) revealed only when it is on.

The per-board override is the same sheet, opened from a board rather than from Home, with the
board's name in the section header and a trailing **"Same as all boards"** row that clears the
override. A toggle the board has not overridden renders in its inherited position, visibly muted;
touching it writes a board row. Today's bell is Home-only chrome by choice (TopBar #10), so a board
reaches the sheet through its existing overflow menu rather than by adding a second bell to a tight
nav.

The bell itself gains one state. It already swaps to `bellOff` with a warn dot when the browser has
blocked notifications. Now it also renders `bellOff`, **without** the dot, when push is on but every
level toggle is off — subscribed and silent is a real state a person can put themselves in by
accident, and a bell that looks armed while nothing can ever ring is the one dishonest thing this
UI could do. No unread count: flock has no read model, and inventing one for a badge is a different
ADR.

### One paragraph of guidance in SKILL.md

Added to the channel cadence section, after the reply/reaction rules:

> Every post you make now carries a notification level, and choosing it is your job, not the
> human's. Plans, status lines, routing notes, findings and merge confirmations are `info` — the
> default, so write them exactly as you do today and they stay in the channel without buzzing a
> phone. Use `--level review` when there is something for the human to *look at* and nothing is
> blocked: a PR URL, a screenshot or frame strip attached to a card, a design ready for an opinion.
> Attachments on a card comment and a PR URL are already classified as `review` for you, so the
> flag is for the cases the text does not give away. When the run actually needs the human, that is
> never a message: use `flock ask <n> "<one precise question>"`, which parks the card and notifies
> at `needs-me` regardless of anyone's settings. `--level needs-me` on `say` or `comment` is
> refused for exactly that reason. Err toward `info`: the human has turned the loud levels on and
> will turn them off again if you cry wolf.

## Consequences

- Anyone subscribed today stops getting a buzz for every channel line, without changing a setting.
  That is the intended change, and the "Everything else" toggle is the one-tap undo. It is worth
  saying in the release note rather than letting someone discover it as a silence.
- `notificationFor` and `notifyTargets` gain the level and the settings lookup; the pump gains one
  read of resolved settings per (recipient, board) per event. That is a keyed SQLite read on the
  hot path, cached per tick, and it is why settings are actor-keyed rather than endpoint-keyed —
  one lookup, not one per device.
- `flock log --json` starts showing `level` in `data` for new posts. Nothing parses it yet; the
  skill and the CLI's `--json` contract both keep their shape.
- The events table stays the record of what happened, and the settings table the record of what
  someone wants to hear about. Neither grows a column because of the other.
- `settled` can be wrong in one direction only: it can fail to fire (restart, takeover, a lost
  presence beat that leaves the recipient looking "present"). It cannot fire twice for one quiet
  period, and it cannot fire for a board that never had activity.
- Per-board overrides are storage the human has to be able to see and clear, which is why the
  "Same as all boards" row is part of this decision and not a later nicety.

## Alternatives considered

**A single verbosity threshold instead of independent toggles.** One radio group: "only what needs
me" / "+ reviews" / "everything". Fewer decisions for the user, and a strictly monotone model that
cannot be set into a strange state. Rejected because `settled` has no rung on it, and bolting a
fourth choice onto the end would have implied that a quiet board is louder than everything, which
is nonsense. Also rejected the reverse — a threshold *plus* a separate settled checkbox — because
two controls with two different mental models in one small sheet is worse than four of the same
shape.

**Let the heuristics do all of it; no flag.** Classify by text: look for "PR", a URL, an image, the
word "review". Rejected because it fails in both directions on the cases that matter — a status
line mentioning a PR number is not a review request, and "the frame strip is on card 41" has no
pattern to match. The author knows; asking it is one flag.

**Let the flag do all of it; no heuristics.** Purer, and the rule would fit in a sentence. Rejected
because it makes the correct behaviour depend on every agent remembering a flag, and a forgotten
flag silently downgrades a screenshot the human is waiting on. The two heuristics kept are the two
where the evidence is structural rather than textual (an attachment exists; a PR URL is a URL), so
they hold for agents that never read the skill.

**A `silent` level.** A fourth level below `info` for genuinely mechanical posts. Rejected as
redundant: with `info` off by default, `info` already is silent for anyone who has not opted in, and
for anyone who has opted in, "I want everything except the parts an agent decided were boring" is
not a thing they asked for.

**Per-device settings.** Loud on the phone, quiet on the Mac. Rejected for now: it contradicts the
per-actor keying that batching and presence are built on, and the device-level control that already
exists — subscribe or don't — covers the real case. If it comes back, it comes back as a per-device
override *below* the per-board one, which this table's shape can carry.

**Emitting a `board.settled` event so the pump's existing path delivers it.** Attractive: no new
timer output path, and the check-in shows up in `flock log`. Rejected because it is not a fact about
the board — nobody did anything, that is the whole point — and writing a row to the events table
every time nothing happens pollutes the one table that is supposed to be a record of what happened.
It would also replay into any other consumer of the event stream, including the web UI's activity
feed, which would then show "nothing happened" as a thing that happened.

**Threshold as a server config knob rather than a per-user setting.** Simpler, and consistent with
`BATCH_WINDOW_MS` being a constant. Rejected because unlike the batch window, the right value is a
personal preference about how closely someone is watching a run, and it is already sitting next to
the toggle that turns the feature on.
