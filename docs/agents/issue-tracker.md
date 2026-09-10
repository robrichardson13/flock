# Issue tracker: flock

Issues, specs, and wayfinder maps for this repo live on a **flock board**. Use the `flock` CLI for all operations and add `--json` when you need to parse the result. Run `flock help` for the full verb list.

If `flock` is not on PATH here, install it: see the flock repo's `docs/install.md`, or ask whoever set up this repo's tracker. Working from a flock checkout instead? Every command below is `bun run flock ...`. Boards live in `~/.flock/flock.db` by default.

## Operations

- **Create an issue**: `flock card new "<title>" --body-file - --label ready-for-agent --blocked-by 3,5 <<'EOF' ... EOF`
- **Read an issue with comments**: `flock card show <n> --json`
- **List issues**: `flock cards [--frontier] [--mine] [--assignee A] [--open] [--status S,S] [--label L] [--blocked] [--json]`
- **Comment**: `flock comment <n> "<text>"`
- **Apply / remove labels**: `flock card edit <n> --label L` / `--unlabel L`
- **Edit / reorder**: `flock card edit <n> --title T --position N`
- **Claim**: `flock claim <n> --as <name>`
- **Give it back**: `flock release <n>` if you claimed a card and cannot finish it
- **Close**: `flock done <n> --resolution "<text>"` (or `--wontfix`)
- **Show the board**: `flock board show --json` (brief, decisions, all cards, frontier)

## Conventions

- **A board is a project directory** (this checkout or worktree). Run `flock init` once in it; after that the board argument is optional for every command run inside the directory, and the examples here omit it. Find another board's slug with `flock boards`, then name it to act on it.
- **A card is a ticket.** Its number `#n` is its identity on that board.
- **Triage state and ticket type are labels**: `ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human`, and `wayfinder:<research|prototype|grilling|task>`. `wontfix` is a card *status* (set by `flock done --wontfix`), not a label — applying it as a label does not close the card or remove it from the frontier.
- **Assignee is the claim.** An open card with no assignee is unclaimed. A non-zero exit from `flock claim` means another agent has it, or it is blocked, held, or closed; `flock claim <n> --force` claims past a blocker but never past a hold.
- **Blocking is native.** `--blocked-by n,m` on create, or `flock block <n> --by <m>` later. A card is blocked while any blocker is open.
- **A held card is off-limits.** A human parks a card with `flock hold <n> [--reason]`; it keeps its status but `flock claim` exits 3 until someone runs `flock unhold <n>` — `--force` does not lift a hold. Held cards are excluded from `flock cards --frontier` and from `needs-me`, so check `flock card show <n> --json` (the `held` field) before assuming a card you found some other way is actually takeable, and never try to route around a hold.

## When a skill says "publish to the issue tracker"

Create one card per ticket on this directory's board, blockers first so the `--blocked-by` numbers exist. If `flock cards` reports no board for the directory, run `flock init "<effort>" --body-file spec.md` first.

## When a skill says "fetch the relevant ticket"

`flock card show <n> --json`. The user will normally pass the card number.

## Wayfinding

Used by `/wayfinder`. The **map** is this directory's board; its **tickets** are the board's cards. Chart a new map in a fresh worktree so it gets its own board.

- **Map**: `flock init "<effort>" --body-file map.md` (or `flock board edit --body-file map.md` if the board exists). The board body holds `## Destination`, `## Notes`, `## Fog of war`, `## Out of scope`. Decisions-so-far is *not* in the body: it is the board's decision list (`flock decisions`), rendered into the export automatically.
- **Child ticket**: `flock card new "<title>" --label wayfinder:<type> --body "## Question\n..."`.
- **Resolve**: `flock done <n> --resolution "<answer>"`, then `flock decide "<one-line gist>" --card <n>` to append the context pointer to Decisions-so-far.
- **Rule out of scope**: `flock done <n> --wontfix --resolution "<why>"` and edit the board body's Out of scope section (`flock board edit --body-file map.md`).
- **Ask the human** (HITL tickets when the human is not in the session): `flock ask <n> "<question>"`, then `flock log --wait --for <me> --timeout 600000` to block until the answer arrives or ten minutes pass. `--wait`'s default timeout is 30 seconds and a timeout exits 0 with no output, indistinguishable from "nothing yet" — always pass `--timeout` for anything you actually want to wait on.
