# ADR 0027: A card's run is the sessions that worked it

**Status:** accepted, 2026-09-13

**Amends:** ADR 0026 (harness telemetry) — §1's card→session link and §2's "a subagent reports
its parent's session" consequence.

## Context

ADR 0026 shipped the Run block: cost, context, duration, tool calls and liveness for the harness
sessions behind a card. On a conducted board it showed the wrong session on almost every card —
the conductor's, with the conductor's model and the conductor's context window, on cards a
different agent and a different model had done all the work on.

Two independent causes, both confirmed against the shared database and against real Claude Code
transcripts on this machine.

### Cause 1: every subagent write carried the conductor's run key

`detectRuntime` builds the run key from `CLAUDE_CODE_SESSION_ID`, and a subagent inherits the
parent's value verbatim — ADR 0026 §2 measured this and accepted it as "a true and useful
reading, just a coarse one".

In practice it is not coarse, it is wrong. Every session-bearing event on cards 99, 100, 103 and
104 of this project's own board — the conductor's `card.created` and each worker's
`card.claimed`, `comment.posted` and `card.closed` — carried the single key
`claude-code:ce8d433b-…`. One key is one group is one transcript, and that transcript is the
conductor's. Its dollars, its context fill and its model are what every card rendered.

What makes this fixable rather than inherent: **the subagent's own transcript exists and is
disjoint from the parent's.** Claude Code writes it to
`<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, every line carrying `agentId` and
`isSidechain: true`, with a sibling `.meta.json` naming the subagent's model. The parent
`.jsonl` contains zero sidechain lines. `packages/harness` has resolved
`claude-code:<sid>#<agentId>` to exactly that file since ADR 0026 —
`subagentTranscriptPath`, `normalizeAgentId`, `RunRef.agentId`, `parseRunKey`. The reader was
always ready. Only the *detection* was missing, and ADR 0026 concluded detection was impossible
because there is no per-agent environment variable.

There is no environment variable, but there is a better signal. Claude Code flushes the
`tool_use` line carrying a Bash command to the subagent's own transcript **before** running that
command. Verified live: a nonce echoed from inside a subagent was already on disk, in exactly
one file, before the very next command ran. A process that knows its own argv can therefore find
the one subagent transcript whose tail contains it, and that file's name is its agent id.

### Cause 2: the link rule counted any event, not just work

`sessionGroupsForCard` grouped *every* event carrying a session, and took the actor and declared
model from `MAX(seq)`. So a session that only ran `card new`, `comment`, `ask`, or closed
someone else's Land card was a "run" of that card — and when the conductor happened to write
last, its name and its absent model won the group. This is the half of the bug that survives
even if every key were perfect, because the conductor genuinely does write on cards it never
works.

## Decision

**A card's run is the set of harness sessions that *worked* it, and working a card means
claiming it.**

1. **Workers.** A card's workers are the distinct actors of its `card.claimed` events, plus its
   current assignee. Creating a card, commenting on it, reacting to it, asking about it, or
   closing someone else's Land card makes you none of those things.
2. **Linking.** A session links to a card only through events it wrote *as one of that card's
   workers*. A card nobody has worked has no run — the Run block is empty, not populated with
   whoever filed it.
3. **Also-worked.** `alsoWorked` lists the other cards a session *claimed*, not every card it
   ever wrote a line on.
4. **Per-subagent run keys.** A write from inside a Claude Code subagent carries
   `claude-code:<sid>#<agentId>`, resolved at write time by finding the subagent transcript whose
   tail contains this process's own command. A conductor's own write keeps the bare key. The two
   are then different runs of the same Claude Code session, which is exactly what they are.

Detection is best effort and degrades to the bare key: an unreadable directory, an unfamiliar
layout, an ambiguous match, or a harness that stops flushing before exec all leave the key as it
shipped in ADR 0026. It is a strict improvement or a no-op, never a regression.

The rule lives in core (`cardWorkers` and `sessionGroupsForCard` in `telemetry-queries.ts`); the
detection lives in `packages/harness` (`claude-code-self.ts`), which already owns every fact
about Claude Code's on-disk layout, and is called once per write from `resolveActor`. The CLI,
the server and the web Run block each follow without changing: all three read
`sessionsForCard`.

## Consequences

- **The Run block shows the worker, its model and its context** — the subagent's own transcript,
  not the conductor's. `flock telemetry` and the actor page follow the same rule.
- **Cards the conductor merely filed show no run at all.** That is the honest answer: nobody has
  run them.
- **Historical events cannot be repaired, and this is the one unavoidable gap.** Their key is
  bare and, worse, *shared across many cards*, so a per-card repair could not be cached under it
  without corrupting every other card's reading. Old cards keep the parent session's numbers,
  but re-reading them now shows the right actor and the right declared model, and conductor-only
  cards go empty. Every write after this change is right from the first one. No migration, and
  no schema change.
- **A card claimed by a human shows no harness run**, because a human's writes carry no session.
  Unchanged, and still correct.
- **A re-claim by a second agent adds a worker rather than replacing one**, so a card handed
  between agents shows both runs. The worker set is capped at 32.
- **Self-identification costs a bounded directory listing plus a few 64 KiB tail reads per write**,
  and only when a `subagents/` directory exists for this session. It is synchronous because
  `resolveActor` is.
- **Still no hooks** (d10). ADR 0026 noted `SubagentStop` as the only source of an agent id; it
  was never needed. Still no polling, and no new process.
- **The probe is coupled to a private Claude Code layout** — the same coupling `packages/harness`
  already carries for transcript paths, liveness and the model catalogue, and with the same
  failure mode: it returns nothing and the older behaviour stands.
