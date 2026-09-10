# ADR 0015: Hold is a flag on a card, not a status

**Status:** accepted, 2026-09-10

## Context

A human wants to drop cards on the board for later without an agent picking them up while
the idea is still fresh (#18). Today that is done with prose — a comment saying "don't start
this yet", a line in the brief, a word to the conductor over the channel — and prose is soft:
every agent has to read it, understand it, and agree with it, and a fresh agent running
`flock claim` has no structural reason to skip the card at all.

Blockers do not cover it. A blocker is a card-to-card dependency that resolves on its own when
the blocking card closes, and `claim --force` deliberately claims past one, because an agent
may judge that an ordering guess no longer applies. A human saying "not yet" is neither of
those things.

The open question was flag versus status. A sixth `CardStatus` keeps the board's column story
literal: held cards get a lane. A flag keeps `todo` truthful and lets a held card keep whatever
status it already had.

## Decision

Hold is a **flag**: three nullable columns on `cards` (`held_at`, `held_by`, `hold_reason`) and
a derived `held` boolean on `Card`, the same shape `blockedBy` / `blocked` already has. Schema
version goes to 2 with an additive migration.

- `claimCard` rejects a held card with a `conflict` — HTTP 409, CLI exit 3 — before it checks
  blockers, and `force` does not override it. Force is for an ordering guess an agent may
  revise; a hold is a person's instruction with no machine-visible expiry, so an agent that
  could force past it would have exactly the authority the prose convention had.
- Nothing else is gated. Comments, edits, moves, asks, answers and closes all work on a held
  card, and an agent already holding a claim can finish its work.
- The frontier (`listCards --frontier`, `snapshot().frontier`) excludes held cards, and
  `needsHuman()` excludes them too: a held card was parked on purpose, so it is not an inbox item.
- `flock hold N [--reason]` and `flock unhold N`, mirrored as `POST .../cards/:n/hold` and
  `.../unhold` and as a Hold / Release hold control on the card page. `flock release` keeps its
  one existing meaning — give back a claim — and neither sets nor clears a hold.
- Two events, `card.held` and `card.unheld`, carrying the reason and the actor, so the activity
  feed and the conductor's listener both see it.
- Statuses are unchanged: `CARD_STATUSES`, the kanban columns, `snapshot().counts` and
  `boardStateOf` all keep exactly the five members they had.

## Consequences

- A held card keeps its column. That is the point — a held `doing` card is still being worked
  and still shows its assignee — but it means a reader spots a hold from a badge and a dim, not
  from where the card sits. The badge is a pause glyph in `--status-held`, deliberately grey:
  amber is spoken for by blocked, and parked is quiet, not alarming.
- Hold never auto-resolves and nothing but `unhold` clears it, including a close. Holding a
  closed card is therefore refused, so no card can be reopened through an invisible gate.
- `held_by` and `held_at` do not survive a markdown export/import round trip; the fact of the
  hold and its reason do. That is the same boundary ADR 0001 already draws for `createdBy` and
  timestamps.
- Schema v2 means a v1 binary opening a v2 database is fine to read but would not honour a hold,
  which is exactly what the `user_version` stamp exists to make visible.
- Timed release ("hold until Friday") is out of scope. It would put a clock in a domain that has
  none, and the whole value of hold is that only a person lifts it.
- An agent can still call `flock unhold`. The gate is structural against `claim`, not an ACL;
  the handoff text and the skill both say plainly not to route around it, and every lift leaves
  an attributed `card.unheld` event.
