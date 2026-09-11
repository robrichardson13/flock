# ADR 0022: Remove the board-creation hook

**Status:** accepted, 2026-09-11. Supersedes [ADR 0008](0008-board-creation-hook.md).

## Context

ADR 0008 gave the web app's "+" and `flock hook run` an optional `~/.flock/hooks/board-create`
executable: a `describe` mode that could declare a small field schema (text/textarea/select/
checkbox) rendered under the title in the new-board dialog, and a `create` mode that ran before the
board was written and could override its title, slug, body and project directory. It existed
because the web app could otherwise only make a projectless board, and starting real work usually
means making a new directory first — a git worktree, an IDE workspace — which is local and
per-tool, not something flock should grow a plugin system for.

In practice the surface area cost more than the feature was worth. A permission and ownership guard
(`findHook`), a spawn/timeout/pipe-draining subprocess runner (`runHook`), an output parser with its
own error taxonomy (`parseHookOutput`, `HookError`), a field-schema normalizer and merge step
(`normalizeFields`, `mergeBoardInput`), two CLI subcommands, two HTTP routes with a bespoke
`x-flock-hook` CSRF header, and a web form that rendered four field types with select-blank
semantics — all of it existed to let one optional external script customize four board attributes.
Nobody had more than one hook installed at a time, and the feature made the new-board dialog's own
code (loading state, field revalidation on reopen, `describe`-then-`create` sequencing) harder to
follow than the plain form it degraded to whenever no hook was present.

## Decision

Remove the board-creation hook entirely: `packages/core/src/hooks.ts` and its test, the CLI's
`hook describe`/`hook run` subcommands, the server's `GET /api/hooks/board-create` and
`POST /api/boards/hook` routes and their tests, the web form's hook-fetch/field-rendering code and
its `.hook-field`/`.hook-stderr`/`.select`/`.select-wrap` styles, and `docs/hooks/board-create.md`.

`POST /api/boards` and `flock board new` are unchanged: title, and an optional project directory
that must be an absolute path. The web "+" dialog is now always the plain form ADR 0008 already used
as its no-hook fallback — nothing behind it degrades anymore because there is nothing left to
degrade from.

## Consequences

- Less code to read and fewer things that can go wrong creating a board: no subprocess, no field
  schema, no `x-flock-hook` header, no `hook_failed`/`hook_timeout`/`hook_output_invalid` error
  paths.
- Anyone who had `~/.flock/hooks/board-create` installed loses it silently: the file is simply never
  looked for again. Nothing reads or deletes it; a stale hook script left on disk is inert.
- A project directory still has to be typed or pasted into the dialog (or `flock init` run from
  inside it) rather than derived from a picked repo/branch/group. If that gap matters again later,
  the fix is a purpose-built flow for the one workflow that needs it, not a general-purpose hook.
