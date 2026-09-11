# ADR 0021: A worktree never stamps the shared database

**Status:** accepted, 2026-09-11. Amends [ADR 0003](0003-per-checkout-dev-environment.md) (every checkout shares `~/.flock/flock.db`) and [ADR 0012](0012-single-binary-distribution-and-a-daemon-instead-of-pm2.md) (the `user_version` guard on open).

## Context

ADR 0003 made every checkout share one database so the web app shows every worktree's board in one list, and ADR 0012 added a guard: `openDatabase` migrates an older file up to the build's `SCHEMA_VERSION` and stamps it, and refuses a newer stamp outright. The guard exists for released binaries, where an old build opening a database a newer build has already migrated is a real hazard.

Between checkouts of one repo the guard cuts the wrong way. The first worktree to bump `SCHEMA_VERSION` migrates the shared file the moment it opens it, and from then on every other checkout — including the canonical one, whose daemon serves :4747 and whose CLI the conductor skill runs — fails on open with "supports schema v5, but the database is stamped v6". ADR 0020 records one afternoon of that. The worktree that broke everything is also the one that was never going to be the thing that should have decided when the shared database moves.

The obvious fix, isolating every worktree by default, throws away the reason for sharing: the canonical app would no longer show in-flight branches' boards, and `needs-me` and `log --all` would go blind to them. Most branches never touch the schema.

## Decision

Only the canonical checkout or an installed binary migrates the shared database. `openDatabase` takes a policy with two independent knobs (`OpenOptions` in `packages/core/src/db.ts`):

- `migrate` (default true). When false and the file is behind the build, throw `SchemaBehindError` before writing a byte.
- `allowNewer` (default false). When true and the file is ahead of the build, open it, skip the schema block and the migrations, leave the stamp alone, and expose the skew on the `Flock` instance. This is sound within one repo's history because migrations are additive by contract (the comment on `SCHEMA_VERSION`); it is not sound across releases, so the installed binary keeps the hard refusal.

The CLI picks the policy from what code is running, not from the cwd (`schemaPolicy` in `packages/cli/src/schema-policy.ts`): an installed binary gets the defaults; the canonical checkout migrates and tolerates newer; a linked worktree (`isLinkedWorktree` over the CLI's own source tree) tolerates newer and refuses to migrate the shared file. A worktree pointed at any other file — `--db`, `FLOCK_DB`, or its own `.flock/flock.db` — migrates it as before; the protection is for the shared file only.

When a worktree would have to migrate the shared file, the CLI seeds a private copy instead of failing: `VACUUM INTO` (consistent under WAL) to `<worktree>/.flock/flock.db`, a `.gitignore`, and a `seeded-from-shared` marker, then opens the copy and prints one stderr line saying so. `resolveDbPath`'s existing walk-up finds the copy on every later run from inside the worktree with no flag and no state file. `flock up` makes the same decision before spawning (`worktreeDbFallback` in `daemon.ts`), so the API and vite children start on the copy and the runfile records it. The copy holds every board the shared file had at seeding time, so the worktree's app still shows its own board.

An older checkout opening a newer shared file — a worktree that has not rebased past a merged bump — proceeds with one stderr warning per process. `--json` stdout is untouched.

There is no automatic rejoin. A seeded copy stays until the worktree is removed, which for a schema branch is right after its PR merges. `flock status` prints a hint naming the directory to remove once the shared file has caught up, keyed on the marker, so a deliberate `--isolated` never sees it.

## Consequences

- A schema bump on a branch costs the other checkouts nothing. The shared file moves exactly once, when the canonical checkout pulls the merged bump and its `bun --watch` daemon reopens.
- The seeded copy diverges from the shared file from the moment it is made. Cards written on the branch's board during that window live only in the copy and die with the worktree, the same as `--isolated` today. That is the price of the rule, and the note says so.
- A contributor who works only in worktrees and never runs a canonical checkout will never see the shared file migrate; every schema-bumping worktree of theirs lands on a copy and the status hint tells them why. That is intended, not a gap.
- `allowNewer` relies on the additive-migration contract. A migration that breaks it fails loudly on the write that hits the new constraint, which is the right failure; it is not silently absorbed.
- `SchemaVersionError` and the installed binary's behaviour are unchanged. `flock upgrade` remains the answer there.
