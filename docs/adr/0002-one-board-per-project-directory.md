# ADR 0002: One board per project directory, one global database

**Status:** accepted, 2026-09-05

## Context

The `/orchestrate` skill scopes its state file per task. The maintainer works in git worktrees, one per effort, and runs several agents at once. Two boards in one directory would let agents on the same checkout collide on work; one board across directories would mix unrelated efforts.

## Decision

- A board carries a `project`: the absolute directory it is scoped to. A directory has at most one active board (archiving frees it).
- The CLI resolves the board from the working directory by picking the board whose `project` is the longest matching ancestor prefix of the cwd, so the board argument is optional. A worktree nested under a repo resolves to its own board, not the repo's.
- The default database is the global `~/.flock/flock.db`. One `flock serve` therefore shows every project: the sidebar lists boards in server order with the repo named on each item, and Home groups them Active / Idle. `flock init --local` opts a directory into an isolated `.flock/` database.

## Consequences

- Boards without a project are still allowed (created from the web app or `flock board new`); they just never resolve implicitly.
- Deleting or moving a directory orphans its board's project path. Archive it, or repoint with `flock board edit --project DIR`.
- The `.flock/` walk-up is still honored when present, so an isolated database silently takes over inside that tree. The `serve` banner prints which database it opened.
