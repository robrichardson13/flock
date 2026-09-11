# ADR 0019: Emoji reactions on card comments

**Status:** accepted, 2026-09-11

## Context

ADR 0018 gave the board channel reactions, and the same argument applies one screen over. A card's comment thread is where the work is actually discussed — a human answers a question, an agent reports what it found — and acknowledging any of it still costs a whole comment, which lands in the activity feed and on anyone tailing the log.

Comments had the same missing piece messages did: no public address. `comments` carried only an internal `id`, and CLAUDE.md forbids exposing internal ids, so nothing could name the comment being reacted to.

## Decision

- **A comment is addressed by a per-card number, spelled `4.2`** — the second comment on card #4. `comments` gains a `num` column allocated per card (`MAX(num) + 1` for that card, inside the insert transaction) and backfilled for existing rows in `created_at, rowid` order — the order `comments()` already lists in — under a unique index on `(card_id, num)`. Per-card, not per-board, because every comment API already takes its card (`comments`, `addComment`), because `comments` carries no `board_id` for a per-board unique index to exist against, and because `4.2` still reads as one unambiguous token a CLI or a route can take whole: `commentRef(cardNum, num)` writes it and `parseCommentRef` reads it back, the two places the dot is spelled. Internal ids stay internal. Every comment is numbered, `question`/`answer`/`resolution` kinds included, so every comment is reactable.
- **Storage is a second table**, `comment_reactions(board_id, comment_id, actor, actor_kind, emoji, created_at)` with `PRIMARY KEY (comment_id, actor, emoji)` — the same shape as `reactions`, one row per (comment, actor, emoji). Not a nullable `comment_id` on `reactions`: that table's `message_id` is `NOT NULL` and half its primary key, and migrations here are additive-only (ADR 0012), so widening it would mean a table rebuild. Two narrow tables each keep a real foreign key and a real primary key; the cost is one more aggregation query, which is the same code twice.
- **`reactToComment` and `unreactFromComment`**, the twins of `react`/`unreact` with the card in front: `(actor, boardRef, cardRef, num, emoji)`. Each is idempotent, emits nothing when nothing changed, and returns `{ comment, changed }` rather than a toggle — same reasoning as 0018.
- **Emoji validation is shared, not re-derived.** `normalizeEmoji` is the same function; core still does not police which emoji.
- **Events `comment.reacted` / `comment.unreacted`** carry the actor and actorKind like every other event, with `cardNum` set (every comment event has one) and `data` = `{ emoji, card, num, ref, commentAuthor, commentAuthorKind, gist, count }`. `count` is the emoji's tally *after* the change; `gist` is `commentGist`, the same whitespace-collapsed 120-character precis `messageGist` produces, standing in as `(image)` / `(N images)` for an image-only comment. `comment.posted` gained `num` and `ref` for the same reason `message.posted` did: a listener acting on the log needs no second lookup to react back.
- **Reads carry reactions aggregated for rendering**: `Comment.reactions` is `{ emoji, count, actors }[]`, most-used emoji first with ties in first-use order, exactly like `Message.reactions`, so the web renders one component either side. `Comment` also carries `num` and `cardNum`, so a rendered comment knows its own ref without asking its container.
- **No push notification.** `notificationFor` is an allowlist, so the two new types produce nothing; the catch-all test in `notify.test.ts` names them, the way 0018's types are named, so the silence is deliberate.
- **Schema v6.** v5 is reactions on messages (ADR 0018).

## Consequences

- Markdown export does not carry comments at all, so reactions have nothing to round-trip — the same hole 0018 left for messages, pinned by the same kind of test.
- `num` is nullable in SQL — `ALTER TABLE` cannot add a `NOT NULL` column without a default — and non-null in the `Comment` type. Every row is backfilled by the migration and every insert supplies one; the unique index is what keeps it true.
- A comment's ref is stable only as long as its card's number is, which is forever, and comments are never deleted. Nothing renumbers.
- Two reaction tables mean two queries, two aggregators, and two event shapes that must stay in step. A third reactable thing is the point at which the pair should be generalised rather than tripled.
- A v5 database opens fine here and is migrated to v6; a v5 binary refuses a v6 file with `SchemaVersionError`.
