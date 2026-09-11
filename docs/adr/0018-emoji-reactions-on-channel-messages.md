# ADR 0018: Emoji reactions on channel messages

**Status:** accepted, 2026-09-11

## Context

The board channel is where humans and agents talk. Acknowledging a message — "seen", "yes", "shipped" — costs a whole message of its own today, and a channel full of one-word replies is a channel nobody skims. Reactions are the cheap acknowledgement every other chat tool has.

Two things were missing before they could exist. A message had no public address: `messages` carried only an internal `id`, and CLAUDE.md forbids exposing internal ids, so nothing could name the message being reacted to. And an agent tailing `flock log --follow --json` had no way to learn that a human just reacted to something it said.

## Decision

- **A message is addressed by a per-board number, spelled `m7`.** `messages` gains a `num` column, allocated the way card and decision numbers already are (`MAX(num) + 1` per board, inside the insert transaction) and backfilled for existing rows in `created_at, rowid` order — the order `messages()` already lists in — under a unique index on `(board_id, num)`. `messageRef(num)` is the single place the `m` prefix is spelled. Internal ids stay internal.
- **Storage is one row per (message, actor, emoji)**: `reactions(board_id, message_id, actor, actor_kind, emoji, created_at)` with `PRIMARY KEY (message_id, actor, emoji)`. The uniqueness that makes reacting idempotent is the schema's, not the caller's. No surrogate id, because nothing ever addresses a single reaction. An actor may hold several different emoji on one message.
- **`react` and `unreact`, not a toggle.** Each is idempotent and returns `{ message, changed }`: reacting twice with the same emoji writes nothing, emits nothing, and returns `changed: false` — never an error. A toggle hides which of the two happened, which is exactly what a CLI or an HTTP verb needs to report; a UI that wants a toggle builds one out of the pair, since the message it gets back already says who reacted with what.
- **Core does not police which emoji.** New emoji ship faster than any table of them. `normalizeEmoji` trims, then rejects only what would turn a reaction into a chat message: empty, whitespace inside, or longer than 12 code points (a flag or a ZWJ family fits).
- **Events `message.reacted` / `message.unreacted`** carry the actor and actorKind like every other event, with `data` = `{ emoji, num, ref, messageAuthor, messageAuthorKind, gist, count }`. `count` is the emoji's tally *after* the change. `gist` is the message body with whitespace collapsed, truncated to 120 characters, standing in as `(image)` / `(N images)` when the message is nothing but attachments. A listener acting on the log needs no second lookup. `message.posted` gained `num` and `ref` for the same reason.
- **Reads carry reactions aggregated for rendering**: `Message.reactions` is `{ emoji, count, actors }[]`, most-used emoji first with ties in first-use order, and `actors` oldest first. The web renders that row directly and answers "did I react" by looking for its own name; core has no viewer to ask.
- **Schema v5.** v4 is taken by the push-subscription table that landed with Web Push (ADR 0017), so reactions build on top of it as v5.

## Consequences

- Markdown export does not carry channel messages at all, so reactions have nothing to round-trip. Pinned by a test, so whoever teaches the exporter about messages is told to bring reactions along.
- `num` is nullable in SQL — `ALTER TABLE` cannot add a `NOT NULL` column without a default — and non-null in the `Message` type. Every row is backfilled by the migration and every insert supplies one; the unique index is what keeps it true.
- A reaction is attributed to an actor *name*. Renaming an actor is not a thing flock does, and if it ever is, reactions are one more table to carry across.
- Reactions ride the existing SSE event stream, so a reacting storm is a refetch storm. The web's coalesced refetch (`useCoalescedRefetch`) already absorbs that.
- A v4 database (one stamped by a binary that has Web Push but not reactions) opens fine here and is migrated to v5, but the reverse does not hold: a v4 binary refuses a v5 file with `SchemaVersionError`.
