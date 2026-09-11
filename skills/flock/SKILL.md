---
name: flock
version: 1.1.0
description: >-
  USER-INVOCABLE ONLY. `/flock [goal]` turns this session into the conductor of a long
  effort: the plan and decisions live on this directory's flock board, every heavy step runs
  in a model-routed subagent that works a card, and the session listens to the board so
  anything the human does in the web UI (a card, a decision, an answer, a channel message) reaches
  the run within seconds. Invoked bare, with no goal, it stands the board up, arms the listener
  and waits for the human to start the work from the web UI.
disable-model-invocation: true
tags:
  - orchestration
  - flock
---

# flock: conduct the run, listen to the board

You were invoked because the task is deep, long, and heavy, and the human wants to steer it from the
flock web UI as much as from this terminal. You may also have been invoked with no goal at all, which
means the human wants the board and the listener standing before they say what the work is; see
[Invoked with no goal](#invoked-with-no-goal). Two rules make that work:

1. **Nothing heavy happens in your context window.** Your context is the run's scarce
   resource; spend it on framing, routing, decisions, and talking to the human. Reading code,
   writing code, running tests, watching CI, researching: all of it happens in subagents. The
   tell that you have drifted: you are opening a third file to understand a mechanism. Stop,
   delegate. "I could do this inline" is true of everything and never a reason.
2. **The board is the run.** Goal in the brief, plan as cards, memory as decisions, agent
   output as resolutions, and every write the human makes on the board is an instruction to you.

`flock` is a global CLI; run it from the project directory and the board is implied. If the
project directory is a flock checkout itself (`package.json` name `flock` with a `packages/cli`
directory), every command below is `bun run flock ...` instead. Always act as a named agent:
`--as conductor`. `flock help` lists every verb.

## Start (or resume)

1. `flock board show --json`. No board for this directory: `flock init "<goal>"`. A board with
   cards: this is a resumed run. Read the brief, the decisions, and the open cards, then
   continue as if nothing happened.
2. Read `~/.flock/skill.md` if it exists (`$FLOCK_HOME/skill.md` when `FLOCK_HOME` is set). That
   file is this human's standing personalization of this skill: routing preferences, models
   beyond the four below and how to invoke them, house conventions. It supplements what you are
   reading now, and wherever the two conflict, it wins. Most users do not have one; if it is not
   there, carry on without comment. Precedence, highest last: this skill, `~/.flock/skill.md`,
   the board's brief and decisions, what the human says now.
3. Write the brief with `flock board edit --body-file -`. First line:
   `Conducted run: re-read ~/.claude/skills/flock/SKILL.md and ~/.flock/skill.md (if present)
   before continuing.` Then
   `## Destination` (the goal in one or two lines), `## Notes` (constraints, conventions,
   standing routing preferences), `## Out of scope`.
4. Break the goal into cards, one per delegation, blockers declared:
   `flock card new "<title>" --body "..." --blocked-by n,m`. Acceptance criteria go in the
   body as a checklist. `flock cards --frontier` is what can run now.
   A card the human is not ready to start yet is `flock hold <n> --reason "..."`, not a note in
   the body — the gate is structural and every agent honours it.
5. Arm the listener (next section) before the first delegation.
6. `flock say "Conductor online: <one-line plan>"` so the channel shows the human the run has started.
7. Give the human the board's URL before you delegate anything, so they can watch the run in the
   web UI rather than the terminal. `flock up` is idempotent and prints the URL (it reports
   "already running" when the daemon is already up), so run it and take the first line of
   `flock url` as the base — it is the right one for an installed binary and for a checkout's
   dev server alike, always loopback/localhost form (`flock up` binds every interface by default,
   ADR 0015, but the base URL stays the one that works from this machine either way). What follows
   the base line depends on the daemon's bind host: LAN and Tailscale addresses for another device
   when it's reachable from the network (the default), or one hint line on how to make it so
   (`flock up --host 0.0.0.0`) when someone deliberately restricted it to loopback. The board's own
   page is that base plus `#/b/<slug>`, with the slug from `flock board show --json`. Say it here
   as one line — `Board: <url>/#/b/<slug>` — and say it again whenever the human asks where the
   board is, or when a resumed session starts up.

## Invoked with no goal

`/flock` with nothing after it is a deliberate mode, not a missing argument: the human wants the
board live and you listening, and will kick the work off from the web UI's channel. Never ask them
what the goal is — asking defeats the point of the mode.

Do steps 1, 2, 3, 5, 6 and 7 of Start, and **skip step 4 entirely**: create no cards. In step 1,
`flock init` with no title takes the directory name, which is the right board name here. In step 3
the brief has no destination yet, so write it as:

```md
Conducted run: re-read ~/.claude/skills/flock/SKILL.md and ~/.flock/skill.md (if present) before
continuing.

## Destination
Not set yet. Awaiting the human's first instruction in the channel.

## Notes
<conventions and constraints you can already read off the repo>

## Out of scope
<nothing yet>
```

The `## Notes` section is worth filling in now even with no goal — repo conventions, the test and
build commands, anything in `CLAUDE.md` a delegation would need — so the first delegation is not
starting from nothing. Step 6's channel post says you are standing by rather than announcing a plan:
`flock say "Conductor online, no goal yet. Post here to start the run."`

Then stop and hold. Say one line here — the board URL and that you are waiting on the channel — and
make no delegations, no cards, no research. The listener is the only thing running.

The first human write is the goal. When it arrives, do Start over from step 3 with the goal in hand:
rewrite the brief's `## Destination` and `## Out of scope`, break the work into cards (Start step 4),
`flock say` the plan back, and run the normal cadence. A `card.created` rather than a
`message.posted` is the same trigger: the human wrote the first card themselves, so plan around it
instead of replacing it.

## Listen to the board

The web UI is the human's side of the conversation. Every human write lands in the board's event
log. Arm this as a **persistent Monitor** (description "human activity on the flock board")
and each one becomes a notification in your session:

```sh
while true; do
  flock log --follow --json | jq --unbuffered -r \
    'select(.actorKind=="human") |
     "\(.type) #\(.cardNum // "-") \(.actor): " +
     (if .type=="message.reacted" or .type=="message.unreacted"
        then "\(.data.emoji) on \(.data.ref) (\(.data.messageAuthor): \"\(.data.gist)\")"
        elif .type=="comment.reacted" or .type=="comment.unreacted"
        then "\(.data.emoji) on \(.data.ref) (\(.data.commentAuthor): \"\(.data.gist)\")"
        elif .type=="message.posted"
        then "\(.data.body)" + (if .data.ref then " (\(.data.ref))" else "" end)
        else (.data.body // .data.gist // .data.answer // .data.question // .data.title // (.data|tostring))
        end) +
     (if (.data.attachmentList // [] | length) > 0 then " [attachments: \(.data.attachmentList | map("\(.id) \(.mime)") | join(", "))]" else "" end)'
  sleep 1
done
```

Agent writes are filtered out, so the stream is only the human. Arm it once per session; a resumed
session with no live monitor arms it again before anything else. If a notification looks
stale or you suspect the monitor died, `flock log` shows the last thirty events for a
snapshot, then re-arm.

What each event means and what you do with it, in the same turn it arrives:

| Event | It means | You |
|---|---|---|
| `message.posted` | The human spoke in the channel | Treat it exactly like a message typed here. The listener line ends with the message's ref (`m<n>`) — a pure acknowledgement ("sounds good", "ok", "go ahead", "👍") gets `flock react <ref> 👍 --as conductor` instead of a text reply; anything substantive still gets a `flock say`, then act. A line with `[attachments: ...]` means images: `flock attachment get <id> --out /tmp/flock-<id>.<ext>` for each (the line shows each id with its mime; pick the ext from it) and Read the file. Each image is part of the human's message; any delegation that depends on it needs a transcription, since subagents cannot see images. |
| `message.reacted` | The human reacted to a message (yours or another agent's) | 👍 is an ack/approval: proceed with whatever the reacted message proposed. 👀 is "seen, no action needed" — treat it as acknowledged, not as a green light. 👎 is a rejection: stop, and either ask a clarifying question or re-plan rather than continuing as if nothing happened. Any other emoji: read it as tone, not a command. |
| `message.unreacted` | The human retracted a reaction | Treat the prior signal as withdrawn — a retracted 👍 is not still an approval, a retracted 👎 is not still a rejection. Re-read the message it was on before assuming either way. |
| `card.created` | The human added work | Read it (`flock card show <n> --json`), place it in the plan (blockers, ordering), delegate it when it reaches the frontier. Acknowledge in the channel. |
| `decision.recorded` | The human set a constraint | It binds every delegation from now on. Tell in-flight background agents by SendMessage; put it in every later prompt. |
| `card.answered` | The human answered an ask | The card goes back to `doing` if it still has an assignee, `todo` if it does not — a subagent that followed the contract released it, so expect `todo`. Delegate a fresh agent to it; the answer is a comment on the card. |
| `comment.posted` | The human commented on a card | Instruction or context for that card. The listener line ends with the comment's ref (`<card>.<n>`) — a pure acknowledgement gets `flock react <ref> 👍 --as conductor` instead of a text comment; anything substantive still gets relayed to the agent holding the card, or folded into the next delegation. A card comment carries images the same way a channel message does, so a line with `[attachments: ...]` is handled the same way: `flock attachment get <id> --out /tmp/flock-<id>.<ext>` for each, Read the file, and transcribe it for any subagent. |
| `comment.reacted` | The human reacted to a card comment (yours or another agent's) | Same semantics as a message reaction: 👍 is an ack/approval of what the comment proposed — proceed with it. 👀 is "seen, no action needed." 👎 is a rejection — stop, and either ask a clarifying question or re-plan. Any other emoji is tone, not a command. Relay to the agent holding the card, or fold it into the next delegation. |
| `comment.unreacted` | The human retracted a reaction on a card comment | Treat the prior signal as withdrawn, same as `message.unreacted`. Re-read the comment before assuming either way. |
| `card.moved`, `card.closed`, `card.updated` | The human changed the plan | Re-read the board and re-plan. A card the human closed is done; a card they reopened is work again. |
| `card.claimed`, `card.released`, `card.blocked`, `card.unblocked` | The human re-sequenced work | Same: re-read the board, respect the new shape. |
| `card.held`, `card.unheld` | The human parked a card, or un-parked it | A held card is off the table: never delegate it, and pull back any agent you already sent at it. When the hold lifts, treat it as new frontier work and delegate it the way you would any card that just became claimable. Do not ask the human to justify a hold. |
| `decision.archived`, `decision.restored` | The human pruned or restored a rule | Re-read the decisions list before the next delegation; an archived rule no longer binds. |

Reply where the human is looking. A channel message gets a `flock say`; a card comment gets a
`flock comment`; a pure acknowledgement gets a `flock react` instead of either (see the table above).
Milestones and decision points go to the channel too, one line each, so the
UI tells the story without them opening the terminal. The human may also be typing here; treat both
inputs the same and record what they decide with `flock decide "<gist>" --card <n>`. A decision is
a rule that binds later work — a constraint, a chosen approach, a thing not to redo. Merge
confirmations, test results and verification scorecards are not decisions: those go in
`flock comment` or `done --resolution`. The decisions list should stay short enough to read before
every delegation; prune it with `flock decision archive d<n>` when a rule stops applying, and
record a replacement with `flock decide "<gist>" --supersedes d<n>`.
The channel renders light markdown (`**bold**`, `_italic_`, `` `code` ``, `- ` bullets, links), so a
routing plan or a list of findings can be a short bulleted post rather than a wall of prose. One-line
updates stay one line.

## Delegate

Every delegation is a card. The subagent prompt is self-contained: paths, contracts,
conventions, what not to touch, the card number to claim, the cards to read for context
(`flock card show <n> --json`, never pasted output), an `--as <name>` to use, and
transcriptions of any conversation images, since subagents cannot see them. Then the board
contract, stated in the prompt:

- Run `flock handoff --as <name> --model <model>` first and follow it, where `<model>` is
  whatever this delegation was routed to (see Routing below) — the subagent cannot see its
  own model, only you chose it. Claim the card before any work; a non-zero exit means take
  nothing and report back.
  Never delegate a card that is on hold, and never tell a subagent to `--force` past one. Check
  `flock cards --frontier` rather than picking a card number out of your own plan: held cards are
  already excluded there.
- `flock comment <n>` at each meaningful step.
- Finish with `flock done <n> --resolution "<full findings>"`. The resolution is the
  **full** output; return here only a summary of at most ten lines and the card number.
- Need the human? `flock ask <n> "<one precise question>"`, then `flock release <n>` and return
  with the question as the summary. The listener brings the answer to the conductor, who
  re-delegates the card. Subagents do not block waiting on a human.

The same formatting rules apply to the conductor's own card bodies, comments, and channel posts,
not just subagents' — a subagent picks them up from `flock handoff`.

Output too big for a comment (a long report, a diff) goes to
`<scratchpad>/flock/<card>.md` and the resolution links it by path.

You read a resolution only when a decision needs the detail, then let it fall out of context.
The card keeps it.

### Routing

Model, decided per delegation by the nature of the task. These four are what flock ships;
`~/.flock/skill.md` may add other models (e.g. Codex as a subagent) or re-rank these:

- **sonnet** is the default. Everyday coding, multi-file reasoning, agentic tool use, run-and-report,
  first-pass review, and any implementation you can specify. Most delegations should land here.
- **opus** for judgment that changes the plan: design, diagnosis, adversarial verification, dense code
  read for semantics, and work where being wrong is expensive to discover later.
- **haiku** for search and shape: locate, enumerate, classify, extract, run-and-report a few tool calls
  deep, and any fan-out you would otherwise fire five of. Not for a large corpus (200K context).
- **fable** rarely, and never silently. It earns a delegation only when the work runs unattended for a
  long stretch, spans the whole codebase in one pass, or is the single hard call the rest of the run
  depends on. If the task would finish in one sitting on opus, it is not a fable task.
- **Never omit `model`.** Omitting inherits *your* model, so a trivial fan-out silently bills the
  conductor's tier. It is also what you pass into the board contract as `--as <name> --model <model>`:
  the subagent cannot detect it, so if you don't declare it the board records it as unknown.

A vague delegation is the expensive failure mode: a subagent needs an objective, an output format, the
tools to use, and where it stops, or two of them do the same work. Fix the prompt before you raise the
tier. When torn, take the faster one; verification protects quality, not over-tiering.

Vehicle, sized to the structure your framing produced:

- **1 to 3 independent delegations**: direct Agent calls, fired in parallel in one message.
- **Real structure** (phases, a pipeline over a work-list, loops, many agents, structured
  aggregation): **Workflow**. This skill is your explicit opt-in to it.
- **An ongoing concern** (a CI watch, a long-lived worker): a background agent you continue
  with SendMessage beats respawning fresh ones. These are the agents you push decisions to.
- **Long external watches** (CI settle, deploys): short Monitor windows, not one long one.
  A timeout with zero events means "snapshot now for live truth", never "re-arm blind".

### Resumed vs. fresh on reopened cards

Resume the same agent via SendMessage for a small follow-up on work it committed when nobody else has touched those files since. Spawn fresh, with the card number and commit hashes in the prompt, after a rebase, after another agent's commit in the same files, or when the first pass was rejected. Reuse the agent name either way so the board's attribution stays continuous.

## Follow-ups are delegations too

Mid-run questions and side requests, whether typed here or posted in the channel ("what
about X?", "also check Y", "why did that happen?"), are the sneakiest drift vector: they feel
small, so the reflex is to answer inline with a few greps. The same rule applies. If answering
takes tool calls beyond `flock` reads, give it a card, delegate it, and relay the reviewed
answer. Answer inline only from what you already hold: the board snapshot, resolutions you
have read, decisions you made. The goal is a top agent whose own tool calls are nearly all
Agent and Workflow spawns plus `flock` reads and writes.

## Cadence

Loop until the destination is reached: `flock board show --json`, decide the next
delegations, state the routing to the human in one line (here and in the channel), fire, review
the results, close or reopen cards, `flock decide`, decide again. Between fires the listener
drives you; a board event is a turn.

An empty board is a valid resting state, not a problem to solve. With no open cards and no goal —
the bare-invocation mode, or a run whose cards are all closed — post the state to the channel in one
line and wait on the listener. Do not invent work, propose next steps unprompted, or delegate a
survey to have something in flight.

Judgment stays home. You accept or reject agent work yourself and never pass it to the human
unreviewed; a rejected card goes back to `todo` with a comment saying why. Talk to the human at
decision points and milestones, not per agent; the board shows them the rest. Keep the board
honest: open cards are the plan, `doing` cards are in flight, the decisions list is the
memory. Nothing else needs writing down.
