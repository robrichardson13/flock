# flock

flock is an orchestration framework that puts the agent you talk to in the orchestrator's seat: it
delegates the work to subagents, and they coordinate through a shared board instead of through
each other. One SQLite file holds the board. Agents drive it through a CLI; you watch and steer
from a web app.

<table><tr>
<td valign="top"><img src="docs/screenshot-desktop.png" alt="A flock board on desktop: to-do/doing/needs-you columns, an awaiting-human question, team avatars, and channel chatter" width="520"></td>
<td valign="top"><img src="docs/screenshot-mobile.png" alt="The same flock board on a phone, showing the awaiting-human question" width="170"></td>
</tr></table>

Without a board, agents relay the plan to each other inside tool calls and replies, so the state
of the run lives only in whichever context window is holding it, and compaction, a context limit
or a finished session takes it away. flock writes it down instead: the goal, the cards, who
claimed what, what they decided. An agent that lost its context runs one command and is current
again.

## What using it looks like

Install once:

```sh
curl -fsSL https://raw.githubusercontent.com/robrichardson13/flock/main/scripts/install.sh | sh
```

Then, in a Claude Code session inside the project you want to work on, invoke the skill with a
goal:

```
/flock migrate the billing service off Stripe Checkout
```

That session becomes the orchestrator. It writes the goal as the board's brief, breaks the work
into cards, and hands each card to a subagent that claims it, works it, and closes it with a
resolution. Open the URL the installer printed and you can watch it happen, and change it: post a
channel message, comment on a card, reopen a closed one with a reason, record a decision. The run
follows the board's event stream and picks that up within seconds. When an agent needs you,
its card parks as `awaiting-human` with a question and an answer box.

You do not run CLI commands to use flock. The CLI is how agents reach the board.

## Install

The one-liner puts the `flock` binary in `~/.flock/bin`, writes the Claude Code skill to
`~/.claude/skills/flock`, starts the daemon, and prints the URL of the web app. No node, no bun,
no git, no sudo. If `~/.flock/bin` is not already on your `PATH`, the installer adds it to your
shell's rc file itself; set `FLOCK_NO_MODIFY_PATH=1` to opt out.

The daemon binds every network interface by default (not just loopback), so the web app and API
are reachable from your LAN and any Tailscale tailnet you're on, and flock has no authentication —
anything that can reach the machine can reach every board. Pass `--host 127.0.0.1` to `flock up`
(or set `FLOCK_HOST=127.0.0.1`, or `{"host": "127.0.0.1"}` in `~/.flock/config.json` to make it the
standing default) to keep it to this machine only. See
`docs/adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md`.

An installed flock checks for a new release in the background, at most once a day, and applies it.
`FLOCK_NO_UPDATE=1` or `{"autoupdate": false}` in `~/.flock/config.json` turns that off;
`flock upgrade` does it deliberately. See `docs/install.md` for platforms, env overrides, and
how to uninstall.

## The model

Five nouns carry the whole product.

- **Board**: one per project directory. A brief in markdown (destination, notes, fog of war, out
  of scope), a list of decisions, a channel, and cards. Decisions are never deleted, but an
  archived or superseded one drops out of the default listing, so the list stays the standing
  rules rather than a run log.
- **Card**: `#n` on its board. Status is `todo → doing → done | wontfix`, with `awaiting-human` as
  a side state. Has labels, an assignee, a body, comments, and *blocked by* edges to other cards.
  A card is *blocked* while any blocker is still open, and *on hold* while a human has parked it.
  A hold is a human gate: it makes the card unclaimable, it is orthogonal to blockers, and it
  never clears itself while the card stays open — `flock unhold` lifts it, and closing the card
  (`done` or `wontfix`) clears it too, emitting `card.unheld` before `card.closed`. A held card keeps its status and is left
  out of both the frontier and "Waiting on you".
- **Claim**: assigning yourself is a compare-and-swap. Two agents grab the same card, one wins,
  the other gets exit 3. The conflict is the lock; there is no scheduler and no queue service.
  A held card cannot be claimed at all, and `--force` (which claims past a blocker) does not
  override a hold — `flock hold N [--reason]` / `flock unhold N` set and lift it.
- **Frontier**: cards that are `todo`, unblocked, unheld, and unclaimed. What an agent may take next.
- **Events**: every write appends to a per-board log with a monotonic sequence. `flock log
  --follow`, the JSON long-poll, and the SSE stream all read it.

## What you do

Everything from the web app, live over SSE.

The Home screen's "Waiting on you" section lists every card that is `awaiting-human` across every
board, with the question and an answer box. Answering hands the card back to its assignee (not
necessarily whoever asked), returning it to `doing` if it has one and `todo` if it does not.

Inside a board: cards on desktop, a tabbed list on mobile, plus a channel, an activity feed and a
decisions tab. Add a card, comment on one, reopen a closed one with a reason, write in the
channel, record a decision, archive or restore one. Each of those is an event the agents read. The
board is the instruction channel, not the terminal you started in.

## What the agent does

You will not type any of this. It is here so you can judge what the agents are doing on your
behalf.

An agent arriving at a board runs `flock handoff`, which prints its onboarding text. From there
the loop is:

```sh
flock board show --json           # orient: brief, decisions, every card, the frontier
flock cards --frontier            # open, unblocked, unclaimed
flock claim 4 --as scout          # a non-zero exit means another agent has it, or it is blocked
flock comment 4 "progress…" --as scout
flock ask 4 "SQLite or Postgres?" --as scout     # parks the card as awaiting-human
flock log --wait --for scout --timeout 600000    # block until an event mentions scout
flock done 4 --resolution "Went with SQLite" --as scout
```

Identity comes from `--as NAME` or `FLOCK_ACTOR`. An agent can also declare what it is running
under with `--harness`, `--model` and `--effort`; harness and effort auto-detect inside Claude
Code, model never does. Most verbs take `--json`. `flock help` lists the full surface.

The skill that drives the orchestration is `skills/flock`, installed at `~/.claude/skills/flock`
and refreshed on upgrade (`docs/adr/0004-the-flock-skill-is-the-conductor.md`). Without the skill,
onboarding is `flock init` once and then `flock handoff`.

## Scope and storage

A board is scoped to a directory, normally a repo checkout or a git worktree, and `flock init`
creates it there. Every command run inside that directory or below it then resolves the board
automatically, so the board argument is optional in most verbs. Worktrees get their own boards, so
parallel efforts never share a card list. See `docs/adr/0002-one-board-per-project-directory.md`.

Everything lives in `~/.flock/flock.db`. `flock board export` renders a board as one markdown
document and `flock board import` reads one back as a new board. Markdown is the interchange
format; SQLite is the store (`docs/adr/0001-sqlite-is-the-store.md`).

## When not to use flock

- One agent doing one bounded task. A board is overhead you will not get back.
- Work that has to be visible to people who are not at this machine. flock is single-user, with
  no auth and no sync between machines — though `flock up` binds every network interface by
  default, so anything on your LAN or Tailscale tailnet can reach it too; pass `--host 127.0.0.1`
  (or set `FLOCK_HOST`) to keep it to this machine only. See
  `docs/adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md`.
- A team that wants a real issue tracker. flock tracks a run in progress, not a backlog, and has
  no permissions and nothing that pings you outside the open tab. (One project's agents can still
  point at it as their tracker: `docs/agents/issue-tracker.md`.)

## Docs

- `docs/install.md` — platforms, env overrides, updates, uninstall
- `docs/config.md` — `~/.flock/config.json`
- `docs/hooks/board-create.md` — the hook the web app's "+" runs to create a directory for a new board
- `docs/agents/issue-tracker.md` — using flock as a project's issue tracker
- `docs/adr/` — every decision and why
- `VISION.md` — where this is going

## Contributing

```sh
git clone https://github.com/robrichardson13/flock.git && cd flock
scripts/setup.sh                   # bun install, symlink the skill
scripts/setup.sh --link            # optional: type `flock` instead of `bun run flock`
bun test && bun run typecheck
bun run flock up                   # dev environment on this checkout's ports
```

A checkout puts no dev build on `PATH`; run the CLI from source as `bun run flock <verb>`.
`--link` is the deliberate opt-in: it points the global `flock` at this checkout, so dev wins over
prod with no PATH ordering involved, and `--unlink` restores whatever binary was there. The
canonical checkout serves `:4747` and `:5173`; a worktree gets its own stable pair derived from
its path. `CLAUDE.md` has the install-slot mechanics and `docs/adr/` has the reasoning.

## License

MIT, see [LICENSE](LICENSE).
