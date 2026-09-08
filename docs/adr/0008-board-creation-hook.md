# ADR 0008: A board-creation hook, one executable, before the board exists

**Status:** accepted, 2026-09-06

## Context

Boards are created by `flock init` and `flock board new` from a directory that already exists
(ADR 0002: one board per project directory). The web app's "+" can only make a projectless board —
`POST /api/boards` takes a title and nothing else — so the board a human makes from the browser is
never scoped to anything.

The way people actually start work is the other way round: the directory does not exist yet. Making
one is local and specific — a git worktree, or an IDE's workspace-create command, each with its own
arguments (a repo from a fixed list, a branch, a group). Flock cannot know any of it, and should not
grow a plugin for anybody's tooling.

## Decision

One optional executable, `~/.flock/hooks/board-create` (directory overridable with
`FLOCK_HOOKS_DIR`), discovered by existence and the owner-execute bit, refused if it is not owned by
the running user or is group/world writable. No config file, no registry; deleting the file disables
it.

It runs **before** the board is created, in two modes:

- `describe` — stdout is `{title?, submit?, fields:[{name,label,type,required?,placeholder?,
  default?,options?}]}` with `type` one of `text|textarea|select|checkbox`. The web form renders
  those fields under a Title field it always shows. Run on every dialog open, 5 s budget; a failure
  degrades to Title only.
- `create` — receives the title, the field values and the actor on stdin as JSON and in the
  environment (`FLOCK_TITLE`, `FLOCK_INPUT_<KEY>`, …), and may print a JSON object as its last
  non-empty line: `{project?, title?, body?, slug?}`. Those values win over the form's; `project`
  must be an absolute existing directory. Non-zero exit, a timeout (60 s, `FLOCK_HOOK_TIMEOUT_MS`)
  or an invalid `project` aborts: no board is written, and the API returns 502 with the exit code
  and the tail of stderr, which the dialog shows verbatim.

`POST /api/boards/hook` is the hooked path; `POST /api/boards` stays hook-free and gains an optional
`project`, which must be absolute — over HTTP a relative path would resolve against the server's own
working directory — and is canonicalized when it exists, the same as a hook's. The "+" button is
always present: with no hook installed the dialog is a title and an optional project directory.
`POST /api/boards/hook` requires the request header `x-flock-hook: 1`; missing it is a 403
`hook_header_required` before the hook is looked up. The web client sends it. A plain HTML `<form>`
POST cannot set a custom header, so this is what stops a cross-site form submission from running the
hook — it does not stop a page that uses `fetch`/`XHR` and sets the header itself, since CORS stays
open (see Consequences).

## Consequences

- The web app can finally create a directory-scoped board, hook or not.
- An HTTP request can execute a local program. `flock serve` binds 127.0.0.1 by default, but
  `--host` and `flock up` publish on the LAN and Tailscale; the ownership and permission guard is
  the only thing between those and a shell, and flock remains unauthenticated (README, Status).
  The 127.0.0.1 default is less of a boundary than it looks: the API is CORS-open
  (`Access-Control-Allow-Origin: *`, needed for the Vite dev server and for reaching a checkout over
  Tailscale), so before this hook that bought an attacker only a junk board; now it would buy them
  whatever the installed hook does — via the plainest form of cross-site attack, an auto-submitting
  HTML `<form>` POST, which needs no JavaScript and is not something CORS governs at all. The
  mitigation is `POST /api/boards/hook` requiring the header `x-flock-hook: 1`: a form cannot set a
  custom header, so it 403s before the hook runs. CORS stays open on purpose (Vite dev, Tailscale),
  so a page using `fetch`/`XHR` can still set the header itself and get through — narrowing CORS or
  authenticating the API would close that remaining gap and is not part of this ADR.
- A before-hook cannot see the board it caused. Seeding cards or writing the board URL into the new
  directory needs a `board-created` after-hook; the name is reserved and unimplemented.
- The field schema is deliberately small — four types, no conditionals, no validation beyond
  `required`. Hooks needing more will want a real settings surface, and that is the signal to
  reconsider rather than to grow the schema.
- Hooks are per-user, not per-repo, because at `board-create` time there is no repo to read one from.
- The hook contract is versioned (`version: 1`, `FLOCK_HOOK_VERSION`); unknown output keys are
  ignored so v2 can add fields without breaking v1 hooks.
