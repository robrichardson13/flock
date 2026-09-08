# ADR 0009: Hard delete a board, alongside archive

**Status:** accepted, 2026-09-07

## Context

Until now the only way to retire a board was to archive it: `flock board edit --archive` flips `boards.status` to `archived`, which hides it from `flock boards` and frees the project directory for a new board (ADR 0002). That is the right answer for a board with history worth keeping.

It is the wrong answer for the boards that actually accumulate. A worktree gets a board, the branch merges, the worktree goes away. An experiment gets a board that was never meant to outlive the afternoon. A mistyped `flock init` gets a board with nothing on it. Because worktrees share `~/.flock/flock.db`, every one of those stays in the file forever, and archiving only moves them behind `--all`. There was no way, from the CLI or the web app, to say "this was throwaway; remove it."

## Decision

Add hard delete at all three layers.

- **Core.** `Flock.deleteBoard(actor, ref)` resolves the board the way every other method does (`this.board(ref)`, so an unknown ref throws `FlockError("No board matches …", "not_found")`), then deletes the board row and every row scoped to it in one transaction: comments and blocking edges via the board's cards, then cards, attachments, messages, decisions, events. It returns `{ slug, cards }` — the card count is what a confirmation prompt needs. Archive stays exactly as it is; the two are different answers to different questions.
- **Server.** `DELETE /api/boards/:b` → 204 with an empty body, 404 for an unknown board through the existing `FlockError` handler, actor from the `x-flock-actor` headers like every other write.
- **CLI.** `flock board delete [BOARD] [--yes]`. It confirms — "Delete board <slug> and N cards? [y/N]" — unless `--yes` is passed, and refuses outright rather than assuming consent when stdin is not a TTY. Unlike every other verb, a named board that does not exist is an error instead of falling through to the working directory's board: a typo must not delete the wrong thing.

Two details are deliberate.

**Every child table is deleted explicitly**, even though `cards`, `messages`, `decisions` and `attachments` declare `ON DELETE CASCADE` on `boards(id)`. Cascades in SQLite only fire while `PRAGMA foreign_keys` is on, which is a per-connection setting; `openDatabase` sets it, but a domain rule should not depend on how the connection was opened. `events` needs the explicit delete regardless — its `board_id` carries no foreign key at all.

**No event is written.** `events.board_id` is `NOT NULL`, so there is no board-less row to record a deletion in, and every event that could have named this board is being deleted with it. A web client that just issued the `DELETE` navigates home on the 204; the SSE stream for a board that no longer exists has nothing left to say.

## Consequences

- Deletion is unrecoverable short of a database backup. The confirmation prompt and the non-TTY refusal are the only guardrails, so `--yes` in a script means what it says. `flock board export` before deleting is the way to keep a copy.
- Attachment bytes live in the `attachments` table, so they go with the board; there is no separate blob store to sweep.
- Archive keeps its place as the reversible option, and remains what `board edit --archive` and the project-uniqueness rule in ADR 0002 talk about. Delete also frees the project directory, by removing the board entirely.
- Actors are global, not board-scoped, so `flock actors` still lists someone whose only writes were to a deleted board. That is correct: the actor existed.
