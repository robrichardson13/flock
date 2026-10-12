# ADR 0029: Agents are peer sessions that talk on the board

**Status:** accepted, 2026-10-12

**Amends:** ADR 0004 (the conductor delegates to subagents), ADR 0002 (one directory per board),
ADR 0027 (a card's run is found by heuristic for subagents).

## Context

Since ADR 0004 a flock run is one Claude Code session, the conductor, firing a subagent per card.
That shape has four costs the maintainer keeps paying:

- **A worker cannot be opened, watched or steered.** A subagent lives inside the conductor's
  session; the human sees its writes on the board and nothing else.
- **A card's session is a guess.** A subagent inherits the parent's `CLAUDE_CODE_SESSION_ID`, so
  ADR 0027 recovers its identity by searching subagent transcripts for this process's own argv.
  It works, but it is a heuristic over a private layout. A top-level session gets an exact key
  for free, and `claude --session-id <uuid>` lets the launcher mint it before the session starts.
- **A worktree is set up after the agent starts**, by the agent, so the card's run begins in the
  wrong directory and each hand-rolled worktree gets a board of its own (ADR 0002).
- **Agents only talk through the conductor.** Two workers whose cards touch cannot unblock each
  other; every exchange is a round trip through one context window.

Constraints: it must work with nothing but a headless `claude -p`; a user may mix Claude Code
with codex or opencode; and flock never names any particular IDE or launcher. Claude Code's own
peer messaging (the `messagingSocketPath` and `.key` in its session files) is private and is not
used.

## Decision

### 1. An agent is a top-level peer session

A flock **agent** is a top-level harness session working one card, started by `flock spawn`.
Subagents still exist, but only as helpers inside their worker: a subagent never claims a card,
comments, asks, or writes to the board in any way. The worker it serves does that. This retires
the ADR 0027 heuristic for new work (it stays as the fallback for runs that still use subagents
the old way) because every board write now comes from a session whose run key is exact.

`flock spawn <card> --as <name> --model <m> [--effort <e>] [--harness <h>] [--worktree]` records
an **agent** row (name, board, card, harness, session key, open URL, cwd, pid, status) and hands
the launch to a launcher. `flock team [--json]` lists the board's agents with their status and
unread inbox count.

### 2. Launchers are a contract; harness adapters are code

A **launcher** is anything that implements two operations, exchanged as JSON on stdin/stdout:

- `launch` — given the card, actor, harness, model, effort, cwd and prompt, start a session and
  return its session key, pid if it has one, and optionally an `openUrl` a human can follow to it.
- `deliver` (optional) — given a session key and a message, put the message in front of that
  session.

flock ships a **built-in launcher** made of one adapter per harness. Adapters are code, not
config, because a command template cannot express session-key minting or delivery:

| Harness | Launch | Deliver |
| --- | --- | --- |
| Claude Code | `claude -p --input-format stream-json` with a pre-minted `--session-id`, logs and pidfile under `FLOCK_HOME` | its supervisor writes the inbox into the session's stdin (§3) |
| codex | `codex exec --json` (thread id from `thread.started`) | `codex exec resume <thread> "<message>"` once the `exec` has exited |
| opencode | `opencode run --session <id>` against `opencode serve` | the session API |

The harness is inferred from the model (`gpt-*` is codex, `opencode:<provider>/<model>` is
opencode, everything else Claude Code); `--harness` overrides. Config adds only two things:
`harnesses.<name>.bin` to point at a binary, and `launcher` to name an **external launcher**
executable that implements the same contract. An external launcher is how a richer environment
(an IDE that opens sessions as tabs, say) takes over spawning without flock knowing it exists.
An `openUrl` with a non-`http(s)` scheme is only rendered for loopback clients.

The built-in Claude Code adapter runs `bypassPermissions` by default, since a spawned worker has
no one to answer its prompts; config can select `acceptEdits` plus an allow-list instead.

### 3. Agents talk on the board, in the open

Every agent-to-agent message is a channel message or a card comment. There are no direct
messages: the human sees everything the team says.

- **Mentions are parsed in core.** `@name` and `@all` in a message or comment body are a parsed
  field, not a substring search over event JSON. `flock say --to <name>` is sugar for a leading
  mention. The web renders mentions as links, using the reference grammar of ADR 0028.
- **Every actor has an inbox:** `flock inbox --as <me> [--follow] [--json]` is the stream of
  events addressed to it — mentions of it or `@all`, others' comments on cards it holds, answers
  to its asks, and new decisions.
- **Delivery is push wherever flock can push.** A built-in Claude Code worker's supervisor owns
  its stream-json stdin and writes unread inbox into it as a user turn; a session mid-turn queues
  it. That is not Claude Code's private peer socket: flock started the process and owns the pipe.
  It replaced pull via Monitor, because Claude Code (from about 2.1.272) caps every Monitor at 30
  minutes, so a worker that forgot to re-arm went deaf. A Claude Code worker started by an
  external launcher still pulls, re-arming its Monitor on every expiry. For harnesses with a `deliver`, the server's push pump (under the ADR 0023 lease)
  forwards unread inbox items through the adapter or the external launcher. A harness with
  neither polls `flock inbox`.
- **Messages to a dead agent wait.** They stay unread in its inbox, and `flock team` shows the
  count, so whoever spawns the next worker for that card can point it there.
- **Etiquette is part of onboarding.** `flock handoff` tells agents to talk to another agent only
  to hand something off or to unblock it, and that subagents never write to the board.

### 4. A spawned worktree joins its parent's board

A board may be scoped to more than one directory. `flock spawn --worktree` creates the worktree
before the session starts, links its path to the spawning board, and unlinks it when the card
closes. A worktree made by hand still gets a board of its own, exactly as ADR 0002 says.

### 5. A worker's lifetime follows its card

A worker started by the built-in launcher exits once its card is closed or released and its
inbox has been quiet for ten minutes. Waking a finished worker on a new message is deferred; for
now a message to it waits in its inbox (§3).

### 6. The conductor spawns; it no longer delegates to subagents

`/flock` runs `flock spawn` per ready card instead of firing a subagent. Its listener widens from
human writes to also surface each spawned card's end-of-work events (closed, released, asked), so
the conductor learns when to spawn the next card without polling.

## Spike results (2026-10-12, Claude Code 2.x, codex-cli 0.159.0)

- **An idle headless Claude Code session wakes on a Monitor event.** A `claude -p --input-format
  stream-json` session (stdin a FIFO held open) armed a Monitor, ended its turn with a `result`,
  and when the watched command printed 45 seconds later it started a second turn by itself and
  ran the requested command. Pull delivery for Claude Code works as designed. A Monitor carries
  a timeout of at most 30 minutes, which is why built-in workers are pushed instead (§3).
- **`codex queue` does not reach a `codex exec` thread.** It accepts the message and exits 0,
  but the running `exec` finished its turn and exited without seeing it, and a later
  `codex exec resume` did not drain it either; queue only reaches threads owned by the shared
  app-server. **`codex exec resume <thread> "<message>"` does deliver:** it runs a new turn on
  the same thread. So the codex adapter's `deliver` resumes the thread once its `exec` process
  has exited, and leaves the message unread while it is still running; the worker checks
  `flock inbox` before it ends a turn, which covers that gap.

## Consequences

- **Workers are real sessions.** A human can open one (through an `openUrl`, or by resuming its
  session key), watch it and steer it, and its cost and context are its own.
- **Card ↔ session is exact for spawned work.** The run key is minted before launch and stored on
  the agent row, so the Run block (ADR 0026/0027) no longer depends on transcript archaeology.
- **One more table and a schema bump**, handled the ADR 0021 way: a worktree on this branch seeds
  a private database rather than stamping the shared one.
- **Spawned workers cost more than subagents.** Each loads its own system prompt and context.
  The conductor's context, which used to hold every subagent's result, stays small instead.
- **`bypassPermissions` is the default** for headless workers. That is a real loosening; the
  config escape hatch exists for anyone who does not want it.
- **flock still names no IDE.** Anything richer than `claude -p` arrives through the `launcher`
  key and lives in its own repository.
- **The old subagent loop keeps working.** An agent that is not spawned still claims, comments
  and closes the way `flock handoff` describes; it just does not appear in `flock team`.
