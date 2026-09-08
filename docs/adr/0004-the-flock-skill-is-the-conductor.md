# ADR 0004: The flock skill is the conductor, and it listens to the board

**Status:** accepted, 2026-09-05

## Context

Two skills overlapped. The maintainer's private `/orchestrate` skill turns a session into a long-running conductor that delegates all heavy work to model-routed subagents and keeps its state in markdown files in the scratchpad. This repo's `flock` skill was a model-invoked reference for the raw agent loop (orient, claim, comment, ask, done), which `flock handoff` already prints and which the README already documents.

An interim change pointed `/orchestrate` at the flock board for its state. That left the two skills tangled: the private skill depended on this repo, and the board was only written to, never read back when the maintainer changed it. The web UI let the maintainer add cards, record decisions, answer questions and post in the channel, but nothing in the running session noticed.

## Decision

- `/orchestrate` goes back to its markdown-on-disk version and stays a private, flock-free skill.
- `skills/flock` becomes the conductor for a flock-backed run: user-invoked (`/flock <goal>`), `disable-model-invocation: true`. It carries the conducting rules (delegate everything heavy, model routing, Workflow opt-in, follow-ups are delegations too) and adds the board as the state and the human channel.
- The skill no longer restates the agent verb loop. Subagents are told to run `flock handoff --as <name>` and follow it; the CLI is the single source of truth for onboarding text.
- The session listens to the board. The skill arms a persistent Monitor over `flock log --follow --json`, filtered to `actorKind == "human"`, so every write the human makes in the web UI or from the CLI as a human becomes a notification the conductor must act on in the same turn. The skill maps each event type to a response (a channel message is an instruction, a decision binds later delegations, an answered ask is re-delegated, a plan change means re-read and re-plan).
- Subagents never block on a human. An agent that needs the human runs `flock ask`, then `flock release`, and returns. The answer reaches the conductor through the listener, which delegates a fresh agent to the card.

## Consequences

- The skill costs no context when idle: user-invoked, it has no model-facing description. Projects that want flock without a conductor get the loop from `flock handoff` and the README.
- Human writes are visible to the run within the polling interval of `flock log --follow` (about half a second), with no new server, webhook, or daemon.
- The listener depends on `jq` and the `flock` binary being on PATH in the session's shell, and on Monitor notifications surviving the session. A resumed session re-arms it as part of orienting.
- `mentions`-style filtering (`flock log --wait --for NAME`) stays the tool for a single agent waiting on its own answer; the conductor's listener is broader and long-lived.
