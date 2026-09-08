# ADR 0007: Images attach to messages as blobs in the same SQLite file

**Status:** accepted, 2026-09-06

## Context

The channel takes text only. A human watching a board wants to paste a screenshot into it — a broken
render, a design, a terminal window — and agents want to read what was pasted. Nothing in the repo
has a concept of a file today: no upload route, no blob column, no bytes anywhere (see the survey on
card #2).

Two constraints shape the answer. ADR 0001 made one SQLite file the store, and the operational
promise that follows from it is that a backup is `cp ~/.flock/flock.db`. There is also a hosted
instance on Railway with a single volume. Anything that puts bytes beside the database gives us two
things to back up, two things to move, and a restore that can disagree with itself.

The other constraint is that a message is written from four places — the web composer, `flock say`,
an agent shelling out, and the HTTP API — and only the web can resize an image. Whatever the client
does, the server has to be the thing that says no.

## Decision

**Bytes live in a `attachments` table in the same database, as a BLOB.** One file stays one file:
one backup, one volume, one thing to move. Deleting a board takes its images with it through the
existing `ON DELETE CASCADE`, with no directory to sweep. The alternative — files under
`~/.flock/attachments/` — buys cheaper page cache and a smaller db in exchange for path escaping, a
second static route that must 404 rather than fall through to `index.html`, and orphaned files after
any restore. With a 5 MiB hard cap per image that trade is not worth making. The row keeps its
metadata (`mime`, `size`, `width`, `height`, `sha256`) in columns separate from `bytes`, so if a
board ever ingests hundreds of megabytes, a later ADR can move the bytes to a content-addressed
directory without changing the public contract.

**Upload first, reference by id.** `POST /api/boards/:b/attachments` with the raw image as the
request body stores it and returns an attachment with a public id; `POST .../messages` then names
those ids in an `attachments` array. Multipart on the message post was the alternative. Upload-first
wins because the upload starts the moment an image is pasted, so send is instant and the thumbnail
has somewhere to come from; because a failed message post does not re-send the bytes; because the
message write stays one small JSON body that a shell script can produce with `printf`; and because
the server never has to parse multipart. The cost is orphans, handled below.

**The public id is a `shortId()`**, the same eight-character generator every row already uses. Cards
are addressed by `#n` and boards by slug because those are things a human names; an attachment is
not, so it uses its id, exactly as a channel message already exposes its `id` in `--json`. The id is
not a capability: the board is in the path and flock has no auth anywhere yet.

**A message references its images structurally, not inline.** `Message` gains
`attachments: Attachment[]`, ordered as the sender listed them, and the body is stored verbatim as
ADR 0006 requires. Inline `![](flock:id)` would mean widening the message grammar — which 0006 says
is a decision, not a version bump — and would force every `--json` consumer to parse prose to find
out what came with a message. The web renders a thumbnail grid under the text. Positioning images
within a paragraph is not something a channel message needs.

**Limits are the client's manners and the server's rule.** The web downscales to a 1568 px longest
edge and re-encodes to JPEG at q0.8 to land under ~3.5 MB, following what nib does for the same
reason (card #1). The server independently enforces a 5 MiB hard cap by reading the upload body as
a stream and aborting past the limit — it never trusts a declared `content-length` on its own, since
that can be absent, wrong, or simply lied about — plus an allowlist of `image/png`, `image/jpeg`,
`image/gif`, `image/webp`, and magic-byte sniffing that must agree with the declared content type. A
client that lies is rejected.

**No new event type.** `message.posted` gains an `attachments` count in its data. The web already
refetches the board snapshot on that event and the snapshot carries the attachment metadata, so a
new type would buy nothing and would need adding to the type list in `live.ts`.

**Orphans expire.** An attachment with `message_id IS NULL` is a paste that was never sent. Every
`say` on a board first deletes that board's unbound attachments older than one hour, excluding
whichever ids that same `say` is about to bind, so a message never sweeps away the very image it is
posting. It is one indexed `DELETE`, it needs no daemon and no cron, and the worst case is an hour of
dead blob for an image the human staged and abandoned.

**Markdown export is unaffected.** `flock board export` does not carry channel messages today, so it
does not carry attachments either. Images are runtime state; `cp flock.db` is how you keep them.

## Consequences

- The database grows with pictures. SQLite is comfortable with 5 MiB blobs, but space from deleted
  images is only returned to the filesystem by `VACUUM`, and every list query must be careful never
  to `SELECT *` a row that has a `bytes` column in it.
- A message may now have an empty body if it has at least one attachment. `say` enforces "a body or
  an attachment"; the old "body is required" rule is relaxed, not removed.
- `Message` in every `--json` payload gains a field. It is additive and always present as `[]`, so
  existing parsers keep working, but the shape is now part of the stable output.
- Content is not deduplicated. The `sha256` column is stored and used as the ETag, so adding
  dedupe later is a query change, not a migration.
- The CLI does not resize. `flock say --attach` uploads the file as it is and fails over the cap,
  because resizing in the CLI means an image dependency and `@flock/core` has none.
