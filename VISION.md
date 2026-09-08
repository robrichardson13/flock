# Flock — Vision

As of September 2026, Flock is a CLI for agents plus a web app for humans, not an HTTP-API-first
product: Bun + TypeScript for the CLI, Vite + React for the web app, one local SQLite file
underneath (`docs/adr/0001-sqlite-is-the-store.md`). The near-term job is long-form agent work
that outlives a single session (the `/flock` skill: a conductor session whose state is the board
and which listens to the board for the human's input, see `docs/adr/0004`) and serving as the
ticket tracker for the wayfinder / to-tickets skills. Where this document and `README.md` disagree, the README is
current — `README.md`'s Model section is the shipped design.

## Why this exists

Running one coding agent is a solved problem. Running five is not. Today the coordination layer
is a pile of tmux panes, a Slack thread, and whatever the human can hold in their head. Nobody
knows who's working on what, two agents grab the same task, a blocked agent sits silent for an
hour, and the human finds out when they happen to look.

[Workbench](https://workbench.md) proved the shape of the answer: a shared, live document that
agents and humans edit as equals, with attribution, an activity feed, and a claim-before-work
primitive. Flock takes that shape and runs it locally: the board is the product, SQLite is the
store, and it's yours to run.

## Who it's for

- A solo builder running several Claude Code, Codex, or Cursor sessions in parallel who wants to stop babysitting terminals.
- A small team inside a company that wants agents doing real work with a paper trail, without shipping their task state to a third party.
- Anyone building their own "operator" or "chief of staff" agent who needs a durable coordination substrate underneath it.

## What is not built yet

**Multi-user and self-hosting.** Auth, a reverse-proxy deployment with accounts, a Docker image, org boards shared by more than one person. Today flock is single-user, unauthenticated, and runs on one machine (`README.md` Status).

**Roles and share links.** Per-link capabilities (view, comment, suggest, edit) and a `?key=SECRET` onboarding link that hands an agent a scoped role. Today identity is just an unverified name (`--as` / `FLOCK_ACTOR`).

**The chief.** An optional role for one agent per human: first claim on incoming work, a running brief across all the human's boards, routing work to other agents.

**Asks and escalation.** An untargeted request that any agent can race to claim, with automatic escalation to the human if it goes unclaimed or stale. Today all work is claimed off the frontier or assigned directly; there is no untargeted-ask primitive.

**Agent registry.** A directory of agents with heartbeats and freshness, so the system knows which agents are alive. Today `flock actors` only shows who has ever touched the database.

**Suggestions and history.** Proposed changes with accept/reject, and version history with restore. Today a write just writes.

**Webhooks and an MCP server.** Today the only ways in are the CLI and the HTTP API the web app itself uses.

## Explicitly not building

- A general-purpose markdown editor or note-taking app. Obsidian and friends exist.
- A hosted SaaS with billing.
- An agent runtime. Flock never runs your agents, it coordinates the ones you run.
- A skills marketplace. Maybe later, not now.
- Project management for humans. If nobody on the board is an agent, use Linear.

## Open questions

- ~~One board per file, or a workspace with many boards and channels in a folder?~~ Answered by ADR 0001 and ADR 0002: one database file, many boards, each scoped to a project directory.
- How much of Workbench's HTTP API shape is worth keeping compatible, so their `mde` CLI and agents.md prompt could work against Flock with a base URL swap? Tempting for adoption, risky for design lock-in.
