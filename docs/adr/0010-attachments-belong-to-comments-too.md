# ADR 0010: Attachments belong to card comments too

**Status:** accepted, 2026-09-07. Extends ADR 0007, which is otherwise unchanged.

## Context

ADR 0007 gave channel messages images: upload the bytes first, get an id back, then name those
ids when posting. Card comments got nothing, so the same screenshot had to be pasted in the
channel and described on the card. Since the card thread now draws with the channel's own
components (#44), an image in a comment is the only missing half of the same conversation.

## Decision

**One attachments table, two possible owners.** The table gains a `comment_id` beside
`message_id`; an attachment references exactly one of them, or neither while it is still
unbound. The alternative — a `(owner_kind, owner_id)` pair — buys generality we have no third
owner for, and costs the foreign key that makes a deleted card take its images with it.

**No new upload route and no new event type.** `POST /api/boards/:b/attachments` is unchanged
and its id is bindable to either owner; `POST .../cards/:n/comments` accepts the same
`attachments: [id]` array the message post does, and `comment.posted` gains the `attachments`
count and `attachmentList` that `message.posted` already carries, so the conductor's monitor
reads a card image exactly as it reads a channel one.

**A body or an attachment.** `addComment` now enforces the rule `say` already had: a comment
may have an empty body when it carries at least one image. A question, an answer and a
resolution are card state rather than talk, so they take no attachments; the web composer
hides the attach button outside Comment mode and refuses a send that would drop staged images.

**Orphan sweep counts both.** An attachment is an orphan while `message_id IS NULL AND
comment_id IS NULL`; posting either a message or a comment sweeps that board's orphans older
than an hour, still sparing the ids the current post is binding.

## Consequences

- `Comment` gains `attachments: Attachment[]` and `Attachment` gains `commentId`, so every
  caller that renders a message's images renders a comment's with the same component.
- `flock comment N TEXT --attach PATH` is repeatable and behaves as `say --attach` does.
- Old databases migrate additively: `comment_id` is added by `ALTER TABLE`, which cannot carry
  a foreign-key clause, so on a migrated file a deleted card leaves its attachment rows to the
  board-level delete rather than to `ON DELETE CASCADE`.
