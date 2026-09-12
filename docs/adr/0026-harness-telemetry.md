# ADR 0026: Harness telemetry — what a run cost, how full it got, and whether anyone is still there

**Status:** accepted, 2026-09-11

## Context

ADR 0005 made flock record *what ran*: harness, model, effort, carried on the event and cached on
the actor. It deliberately recorded nothing about *how the run went*. A card closes and the board
says `sonnet` and nothing else — not the dollars, not how close the agent came to filling its
context window, not how long it actually worked, not how many tools it swung.

The human wants those numbers. Concretely, for the agent that worked a card: cost in dollars,
context used against the model's maximum, wall-clock duration, tool-call count, and whether that
agent is still alive. Not for the agent: an agent reading its own cost in its own terminal is
context spent on nothing it can act on.

There is a second consumer. Issue #24 ("the conductor never learns a card is wedged") wants to
tell a card whose agent *finished and forgot to close it* from a card whose agent is *thinking
hard and quiet*. Those look identical from the events table — no writes for twenty minutes — and
different the moment you can see whether the process behind the assignee is still there. This ADR
does not design that detector (card 7 does); it decides the primitives the detector reads.

### What the harnesses actually leave on disk

Card 4's research (`flock card show 4`) verified all of this on this machine, Claude Code 2.1.269
and Codex 0.116.0 data:

- **The transcript is the source of truth.** `~/.claude/projects/<cwd with every non-alnum
  character replaced by `-`>/<session-uuid>.jsonl`, one JSON object per line. The path is
  derivable from `(cwd, session id)` — no index file needed, though the encoding is lossy and is
  therefore a lookup key, not a round trip.
- **Cost is already computed.** An ended session carries a `cost-state` line with
  `totalCostUSD`, `totalDuration`, `totalAPIDuration`, `totalToolDuration`, `startTime`, and a
  per-model `modelUsage` split with its own `costUSD`, plus `hasUnknownModelCost`. Real dollars,
  no price table. It is **absent while the session is live**, sometimes duplicated, and not
  always the last line.
- **Context used** is the last `assistant` line's
  `usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — the same three
  fields Claude Code's own statusline sums. **Context max** comes from
  `~/.claude/cache/model-catalog/published-*.json`, whose filename is content-hashed and expires
  weekly, so it must be globbed rather than hardcoded.
- **Tool calls** are one pass: `assistant.message.content[]` where `type == "tool_use"`, grouped
  by `name`.
- **A subagent has its own transcript** at `<session>/subagents/agent-<id>.jsonl`, recording the
  subagent's real model id even when the parent ran a different one. Its lines carry the
  *parent's* `sessionId` plus an `agentId`. Sidechain lines never appear in the parent file.
- **Liveness**: `~/.claude/sessions/<pid>.json` maps a live pid to a session id, cwd and a
  `status`; `claude agents --json` lists the same thing. The transcript file's **mtime equals its
  last line's timestamp exactly** — one `stat`, no parse, and the only per-subagent liveness
  signal that exists, since a subagent has neither a pid nor an env var naming it. The harness's
  own `status` is a transition record, not a heartbeat: a live process here read `idle` with a
  `statusUpdatedAt` 5.5 days old.
- **Env**: `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` are exported to every child process. Inside
  a subagent, `CLAUDE_CODE_SESSION_ID` is the **parent's** id and **there is no `agentId`
  variable**. Still, as in ADR 0005, nothing names the model.
- **Hooks** receive `session_id`, `transcript_path` and `cwd` on stdin for every event, and
  `SubagentStop` is the only place `agent_id` is handed out.
- **Codex** has a better index and worse liveness: `~/.codex/state_5.sqlite` `threads` gives
  `rollout_path`, `cwd`, `model`, `reasoning_effort`, `tokens_used`, `created_at`/`updated_at` in
  one SELECT, and the rollout carries `model_context_window` inline. There is **no dollar cost
  and no pid anywhere** — it reports rate-limit percentages against a subscription instead.

### What flock has to build on

`events` and `actors` already carry nullable `harness`/`model`/`effort`. There is **no claims
table**: a claim is `cards.assignee` plus a `card.claimed` event, and `boardActors` already
group-bys the event log to answer "who ran what here". Core has no filesystem access beyond its
own database file. `packages/core/src/hooks.ts` already ships a permission-guarded hook runner,
and `packages/cli/src/path-setup.ts` already edits a file in the user's home directory behind a
fixed marker comment and an env opt-out. Both are precedents this design leans on.

## Decision

### 1. The session is the unit, and the event already links it to the card

**Add one more nullable runtime field, `session`, to `Runtime`, `events` and `actors`** — the same
path ADR 0005 built, one column wider. It holds an opaque **run key**:

```
claude-code:8ea8caf2-d288-4e0a-89de-04c45158535c
claude-code:8ea8caf2-…#agent-6f2c…          (a subagent transcript, when the id is known)
codex:019d2195-20b1-7dc2-b036-b171be3e534b
```

The key is `<harness family>:<session id>[#<agent id>]`. Family, not version — the key must stay
stable across a harness upgrade mid-run.

With that, **"which harness runs worked this card" is a group-by over `events`**, exactly like
`boardActors`:

```sql
SELECT DISTINCT session FROM events
WHERE board_id = ? AND card_num = ? AND session IS NOT NULL
```

No join table, no claims table, no new notion of identity. A card worked across two sessions has
two rows; a session that worked three cards appears on three cards. Both are true statements and
neither needs new machinery.

**Add one table, `harness_sessions`, keyed by that run key**, holding everything that is a
property of the session rather than of the card:

```sql
CREATE TABLE IF NOT EXISTS harness_sessions (
  key           TEXT PRIMARY KEY,   -- the same string events.session carries
  harness       TEXT,               -- freeform, as ADR 0005: "claude-code@2.1.269"
  session_id    TEXT NOT NULL,
  agent_id      TEXT,               -- subagent transcript; null for a top-level session
  transcript    TEXT,               -- absolute path on this machine. Never its contents.
  cwd           TEXT,
  model         TEXT,               -- observed in the transcript, not self-declared
  context_used  INTEGER,
  context_max   INTEGER,
  cost_usd      REAL,               -- null while live, and null forever on Codex
  cost_exact    INTEGER,            -- 0 when the harness flagged an unknown model cost
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  tool_calls    INTEGER,
  tools         TEXT,               -- JSON histogram: {"Bash":24,"Edit":18}
  started_at    TEXT,
  ended_at      TEXT,               -- set only when the harness says the session ended
  duration_ms   INTEGER,            -- harness wall clock; api_ms/tool_ms split it
  api_ms        INTEGER,
  tool_ms       INTEGER,
  last_activity_at TEXT,            -- transcript mtime / thread updated_at
  liveness      TEXT,               -- running | idle | gone | unknown
  liveness_note TEXT,               -- the harness's own raw word: busy/idle/shell/mid-turn
  ended_reason  TEXT,               -- clean | absent | null
  pid           INTEGER,
  partial       INTEGER,            -- 1 when a read hit its size cap
  source        TEXT,               -- hook | reader
  observed_at   TEXT NOT NULL,      -- when these numbers were read: the TTL clock
  extra         TEXT,               -- JSON, harness-specific readings flock never queries
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_sessions_activity ON harness_sessions(last_activity_at);
```

Every column but `key`, `observed_at` and `updated_at` is nullable, and every one of them is
absent on some real run today. An unlinked agent — no session, no harness, launched by hand —
writes nulls and every surface renders exactly as it does now. That is the same contract ADR 0005
signed: *optional everywhere, forever, never guessed.*

`extra` is a bounded escape hatch for readings only one harness has (Codex's
`rate_limits.primary.used_percent` and `plan_type`). The rule: flock never filters, sorts or sums
on `extra`. Anything flock wants to query becomes a real column.

This bumps `SCHEMA_VERSION` 6 → 7, additively (one `CREATE TABLE`, two `ALTER TABLE ADD COLUMN`).
Per ADR 0021 a worktree on this branch seeds a private `.flock/flock.db` copy rather than stamping
the shared file. That is expected and is not a defect.

#### Session numbers are session numbers

Every figure in `harness_sessions` is a **session total**. flock will not split a session's cost
across the cards it worked: any split (pro-rata by claim time, by events, by tool calls) is
invented precision, and the one true statement — "the session that worked this card cost $4.34 and
also worked cards 6 and 7" — is both cheap and honest. The UI says exactly that.

The only genuinely card-scoped duration is flock's own: `card.claimed` → `card.closed` from the
events table, which needs no harness at all and is therefore always available. It is shown first.

#### Declared model vs observed model

ADR 0005's `model` is a claim the agent makes. `harness_sessions.model` is evidence read from the
transcript. **Neither is ever written into the other's column.** Where they differ, surfaces show
the observed one and keep the declared one in the tooltip. This is the first mechanism flock has
for catching a conductor that routed one model and passed another.

#### Rejected data models

- **Columns on `cards`.** One card can be worked by two agents in two sessions; cost is not a
  card-scoped number at all. It would force exactly the fake split rejected above.
- **A `claims` table.** It would mean rewriting the claim CAS and would duplicate history the
  events log already keeps forever. The events log *is* the claim record.
- **Per-message rows.** Storage proportional to transcript length, for a surface nobody asked for.
- **A JSON blob on the actor.** Unqueryable, and ADR 0005 already ruled that runtime facts get
  real columns so a future `--model opus` filter is a where-clause away.

### 2. Collection: a reader is the primitive, a hook is the accelerator

Three levels, each usable without the ones above it:

**Level 0 — the link, zero install.** `detectRuntime()` gains `session`, read from
`CLAUDE_CODE_SESSION_ID` (plus `CLAUDE_PID` for the liveness path). Every `claim`, `comment`,
`done` already carries runtime; now it carries the run key too. This alone buys the card→session
link and, with the events table, per-card wall clock. It needs no consent and no install because
it is the machinery ADR 0005 already built.

Its known weakness, measured: inside a subagent that variable is the **parent's** session id and
there is no per-agent variable, so N subagents on N cards report one key. The numbers then
describe the whole conducted run, which is a true and useful reading, just a coarse one.

**Level 1 — the numbers, zero install.** A **reader** resolves the transcript from
`(cwd, session id)` by the documented encoding, reads it, and upserts a `harness_sessions` row.
Because the path is derivable, the hook is *not* required to get numbers — which is what makes a
zero-install v1 possible.

**Level 2 — exactness and push, one opt-in install.** A Claude Code `SessionEnd` /
`SubagentStop` hook invokes `flock telemetry record`, which reads the payload on stdin
(`session_id`, `transcript_path`, `cwd`, and on `SubagentStop` the `agent_id` that exists nowhere
else) and upserts the same row with `source = "hook"`. It adds two things level 1 cannot get:
per-subagent attribution, and a push at the moment the session ends.

**That second one matters more than it looks.** `cost-state` does not exist until the session
ends, and a session does not end when the agent runs `flock done` — it ends later, when the human
closes the terminal. So on the zero-install path, **cost is always retroactive**: it appears the
next time something reads that transcript, minutes or hours after the card closed, or never if
nothing ever looks again. The hook is the only way a card's cost lands promptly and reliably.
That is the honest case for asking a user to install it, and the reason it is offered rather than
assumed.

#### Is mutating `~/.claude/settings.json` acceptable?

Yes, opt-in, on the same terms as the PATH line `flock setup` already writes into a user's shell
rc (`path-setup.ts`):

- **Never silent.** `flock setup` prints what it is adding and where. The conductor skill may
  offer it once; it may not install it unprompted.
- **Marked.** The hook entry carries a fixed marker (`"_flock": "harness-telemetry"`) so it can be
  found and removed exactly, and so a second install is a no-op rather than a duplicate.
- **Additive.** The file is read, the entry merged into the existing `hooks` object, and written
  back via temp-file-and-rename. Any existing `SessionEnd` hook stays. A parse failure means
  flock does not write at all and says so — it never rewrites a file it did not understand.
- **Opt-out before the fact:** `flock setup --no-hooks`, or `FLOCK_NO_HOOKS=1`, matching
  `FLOCK_NO_MODIFY_PATH`.
- **Undone after the fact:** `flock setup --remove-hooks` deletes exactly the marked entry and
  leaves everything else, and the marker is documented in `docs/harness-telemetry.md` so a
  human can delete it by hand in five seconds. Removing it degrades flock to level 1; nothing
  breaks.
- **Cheap and quiet.** The hook runs on `SessionEnd`/`SubagentStop` only — never `PreToolUse`,
  never per-turn. It has a hard timeout, and on any failure it exits 0 without printing: a
  telemetry hook must never be able to interrupt somebody's session.

#### Who triggers a refresh

- **The server, lazily on read, with a TTL.** When a card view is fetched and any of its sessions
  is not `ended`, the server refreshes those rows if `observed_at` is older than **15 seconds**,
  single-flight per key. A session with `ended_at` set is immutable and is **never re-read**.
  Cost is proportional to attention: nobody watching means nothing read.
- **The CLI, on `done` and `release`,** best-effort: one read, swallowed failures logged at debug,
  never able to fail the close. It usually catches the tool counts and final context, and usually
  misses the cost, for the reason above.
- **The hook, when installed**, on session end.
- **`flock telemetry refresh [card]`,** the explicit manual path, for backfilling.

**Rejected:** a poller in the daemon (work proportional to boards rather than to attention, and it
runs all night while nobody looks); a statusline wrapper (hijacks a user-visible setting most
people have customized, for one number); reading transcripts inside `flock comment` (puts
filesystem work in the hot path of every agent write); computing dollars from a price table
shipped in core (a table that silently rots — prefer the harness's own figure and show nothing
where there isn't one).

**Telemetry never emits a flock event.** A refresh is not something that happened on the board; an
event per refresh would flood the activity feed, the SSE stream and the push pump for numbers
nobody asked to be notified about. Card 7's stall detector reads the table, it does not subscribe.

#### Privacy

flock reads transcripts **on the same machine, read-only, never over a network**, and stores
**numbers, model ids, timestamps and paths — never transcript text**: no prompts, no assistant
messages, no tool inputs, no tool outputs, no file contents. Nothing read is ever sent anywhere;
it lands in the same local SQLite file the board already lives in.

The stored `transcript` path is a convenience for a human who wants to open it locally. Since
`flock serve` can be fronted onto a tailnet (ADR 0019), the HTTP API **omits the path unless the
request is from loopback**; the CLI's `--json`, which by definition runs on the machine that holds
the file, always includes it.

#### Limits

Defensive coding is not optional here: transcripts are attacker-shaped input in the sense that
matters (unbounded, machine-written, occasionally malformed). Every read is bounded — a per-read
timeout, a maximum file size and line count above which the row is marked `partial = 1`, a cap on
distinct tool names kept in the histogram, a tail-scan for `cost-state` rather than a full parse
when only cost is wanted, and a type-guard on every field (`toolUseResult` is sometimes a string
and sometimes an object). A malformed line is skipped and counted, never thrown from and never
silently swallowed.

### 3. Live versus final

| Reading | While the card is `doing` | At session end |
| --- | --- | --- |
| card wall clock | `card.claimed` → now, from flock's own events | → `card.closed` |
| `last_activity_at` | transcript mtime, one `stat` | frozen |
| `liveness` | recomputed on every refresh | `gone` |
| `context_used` / `context_max` | last assistant line; point-in-time, resets on compaction | last value |
| `tool_calls` / `tools` | running count | final |
| token counts | running | final, and split per model |
| `cost_usd` | **unknown — there is no such number yet** | `cost-state.totalCostUSD` |
| `duration_ms` / `api_ms` / `tool_ms` | unknown | `cost-state` |

Two things the UI must say out loud: context is a **point-in-time** reading (a compaction resets
it, so "78% full" describes the window now, not the run), and a live session's cost is **not zero,
it is unknown**. A missing number renders as `—`, never as `$0.00`.

### 4. Liveness primitives for issue #24

Four states, computed by the reader, stored on the row, and deliberately coarse:

| State | Claude Code | Codex |
| --- | --- | --- |
| `running` | pid alive **and** transcript mtime within the fresh window | rollout mtime fresh **and** last `task_started` unmatched |
| `idle` | pid alive **and** mtime stale | mtime stale **and** last turn closed by `task_complete` |
| `gone` | pid dead, or the transcript has a `cost-state` line | only when a `sessionEnd` hook said so |
| `unknown` | no session key, no transcript, unsupported harness, or the reading is past its TTL | the default |

Three rules the implementation must not soften:

1. **Never read the harness's own `status` as a heartbeat.** It is a transition record: a live
   process here reads `idle` from 5.5 days ago. It is carried verbatim in `liveness_note` for a
   detector that wants the hint, and it never decides `liveness` on its own.
2. **Guard pid reuse.** Compare `procStart` in `~/.claude/sessions/<pid>.json` with `ps -p <pid>
   -o lstart=`, normalizing the timezone first — the file is UTC and `ps` is local.
   `isAlive()` in `packages/cli/src/procs.ts` is the existing helper.
3. **The fresh window must be generous.** A single long tool call writes nothing for minutes; a
   `totalToolDuration` of 374s inside a 21-minute session is normal. It is configurable, and card
   7 owns the number.

What this hands the stall detector, and the whole of what this ADR promises it:

- **finished but not closed** = card `doing` + `liveness = gone` + `ended_reason = clean`.
- **quiet but running** = card `doing` + `liveness = running`.
- **possibly wedged** = card `doing` + `liveness = idle` for longer than a threshold.
- **crashed** = `liveness = gone` + `ended_reason = absent`.
- **no idea** = `liveness = unknown`, which every card gets when no harness data exists — and
  issue #24's first useful version ("`doing`, no event for N minutes") works from the events table
  alone, so an unlinked board is not left without a detector.

Thresholds, the event shape, auto-release and what the conductor does on receipt are all card 7's.

### 5. Surface

**Nothing in agent-facing human output changes.** Not `flock cards`, not `flock card show`'s
prose, not `flock actors`, not `handoff`, not `help`. A per-card cost line in `flock cards` was
considered and rejected: it doubles the height of the list an agent parses, for a number no agent
can act on. Agents read `--json`; humans read the web app and the one new verb.

**`flock card show --json`** gains two keys, additively:

```jsonc
{
  "card": { … },  "comments": [ … ],  "blocks": [ … ],
  "duration": { "claimedAt": "…", "closedAt": "…", "ms": 4231000 },
  "telemetry": [{
    "key": "claude-code:8ea8caf2-…",
    "actor": "harness-architect",
    "harness": "claude-code@2.1.269",
    "model": "claude-opus-5",          // observed
    "declaredModel": "opus",           // what the agent said
    "contextUsed": 148191, "contextMax": 1000000,
    "costUsd": 4.34, "costExact": true,
    "tokens": { "input": 154, "output": 41029, "cacheRead": 3653384, "cacheWrite": 148946 },
    "toolCalls": 47, "tools": { "Bash": 24, "Edit": 18, "Write": 3, "Read": 2 },
    "startedAt": "…", "endedAt": "…", "durationMs": 1301269, "apiMs": 512592, "toolMs": 374774,
    "lastActivityAt": "…", "liveness": "gone", "livenessNote": "idle", "endedReason": "clean",
    "alsoWorked": [6, 7],              // other cards this session wrote on, so a session total reads honestly
    "partial": false, "observedAt": "…",
    "transcript": "/Users/…/8ea8caf2-….jsonl"   // CLI only; omitted by the API off loopback
  }]
}
```

`telemetry` is `[]` — never absent, never null — when nothing is known, so a client can render it
unconditionally.

**`flock actors --json`** gains `session` per actor (the key of their latest run), and
`GET /api/boards/:b/actors/:name` gains `telemetry` with the same row shape plus a `totals` object
summing over **distinct** session keys so one session working three cards is counted once.

**New verb `flock telemetry [<card>] [--refresh] [--json]`** — the human's terminal surface, and
the only new human-readable output. `flock telemetry record` is its hook-facing subcommand,
undocumented in `flock help` the way `handoff`'s aliases are.

**Card page (web)**: below Details, a *Run* block, one row per session:

```
claude-opus-5   $4.34   ███████░░░ 148K / 1M (15%)   21m   47 tools   ● running · 12s ago
```

Model chip (observed), cost (`—` when unknown), a context bar with the percentage, wall clock
(flock's own for this card, the harness's session duration in the tooltip), tool count with the
top-three breakdown on hover, and a liveness dot with last activity. A session that also worked
other cards says so inline. The block does not render at all when there is no telemetry, so an
unlinked board looks exactly as it does today.

**Actor page (web)**: the header gains a totals strip — cost across distinct sessions, cards
worked, tool calls, and the current run's liveness dot with last activity — and each card row
gains a dim per-card duration. Colours are tokens in `styles.css` like everything else; the
liveness dot needs a token per state and must pass the 4.5:1 contrast gate.

### 6. Codex

Codex maps onto the same table with a different reader and no changes to core:

| Field | Codex source |
| --- | --- |
| `key` | `codex:<threads.id>` |
| `transcript`, `cwd`, `model`, `started_at`, `last_activity_at` | one SELECT from `~/.codex/state_5.sqlite` `threads` (`rollout_path`, `cwd`, `model`, `created_at`, `updated_at`) — opened read-only, WAL-safe |
| `context_used` | last `token_count.info.last_token_usage` input + cached input |
| `context_max` | `model_context_window`, inline in the rollout — no catalog lookup |
| token counts | `token_count.info.total_token_usage` |
| `tool_calls`, `tools` | `response_item.payload.type == "function_call"`, by `name` |
| `liveness` | mtime plus an unmatched `task_started`/`task_complete` pair. **No pid exists**, so `gone` is only reachable via a `sessionEnd` hook |
| `extra` | `rate_limits.primary/secondary.used_percent`, `plan_type` |
| **`cost_usd`** | **null, always.** Codex is a subscription; a dollar figure derived from a price table would be fiction. The UI shows the rate-limit percentage where the dollar figure would go |

Codex's effort and reasoning settings come from the same `threads` row, which is better than
anything Claude Code offers. Its env vars and hook stdin payload are **unverified** and must be
confirmed on a working install before the detector is written — which is why Codex is designed for
here and implemented later.

**The seam.** A new package, `packages/harness`, holds every reader behind one interface:

```ts
export interface HarnessReader {
  /** The key prefix this reader owns: "claude-code", "codex". */
  readonly family: string;
  /** Find a run from what a flock write knew: env, cwd, session id. Null when it cannot. */
  resolve(hint: RunHint): Promise<RunRef | null>;
  /** Full read: the numbers. Bounded by time and size; marks `partial` rather than throwing. */
  read(ref: RunRef): Promise<SessionReading | null>;
  /** Cheap read: mtime and process check only. What a liveness poll calls. */
  liveness(ref: RunRef): Promise<LivenessReading>;
}
```

`SessionReading` is a plain value object mirroring the table. The package imports **types only**
from core and never touches the database; core exposes `recordSessionReading()`,
`sessionsForCard()` and `sessionsForActor()` and never touches the filesystem. The CLI and the
server both depend on `@flock/harness`; neither reader name appears anywhere in core. Adding Codex
is one file plus one line in the registry, and it cannot reach core even by accident.

## Consequences

- **Cost on the zero-install path is retroactive and sometimes never arrives.** A card closed at
  11pm shows `—` for cost until something reads that transcript after the session ends. This is
  the strongest argument for the hook and the thing a user should be told when they are offered
  it.
- **A subagent without the hook reports its parent's session.** Its numbers describe the whole
  conducted run. The UI must therefore never present a session total as "what this card cost";
  `alsoWorked` exists so it cannot.
- **Context max depends on a weekly-expiring, content-hashed cache file.** Glob it, tolerate its
  absence, and fall back to no maximum (render the number, not the bar) rather than a guessed one.
  The `[1m]` variant is invisible in the transcript, so a 200K-mode run on a 1M-catalogued model
  would read as emptier than it is.
- **Transcript paths in the database go stale** when `~/.claude` is pruned. A missing file means
  `liveness = unknown` and the last stored numbers stand; it is never an error.
- **Schema v7 means every worktree on this branch seeds a private database copy** (ADR 0021) until
  the bump lands on main. Expected.
- **Telemetry is self-reported and unauthenticated**, exactly like `--as` and like ADR 0005's
  runtime. It is for reading the board, not for billing or enforcing anything.
- **`flock log --session <key>` and `--model` filters are a where-clause away**, because `session`
  is a real column and not JSON in the `data` blob.
- If per-card dollars are ever genuinely wanted, the door left open is a price table in core
  (`pricing.ts`, model id → per-Mtoken rates, unknown model ⇒ no number, never a guess). Nothing
  here forecloses it, and nothing here requires it.

## Implementation

Six cards, in blocker order. Each is sized for one sonnet delegation on the
`feature/harness-telemetry` branch, worktree `~/repos/flock-worktrees/harness-telemetry`.

1. **core: schema v7, the session key, and the telemetry store.**
   Add `Runtime.session` and the `harness_sessions` table (`db.ts` `SCHEMA` + additive `migrate()`
   guards, `SCHEMA_VERSION` 6→7); `emit`/`touchActor`/`rowToEvent`/`listActors` carry `session`;
   new `recordSessionReading`, `sessionsForCard`, `sessionsForActor`, and card duration from the
   claim/close events. Core does no filesystem work. Tests in `packages/core/test/` for the
   migration, the upsert, null-never-clobbers-known, and duration with and without a close.

2. **packages/harness: the reader interface and the Claude Code reader.** *(blocked by 1)*
   New workspace package: `HarnessReader`, `SessionReading`, the registry, and
   `claude-code.ts` — cwd encoding, transcript resolution, tail-scan for `cost-state`, context
   from the last assistant line, catalog glob for the max, the tool histogram, and liveness
   (mtime, pid file, `procStart` timezone-normalized reuse guard). Every read bounded by size,
   line count and timeout, with `partial` rather than an exception. Tests run off checked-in
   fixture transcripts, never the real `~/.claude`.

3. **CLI: detection, the verb, and the opt-in hook.** *(blocked by 1, 2)*
   `detectRuntime()` learns `session` from `CLAUDE_CODE_SESSION_ID`; `resolveActor` keeps the
   flag → env → detect precedence with a `--session` flag and `FLOCK_SESSION`. New
   `flock telemetry [card] [--refresh] [--json]` plus the hook-facing `flock telemetry record`
   (reads the hook payload on stdin, exits 0 on every failure, prints nothing). `flock setup`
   gains `--hooks` / `--no-hooks` / `--remove-hooks` writing a marked entry into
   `~/.claude/settings.json` via temp-file-and-rename, refusing to write a file it cannot parse,
   with `FLOCK_NO_HOOKS=1` as the env opt-out. `done`/`release` do one best-effort read.

4. **server: refresh on read, and telemetry in the payloads.** *(blocked by 1, 2)*
   `GET /api/boards/:b/cards/:n` and the actor profile route refresh non-ended sessions whose
   `observed_at` is older than the 15s TTL, single-flight per key, never blocking the response on
   a slow read; ended sessions are never re-read. `telemetry` and `duration` on the card payload,
   `telemetry` + `totals` on the actor payload, `session` on `/api/actors`. The `transcript` path
   is omitted unless the request is from loopback. No new event type and no SSE change.

5. **web: the Run block and the actor totals strip.** *(blocked by 4)*
   Card page Run rows (model chip, cost, context bar, duration, tools, liveness dot + last
   activity, `alsoWorked` note); actor page totals strip and per-card duration; a 30s refetch
   while a card page is open on a `doing` card with telemetry, reusing `useCoalescedRefetch`.
   New colour tokens for the four liveness states in `styles.css` only, contrast gate green.
   Unknown renders `—`, never `$0.00`, and the whole block is absent when there is no telemetry.

6. **verification and docs.** *(blocked by 3, 4, 5)*
   End-to-end against an isolated database (`FLOCK_DB` in the scratchpad, never the shared board):
   a real Claude Code session claims and closes a card, numbers land, liveness moves
   `running → gone`, the hook install is idempotent and `--remove-hooks` restores the file byte
   for byte. `bun test`, `bun run typecheck`, `bun run build` green. `docs/harness-telemetry.md`
   (what the hook is, what it reads, what it stores, how to remove it by hand), `docs/config.md`
   for `FLOCK_NO_HOOKS`/`FLOCK_SESSION`, README and CLAUDE.md lines, and this ADR marked accepted.
