# The `board-create` hook

Flock's web app makes a projectless board out of the box: the "+" button always works. But most
boards should be scoped to a directory, and the directory usually doesn't exist yet — it comes from
running a git worktree, an IDE workspace-create command, or a tool like `nb`, each with its own
arguments (a repo, a branch, a group). Flock can't know any of that and shouldn't grow a plugin per
tool, so instead it lets a human wire their own directory-making command in as a hook: one
executable, run before the board is created, that can hand flock a directory to scope the new board
to.

With no hook installed, the "+" dialog is just a Title field and an optional "Project directory"
text box, same as today, and nothing else in this document applies — see `docs/adr/0008-board-creation-hook.md` for the
full design.

## Where it lives

    ~/.flock/hooks/board-create

Override the directory with `FLOCK_HOOKS_DIR` (useful for tests or a second profile). There's no
config file and no registry: the presence of this one file, with the right permissions, is the
whole opt-in. `rm` disables it.

### Permissions

The file must be:

- owned by the user the flock server runs as
- not writable by group or other
- executable (owner-execute bit set)

So must the directory holding it: `~/.flock/hooks` (or `FLOCK_HOOKS_DIR`) has to be owned by that
same user and not group- or world-writable, because anyone who can write the directory can swap the
file out and the file's own bits would prove nothing. Only that one directory is checked, not every
ancestor — a world-writable `$HOME` is beyond what this guard can paper over.

A symlink at the hook path is a fine way to install one (`ln -s ~/bin/my-hook
~/.flock/hooks/board-create`), but then the link itself must be owned by you (the link decides what
runs) and the directory holding its target is checked too. A dangling symlink, or a directory at the
hook path, counts as "no hook installed" rather than an error.

If the file exists but fails any of those checks, flock refuses to run it and says so, rather than
silently ignoring it or running it anyway.

This is deliberately strict: `flock serve` binds to `0.0.0.0` (every interface) by default — see
[ADR 0015](../adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md) —
so the server is reachable from the LAN and Tailscale out of the box, not only when `--host` opts
into it, and flock has no authentication (see the README's Status section). A hook is a local
program the server executes on an HTTP request — the
ownership and permission guard is the only thing standing between "a local convenience" and "a
remote shell" once the API is reachable from anywhere on the network. The API stays CORS-open
(`Access-Control-Allow-Origin: *`) on purpose — the Vite dev server and reaching a checkout over
Tailscale both need it — so this alone would let any page open in a browser on this machine ask a
running flock to run the hook, with no custom header a plain HTML `<form>` POST can be made to
carry. `POST /api/boards/hook` (see the API section below) closes that off: it requires the request
header `x-flock-hook: 1`, which a plain cross-site form submission cannot set, and its absence is a
403 before the hook or anything else runs. That does not stop a page using `fetch`/`XHR` with the
header set — CORS staying open means the browser will still let it through — so install a hook whose
worst-case behaviour you are willing to hand to any web page you visit, and do not leave `flock`
serving on a shared network with one installed.

### API

`POST /api/boards/hook` requires the header `x-flock-hook: 1`; a request without it gets a 403
`{"error":"x-flock-hook header required","code":"hook_header_required"}` before the hook is even
looked up. The web app's "+" dialog always sends it. The header exists specifically to force the
request through `fetch`/`XHR` (which can set it) rather than a plain HTML form POST (which cannot),
since the API otherwise has no authentication and stays CORS-open for LAN/Tailscale use.

## Two modes

The hook is invoked as `<hook> describe` or `<hook> create`. Nothing else is on argv, so a `case`
on `$1` is the whole dispatch.

### `describe`

Runs every time the "+" dialog opens (not once at boot), with a 5-second budget — it blocks a
dialog from opening, so it needs to be fast. It has no input beyond identity (see below); no title,
no field values yet.

stdout, parsed as JSON:

```json
{
  "title": "New workspace",
  "submit": "Create workspace",
  "fields": [
    { "name": "repo", "label": "Repository", "type": "select", "options": ["flock", "other-repo"], "required": true },
    { "name": "branch", "label": "Branch", "type": "text", "placeholder": "login-flow", "required": true }
  ]
}
```

`title` and `submit` are optional and only relabel the dialog and its button. `fields` is the part
that matters: the dialog always shows a Title field first (flock needs one regardless), then
renders whatever `describe` declares underneath it.

If the hook has no `describe` support — non-zero exit, or empty output — that's not an error: the
dialog falls back to Title only, and `create` still runs with an empty `inputs` object. A hook that
only implements `create` is a valid, if less friendly, hook.

### `create`

Runs when the human submits the dialog. It receives the title, every field's value, and the
acting identity, and may hand back values that override the board about to be created.

**stdin** — one JSON object:

```json
{
  "event": "board-create",
  "version": 1,
  "actor": { "name": "user", "kind": "human" },
  "title": "Fix the login flow",
  "inputs": { "repo": "flock", "branch": "login-flow", "group": "flock", "prompt": "" },
  "dbPath": "/path/to/flock.db"
}
```

**env** — the same information, mirrored as environment variables, so a five-line bash hook needs
no JSON parser:

- `FLOCK_EVENT=board-create`
- `FLOCK_HOOK_VERSION=1`
- `FLOCK_TITLE`
- `FLOCK_ACTOR`, `FLOCK_ACTOR_KIND`
- `FLOCK_DB`
- one `FLOCK_INPUT_<KEY>` per declared field

The `FLOCK_INPUT_<KEY>` encoding: take the field's `name`, upper-case it, and turn every
non-alphanumeric character into `_` (so a field named `repo` becomes `FLOCK_INPUT_REPO`, and one
named `pr-number` becomes `FLOCK_INPUT_PR_NUMBER`). A checkbox field is `1` when checked, empty
string when not. Values are passed as an environment map, never interpolated into a shell string —
the hook still has to quote them, but it never has to worry about flock building a command line out
of user input.

**stdout — the contract that matters most.** Either nothing at all, or a JSON object as the *last
non-empty line* of stdout:

```json
{ "project": "/path/to/login-flow", "title": "login-flow", "body": "…", "slug": "…" }
```

- Every key is optional.
- `project`, if present, must be an absolute path to a directory that already exists. A hook that
  just created that directory needs to make sure it exists by the time it prints this line.
- Whatever the hook returns wins over the form's values — if the human typed a title and the hook
  also returns one, the hook's title is what the board gets.
- Unknown keys are ignored, not an error, so a future version of the contract can add fields
  without breaking an old hook.
- A hook can be chatty on stdout — log progress, echo `nb`'s own output — as long as the JSON
  object (if any) is the last non-empty line. Non-JSON stdout with exit 0 and no trailing JSON line
  is treated as "no output", not an error.

## Exit codes, timeouts, stderr

- **Exit 0** is success. Anything else aborts: no board is written. Flock's usual CLI exit-code
  convention (2 not-found, 3 conflict, …) does not apply here — a hook is binary, succeed or fail,
  which is one less thing for a hook author to get wrong.
- **Timeout**: `create` gets 60 seconds by default (a worktree add plus a dependency install can be
  slow), `describe` gets 5 seconds (it blocks a dialog opening). Override with
  `FLOCK_HOOK_TIMEOUT_MS`. A hook that runs past its budget is sent `SIGTERM`, then `SIGKILL` two
  seconds later, and is treated as a failure.
- **stderr** is always captured, tail-limited to the last 4 KB (then the last 20 lines within
  that). On success it only goes to the server log, so a hook is free to be chatty there too. On
  failure — non-zero exit, a timeout, or bad stdout — that tail is returned to the client and shown
  verbatim in the dialog, so the human can see exactly what went wrong and fix their input without
  digging through a server log.

Any of these — a non-zero exit, a timeout, unparseable/invalid stdout, or a `project` that isn't an
absolute existing directory — aborts the whole creation: nothing is written to the database. The
hook is responsible for cleaning up anything it already created (a worktree, a workspace); flock
never deletes something it did not make.

## Field schema

`describe`'s `fields` array is deliberately small: four types, no nesting, no conditionals, no
validation beyond `required`.

| type | renders as | web control |
|---|---|---|
| `text` | a single-line input | `.input`, `label`/`placeholder` shown as the field's placeholder text |
| `textarea` | a multi-line input | `.textarea`, same placeholder rule |
| `select` | a dropdown | a native `<select class="select">` — see below |
| `checkbox` | a checkbox | a plain checkbox with the label beside it |

`required` is enforced on `text`, `textarea` and `select` (the dialog keeps its submit button
disabled until each has a non-blank value); on a `checkbox` it is ignored, so it cannot be used to
force a human to tick a box. A `select` starts on its `default` when that is one of its options; a
required one with no usable default starts on its first option, and an optional one gets a blank
entry above the options so "none" stays reachable.

### The web dialog's controls

The "+" dialog uses one form grammar, the same one the New card sheet uses: a placeholder carries
the field's name, and no field sits under a separate label line. `field.placeholder` wins when a
hook sets one; otherwise the field's `label` is shown as the placeholder. This applies to `text` and
`textarea` directly (a plain HTML `placeholder` attribute); a `select` has no such attribute, so its
optional blank entry is given the field's placeholder/label as its own option text instead of
rendering empty, and the control's text dims to the same muted colour a placeholder uses while that
blank entry is selected. A `checkbox` keeps its label beside it, since there is nothing to place a
placeholder text into.

`select` renders through `.select` in `styles.css`, the token layer's own dropdown: `appearance:
none`, the same height as `.input` (a pointer's `--tap-desk` on desktop, a finger's `--tap` on the
phone), `--r-sm` radius, a `--line` border, a `--muted`-coloured chevron drawn with a CSS `mask` (so
it is a real token colour, not a baked-in hex), and a focus ring that matches `.input`'s. Nothing
about it is OS chrome — no native gradient, arrow or corner radius survives on either platform.

The dialog's title and submit button always read "New board" / "Create board", the same noun as the
trigger button that opens it (`AppTopBar`'s "New board" menu item). A hook's own `title`/`submit`
from `describe` still reach `flock hook describe` on the CLI, but the web dialog does not use them —
one object, one noun, wherever a human meets it (trigger, sheet title, submit button).

Each field is `{ name, label, type, required?, placeholder?, default?, options? }`. `options` (for
`select`) is an array whose entries are either a bare string or `{ value, label }` — use the bare
form when the value and its display text are the same, the object form when they should differ
(e.g. an empty value labeled "None"). There's no way to nest fields or make one field's presence
depend on another's value; a hook that needs more than this is a sign it wants a real settings
surface, not a bigger schema — ship two hooks and let the human choose, or ask for the schema to
grow deliberately.

## With no hook installed

The "+" button never disappears — a hook is an optional local convenience, not a requirement to
create a board at all. With nothing installed at `~/.flock/hooks/board-create` (or it fails the
permission check), the dialog is a Title field plus an optional "Project directory" text field, and
submitting it calls the hook-free board creation path directly (`POST /api/boards`, which is never
hooked). That path must be an absolute one — a relative path would be resolved against the
*server's* working directory, which is not something the person typing it can see, so it is refused
with a 400 and the message shown in the dialog. It does not have to exist yet; if it does, it is
canonicalized (symlinks resolved) so the board matches what `flock` finds when run from inside it.

## Testing a hook

Two CLI verbs exist to exercise a hook without going through the web dialog:

```sh
flock hook describe [--json]
```

Runs the `describe` mode of the currently installed `board-create` hook and prints what it
returned — the title, submit label, and fields — the same thing the dialog would render.

```sh
flock hook run [--title T] [--input k=v]... [--dry-run] [--json]
```

Runs the `create` mode with the given title and `--input` field values (repeatable), and prints the
result. With `--dry-run`, nothing is written to the database — it prints what would be passed to
board creation (the merged title/body/slug/project) so a hook author can check its output without
creating a real board. Without `--dry-run`, a successful run creates the board for real, the same
as submitting the dialog.

Both surface the same stderr tail described above, so a hook can be iterated on entirely from a
terminal before it's ever wired to the web app. Their own exit codes are flock's usual CLI ones:

| exit | means |
|---|---|
| 0 | the hook ran and (for `run`) the board was created |
| 1 | the hook failed: bad permissions, a non-zero exit, a timeout, or unparseable stdout |
| 2 | no hook is installed at all |
| 3 | the board conflicts with one that already exists for the same project directory |

A `describe` that fails or prints something that isn't JSON is not fatal to the dialog, which just
falls back to a plain title field; `flock hook describe` still reports it as a `warning` and exits 1,
because from a terminal that is the thing you asked about.

For `describe`, `--json` prints `{path, installed, unsafe, ok, exitCode, stderr, warning?, title?, submit?, fields}` when a hook ran; when none is installed or it failed the permission check the payload is only `{path, installed, unsafe, message?, fields:[]}`. For `run` it prints `{dryRun, ok, exitCode, stderr, output, merged}` on a dry run, `{dryRun, ok, exitCode, stderr, output, board}` on a real one, and `{dryRun, ok:false, exitCode, timedOut, stderr, error?}` when the hook failed.

## Example: nib workspaces

This one drives `nb` workspace creation — a real repo from a closed list, a
branch, and an optional group become the workspace's directory. It relies on two things confirmed
by hand against a real `nb` install, not guessed: `nb ws create` is synchronous (it doesn't return
until the workspace directory and its setup have finished), and the workspace lands at
`~/worktrees/<repo>/<branch-as-typed>` — the branch exactly as passed to `--branch`, not with the
repo's configured branch prefix applied (that prefix only affects the underlying git branch name,
not the directory). Because creation is synchronous, no polling is needed — one existence check
after the command returns is enough, kept only as a sanity guard in case that changes. A newer `nb`
may grow a way to print the path directly (a `--json` flag, say); if so, prefer that over
reconstructing the path from convention.

```bash
#!/usr/bin/env bash
# Create a nib workspace and hand flock its directory.
set -euo pipefail

case "${1:-create}" in
  describe)
    repos=$(nb repos --json | jq -c '[.[].name]')
    groups=$(nb group ls --json | jq -c '[{value:"",label:"(none)"}] + [.[] | select(.name != "Ungrouped") | {value: .name, label: .name}]')
    jq -nc --argjson repos "$repos" --argjson groups "$groups" '{
      title: "New workspace",
      submit: "Create workspace",
      fields: [
        { name: "repo",   label: "Repository", type: "select", options: $repos, required: true },
        { name: "branch", label: "Branch",     type: "text",   placeholder: "login-flow", required: true },
        { name: "group",  label: "Group",      type: "select", options: $groups },
        { name: "prompt", label: "Seed a Claude tab with", type: "textarea" }
      ]
    }'
    ;;

  create)
    repo="$FLOCK_INPUT_REPO"; branch="$FLOCK_INPUT_BRANCH"
    args=(ws create "$repo" --branch "$branch")
    [ -n "${FLOCK_INPUT_GROUP:-}" ] && args+=(--group "$FLOCK_INPUT_GROUP")
    nb "${args[@]}" >&2

    # nb ws create is synchronous: by the time it returns, the workspace directory
    # and its setup have already finished. The directory name is the branch as typed
    # (nb applies the repo's branch prefix only to the git branch, not the directory).
    # A newer nb may print the path directly (e.g. via --json) -- prefer that if available.
    dir="$HOME/worktrees/$repo/$branch"
    [ -d "$dir" ] || { echo "workspace directory not found at $dir (nb's naming rule may have changed)" >&2; exit 1; }

    [ -n "${FLOCK_INPUT_PROMPT:-}" ] && nb claude "$branch" "$FLOCK_INPUT_PROMPT" >&2

    jq -nc --arg p "$dir" --arg t "${FLOCK_TITLE:-$branch}" '{project: $p, title: $t}'
    ;;
esac
```

One caveat worth knowing: pass the bare branch name to `--branch`, not one that already includes the
repo's configured prefix (e.g. `feature/`) — nb applies that prefix itself to the underlying git
branch, and typing it yourself risks a doubled prefix on the git side even though the directory name
is unaffected.

## Example: plain git worktrees

No external tool at all — just `git worktree add` against a fixed set of repos under one root
directory.

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/repos"

case "${1:-create}" in
  describe)
    repos=$(cd "$ROOT" && ls -d */.git 2>/dev/null | cut -d/ -f1 | jq -Rsc 'split("\n") - [""]')
    jq -nc --argjson repos "$repos" '{
      title: "New worktree",
      fields: [
        { name: "repo",   label: "Repository", type: "select", options: $repos, required: true },
        { name: "branch", label: "Branch", type: "text", required: true },
        { name: "from",   label: "Base",       type: "text", default: "main" }
      ]
    }'
    ;;
  create)
    src="$ROOT/$FLOCK_INPUT_REPO"
    dir="$ROOT/worktrees/$FLOCK_INPUT_REPO/$FLOCK_INPUT_BRANCH"
    git -C "$src" fetch --quiet origin "${FLOCK_INPUT_FROM:-main}" >&2 || true
    git -C "$src" worktree add -b "$FLOCK_INPUT_BRANCH" "$dir" "${FLOCK_INPUT_FROM:-main}" >&2
    jq -nc --arg p "$dir" '{project: $p}'
    ;;
esac
```

See `docs/adr/0008-board-creation-hook.md` for the full design and its trade-offs.
