# ADR 0001: SQLite is the store, markdown is the interchange format

**Status:** accepted, 2026-09-05

## Context

VISION.md leaned toward markdown as the on-disk truth with SQLite as an index. The first real requirement is a CLI that many agent processes call concurrently, with a compare-and-swap claim and a monotonic event log, plus a web app that updates live.

## Decision

One SQLite file (WAL mode), `~/.flock/flock.db` by default, is the source of truth. The CLI and the server both open it directly through `@flock/core`; no daemon is needed for agents to write. Markdown is produced by `flock board export` and consumed by `flock board import`, and the board skeleton (title, body, decisions, card nums, titles, statuses, assignees, labels, blockers, the pending question) round-trips; comments, channel messages, timestamps and `createdBy` do not, and import always creates a new board.

**Refined by ADR 0002:** the default database location and per-directory board scoping are decided there.

## Consequences

- Claim CAS and event sequencing are one `UPDATE ... WHERE assignee IS NULL` and one autoincrement. No lock server.
- Live updates are the server tailing the events table every 500 ms and pushing SSE. Simple, and it sees writes from any process.
- Editing the markdown export by hand does not change the board until it is re-imported. Live CRDT editing of the markdown is out of scope for now.
- Backups are `cp ~/.flock/flock.db`, or `flock board export` into git.
