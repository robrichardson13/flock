# Harness telemetry

flock already recorded *what* ran — the harness, model and effort behind each write (ADR 0005).
This records *how the run went*: what it cost, how full its context got, how long it worked, how
many tools it swung, and whether anyone is still there.

See [ADR 0026](adr/0026-harness-telemetry.md) for the full design and the alternatives it rejected.

## What you see

On a card page, below Details, a **Run** block — one row per harness session that worked the card:

```
claude-opus-5   $4.34   ███████░░░ 148K / 1M (15%)   21m   47 tools   ● running · 12s ago
```

| Reading | Where it comes from |
| --- | --- |
| model chip | the model observed in the transcript, not the one the agent declared. Where the two disagree, the tooltip says what was declared. |
| cost | the harness's own dollar figure, never a price table of flock's. |
| context bar | the last assistant turn's input + cache-read + cache-write tokens, against the model's maximum from the harness's model catalog. |
| duration | flock's own clock: `card.claimed` → `card.closed`, from the events table. The session's own wall clock is in the tooltip. |
| tool count | tool calls in the transcript, with the top three by name on hover. |
| liveness | `running`, `idle`, `gone` or `unknown`, plus when the session was last heard from. |

Under the rows, `also worked #6, #7` when a session touched other cards — a session's numbers are
session totals, and flock never splits them across the cards the session worked. That note is what
keeps "this session cost $4.34" from being read as "this card cost $4.34".

While a session is still `running` or `idle`, the block is live rather than a snapshot: the
duration ticks like a clock (a local repaint, no network) and cost, context, tool calls and
liveness refresh on their own every 15 seconds — the same TTL the server's refresh-on-read
already compares against, so the client never asks for a re-read the server would have declined
anyway. The moment a session goes `gone` (or, on the card page, the card itself closes), the block
freezes at its last value and stops asking; nothing polls a card or actor nobody has open.

An actor page gains the same rows, plus a totals strip across distinct sessions once there are two
or more.

In a terminal:

```
flock telemetry            # your own sessions (--as / FLOCK_ACTOR), with totals
flock telemetry 12         # the sessions that worked card 12, and the card's duration
flock telemetry 12 --json  # the same, machine-readable, including the transcript path
flock telemetry 12 --refresh   # re-read every session first, even ones already final
```

`flock card show --json` carries the same numbers as `telemetry` and `duration` keys. Nothing in
flock's human-readable agent output changed: not `flock cards`, not `flock card show`'s prose, not
`flock actors`. A number no agent can act on is context spent on nothing.

### Unknown is not zero

A live session has no cost — not `$0.00`, *no number yet*. The harness computes cost when the
session ends. Every surface renders a missing reading as `—` and never as a zero. The same goes for
tool calls, the context bar (which needs both halves to draw anything) and duration.

Context is a point-in-time reading. A compaction resets it, so "15%" describes the window now, not
the run.

## How a session is linked to a card

Every flock write already carries the runtime the agent was running under. It now also carries an
opaque **run key**:

```
claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c
claude-code:8ea8caf2-…#agent-6f2c…      (a subagent transcript, when its id is known)
```

Inside Claude Code the key is read from `CLAUDE_CODE_SESSION_ID`, which is exported to every child
process — so it needs no install and no consent. "Which sessions worked this card" is then a
group-by over the events table. Nothing links a card to a session except the events the agent
already wrote.

From there, flock derives the transcript path from `(cwd, session id)` by Claude Code's own
encoding and reads it: bounded by size, line count and a timeout, marking the row `partial` rather
than throwing. A malformed line is skipped, never thrown from.

Two limits worth knowing:

- **A subagent reports its parent's session.** `CLAUDE_CODE_SESSION_ID` inside a subagent is the
  parent's id and there is no per-agent variable. N subagents on N cards all report one key, and
  its numbers describe the whole conducted run. That is a true reading, just a coarse one — which
  is what `also worked` exists to say out loud.
- **Cost is retroactive.** The harness writes its cost line when the *session* ends, which is not
  when the agent runs `flock done` — it is later, when you close the terminal. A card closed at
  11pm shows `—` for cost until something reads that transcript again, which keeps happening on
  every later view (see the refresh rule below) until the number shows up.

Refreshes happen where somebody is looking, and never any other way: the server re-reads a session
when a card or actor page is fetched and the stored reading is more than 15 seconds old,
single-flight per key. `flock done` and `flock release` each do one best-effort read. Nothing polls
in the background, and a refresh never emits a flock event.

The web app is one of those "somebodies": while its Run block shows a `running`/`idle` session, it
re-fetches the card or actor payload every 15 seconds on its own (`useLivePoll`,
`packages/web/src/Telemetry.tsx`) so the block above stays live without a reload. That client poll
is what asks; the 15-second TTL above is still what decides whether the ask actually re-reads a
transcript. Closing the card, closing the actor sheet, or the session going `gone` stops the poll
immediately — nothing here polls a view nobody has open.

A session is **final** — never read again — once one of three things is true: it has cost, its
transcript is gone, or it went quiet more than seven days ago and still has neither. Short of that,
a session that looks over keeps being re-read on every later view, because the cost-state line above
can still land at any moment.

## Privacy

flock reads transcripts **on the same machine, read-only, and never over a network.** It stores
**numbers, model ids, timestamps and file paths — never transcript text**: no prompts, no assistant
messages, no tool inputs, no tool outputs, no file contents. Everything read lands in the same local
SQLite file the board already lives in. Nothing is sent anywhere.

The one path stored is the transcript's, as a convenience for opening it locally. Since `flock
serve` can be fronted onto a tailnet ([ADR 0019](adr/0019-tailscale-serve-for-an-https-origin.md)),
the HTTP API **omits that path unless the request comes from loopback**. `flock telemetry --json`,
which by definition runs on the machine holding the file, always includes it.

Telemetry is self-reported and unauthenticated, exactly like `--as` and like ADR 0005's runtime
fields. It is for reading the board, not for billing or enforcing anything.

## Environment

| Var | What it does |
| --- | --- |
| `FLOCK_SESSION` | Sets the run key by hand, for a harness flock cannot detect. Precedence: `--session`, this var, then detection. |

## What is not here yet

Codex maps onto the same table with a different reader — a better index (`~/.codex/state_5.sqlite`
names every thread's rollout path, model and token counts in one SELECT) and worse liveness (no pid
anywhere), and no dollar cost at all, since it is a subscription and a figure from a price table
would be fiction. The reader interface in `packages/harness` exists so adding it is one file plus
one line in the registry.

The stall detector this was built to feed — telling a card whose agent *finished and forgot to
close it* from one whose agent is *thinking hard and quiet* — is issue #24, and reads this table
rather than subscribing to anything.
