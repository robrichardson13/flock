# 0025. The presence heartbeat is a re-armed chain, not an interval

Date: 2026-09-12

## Status

Accepted. Amends ADR 0021's presence section (card 91).

## Context

ADR 0021 gave the push pump a presence check: a client beats `POST /api/presence` every 15s while
it is looking, the server trusts the freshest beat for `PRESENCE_TTL_MS` (45s), and chatter aimed
at an actor who is looking at that board is suppressed. Card 54 fixed the keying (a client on Home
is looking at every board). Card 87 then tested the result on a real iPhone home-screen app, and
one of the four sends failed: a plain channel message buzzed a phone whose owner had never left
the app.

The server log says exactly what it believed, and it was not wrong about its own inputs:

```
18:51:38 / 18:51:53 / 18:52:08 / 18:52:23 / 18:52:38  looking=true, exactly 15s apart
18:52:42.920  looking=false visible=false focused=false input=894ms     <- visibilitychange -> hidden
18:53:27.024  looking=false visible=false focused=false input=863ms     <- hidden again
   (no beats at all for the next 80 seconds)
18:53:52      [push] decision event=7493 ... looking=false age=- clients=0  -> pushed
18:54:47.357  first line after the hole, and only because a finger touched the screen
```

Three things combine.

1. **iOS fires `visibilitychange` -> hidden for things nobody experiences as leaving an app**: a
   notification banner sliding down, Control Centre, an app-switcher peek. `clientIsLooking`
   requires `visible`, so the client honestly reports `looking: false`.
2. **The client then went silent by design.** `presenceStep` returned `"none"` for every
   subsequent evaluation once `looking` was false and unchanged. Correct on the server's terms —
   the entry is already deleted — but it means the *only* thing that can bring the client back is
   an event.
3. **The event is not guaranteed, and the timer that would have covered for it is frozen.** The
   matching `visible` transition is unreliable in a standalone iOS app (the same asymmetry
   `dismiss.ts` was written around in card 53), and the 5s `setInterval` that re-read
   `document.visibilityState` is throttled or suspended along with the page. Recovery waited for
   a finger on the glass.

So the buzz arrived while the phone was being read. Worse, it is self-sustaining: the banner from
one push fires `hidden`, which is the state that permits the next push.

## Decision

**The cadence is a `setTimeout` chain re-armed after every beat, and it is not the only thing that
can fire one.** `packages/web/src/beat.ts` owns it, with an injectable clock so the whole thing is
testable with a fake timer and no DOM.

- **Every signal that could mean "the app is in front of someone again" fires a beat immediately
  and re-arms the chain**: `visibilitychange` to visible, `pageshow`, `focus`, `online`, a
  reconnected event stream (`LIVE_UP_EVENT`, dispatched by `useLiveStream`'s `markUp` — often the
  first sign of life on iOS, and sometimes the only one), and any touch, key, scroll or pointer.
  A resume storm is deduped inside `RESUME_DEDUPE_MS`, so the three events iOS fires for one
  foregrounding produce one beat.
- **A forced beat sends even when nothing changed.** `presenceStep` takes a `forced` flag: a
  resume, a detected gap or a retry beats regardless of the cadence and regardless of `looking`
  being unchanged. This is what ends the permanent silence.
- **A late beat says so.** `gapMsSince` flags any beat arriving more than `GAP_FACTOR` (2)
  cadences after the previous one, and the beat carries `gapReason`/`gapMs`, which the server
  prints as `gap=<signal>/<duration>` on the `[presence]` line — and only then, so `grep gap=`
  finds every silence and nothing else. The next hole is evidence rather than inference.
- **A failed POST can never end the loop.** The report re-throws (it already refused to swallow),
  the scheduler retries on a bounded backoff table, and the ordinary chain stays armed throughout,
  so an exhausted backoff degrades to the plain cadence.
- **The leaving beat is unchanged and still immediate**: `visibilitychange` -> hidden and
  `pagehide` send `looking: false` with `keepalive`, bypassing the resume dedupe. A locked phone
  stops being "looking" on that event, not 45s later.

**`PRESENCE_TTL_MS` stays at 45s.** Card 91 asked whether the server's trust window could shrink
to two cadences plus slack. Not yet: the two failure modes are not symmetric. A window that is too
long costs one missed buzz on a phone that vanished without a leaving beat. A window that is too
short buzzes a phone whose beat was merely late — which is this card, and cards 54, 70 and 87
before it. The expensive failure is the one shortening makes more likely, and the cheap one is
already handled at the client by the leaving beat. Revisit when a field log shows a standalone
client running clean with no `gap=` lines.

## Consequences

- Presence beats are no longer bounded below by "an event happened". A frozen page that resumes
  without any event still reports within one cadence of the timer thawing, and says how long it
  was out.
- One more `window` event name is public API between modules: `LIVE_UP_EVENT` in `live.ts`.
  Nothing may assume it is delivered — it is a hint, not a contract.
- The `[presence]` log line grew an optional `gap=` field between `fg=` and `ua=`. Absent on an
  ordinary beat.
- The push pump's level logic is untouched.
