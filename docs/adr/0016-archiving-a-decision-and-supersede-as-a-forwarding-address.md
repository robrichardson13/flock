# ADR 0016: Archiving a decision, and supersede as a forwarding address

**Status:** accepted, 2026-09-11

## Context

A board's decisions list is append-only (#25). `decisions` is `(id, board_id, card_num, gist,
author, created_at)` with no number, no state, and no link (`packages/core/src/db.ts:90`); `decide`
inserts and `decisions` returns every row in `created_at, rowid` order
(`packages/core/src/flock.ts:1115-1133`). There is no delete, no archive, and no supersede.

One real board reached 113 decisions of which roughly 90 were routine merge confirmations and
verification scorecards. `flock decisions` stopped being the list of rules that bind the work and
became a run log, and because `snapshot()` embeds the full list, the noise also reached
`flock board show`, the web Decisions pane, and `boardToMarkdown`.

Two separate problems are tangled here. The first is that the list has no way to get shorter. The
second is that nothing told agents what a decision is: `skills/flock/SKILL.md:146` says to record
what the human and the subagents decide with `flock decide`, and `flock handoff` offers
`flock decide "<gist>" --card <n>` with no test for what qualifies. Every one of those 90 rows was
an agent doing as it was told. No schema fixes that.

A further constraint shapes every option: `Decision.id` is a `shortId()` and the project never
exposes internal ids, so there is currently nothing typeable to address a decision by. The issue's
"delete by id" is unimplementable as written. Any shape at all needs a per-board number first.

## Decision

Decisions get a per-board `num`, and one piece of state: a nullable `archived_at`. An archived
decision still exists, still has its author and its `decision.recorded` event, and no longer
appears in the default listing. Supersede is not a third state — it is an archive that carries a
forwarding address, a nullable `superseded_by` holding the `num` of the decision that replaced it.

- `decisions()` returns standing decisions (`archived_at IS NULL`) ordered by `num`. That one
  predicate is the whole noise fix, and it fixes `board show`, the web pane and the export at once.
  `{ archived: true }` and `{ archived: "all" }` open the rest.
- `decide(..., { supersedes: n })` records the new decision and archives `n` with
  `superseded_by` set, in one transaction.
- `archiveDecisions` / `restoreDecisions` take a selector — explicit numbers, or `card` / `author` /
  `before` — because a 90-row cleanup is not 90 invocations. Both are idempotent: archiving an
  already-archived decision is a no-op at exit 0, the same way `unhold` on a card that is not held
  is. Restoring clears `archived_at` and `superseded_by` together.
- No hard delete of a decision, anywhere, by any route. `board delete` stays the only eraser.
- Audit lives where it already lives: `events`. `decision.recorded` is immutable and attributed, and
  archiving adds `decision.archived` / `decision.restored` carrying the actor, the num and an
  optional reason. Nothing rewrites a gist and nothing removes a row.
- `SCHEMA_VERSION` goes 2 → 3. The migration is additive plus one backfill: `num` assigned per
  board in `created_at, rowid` order, the order `decisions()` already lists in, so existing boards
  renumber stably and nothing changes until someone archives.
- The markdown export writes standing decisions under `## Decisions so far` and archived ones under
  `## Decisions (archived)`, and the importer maps the heading back, so a round-trip neither drops
  the archive nor resurrects 90 rows as standing rules.
- `SKILL.md` and `handoff.ts` are reworded in the same change: a decision is a rule that binds
  later work; merge confirmations, test results and scorecards are `flock comment` or
  `done --resolution`. That is the part that prevents the next 90.

## Consequences

- Humans now hold two number namespaces on one board. Decisions print as `d7` and accept `7` or
  `d7`; cards stay `#7`. Output never prints `#` for a decision.
- `snapshot().decisions` narrowing to standing is a behaviour change for existing `--json`
  consumers. `archivedDecisionCount` is added alongside so nothing has to guess.
- A v3 database cannot be opened by an older binary — `SchemaVersionError`, by design. That is a
  real cost for anyone running an installed `flock` and a checkout against the same database.
- Bulk archive by `--author` or `--before` can take out a standing rule. `--dry-run`, and a `--yes`
  gate on any selector matching more than ten, mitigate it; they do not eliminate it.
- `superseded_by` is one hop, not a chain. Superseding a decision that was already superseded is a
  conflict (exit 3): point at the standing rule. Long revision histories are recoverable by walking
  the pointers but are not rendered as a chain, and nothing prevents someone from reading the
  one-hop pointer as a poor man's graph later.
- Archiving records a reason only when one is given. A row archived without one is
  indistinguishable from a tidy-up, which is usually exactly what it was.

## Alternatives considered

**A — archive only, no supersede (minimal).** Almost this, and the spine came from it: two nullable
columns, a predicate, no taxonomy. Rejected only on completeness. The issue asks for supersede
explicitly, and `superseded_by` is one nullable integer on a row that already had to gain
`archived_at` — cheaper now than a second migration later, and it turns a citation into a
forwarding address instead of silence. A's bulk story (`N...` and a conceded `--before`) was too
thin for the board that actually hurt, so C's selector came in.

**B — supersede chain, retract, never delete.** The chain answers a question #25 did not ask.
Nothing supersedes a merge confirmation, so for roughly 90 of the 113 rows `--supersedes` has
nothing to point at, and B still has to hide something — meaning it needs A's predicate anyway,
plus a join table, non-head conflicts, a chain renderer, and a tombstone row that is a second write
where the truth needed zero. Its real claim, that nothing should be destroyed, is already satisfied:
archiving destroys nothing, and `events` never forgets.

**C — a closed `standing | archived | superseded` status column.** C's bulk selector is adopted
wholesale, and its markdown round-trip with it. The status enum is not. `archived` plus a nullable
`superseded_by` expresses the same three cases with one fewer concept, and C concedes the overlap
itself: superseded is archived-with-a-pointer. An enum also invites a fourth value — `draft`,
`pinned` — that a nullable timestamp cannot. C's `status_at`/`status_by` are likewise dropped;
`archived_at` is the timestamp, and the `decision.archived` event carries who.
