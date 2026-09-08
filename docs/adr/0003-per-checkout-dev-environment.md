# ADR 0003: One dev environment per checkout, under pm2

**Status:** accepted, 2026-09-05. **Superseded in part by [ADR 0012](0012-single-binary-distribution-and-a-daemon-instead-of-pm2.md):** the port scheme, worktree detection, canonical-port refusal and `--isolated` described below all survive verbatim. Everything here about pm2 — the two pm2 processes, `ecosystem.config.cjs`, `pm2 jlist`, `pm2 startup`/`pm2 save` — does not; `flock up`'s own pidfile-based daemon replaced it, and `flock dev <sub>` is now a deprecated alias over the top-level verbs. Read this ADR for the port and worktree design, and 0012 for how it's actually supervised today.

## Context

The maintainer works in git worktrees, one per effort, and runs several agents at once. Each worktree needs its own live API and web server so agents in different worktrees don't fight over a port or restart each other's process, but the canonical checkout still needs stable, memorable ports for daily use and for anything that hardcodes `localhost:5173`.

## Decision

- `flock dev up|down|restart|status|logs|url` (`start`/`stop` alias `up`/`down`) drives two pm2 processes per checkout, defined once in `ecosystem.config.cjs`: the API (`bun --watch ... serve`) and the Vite dev server.
- `flock dev` finds the checkout it's running in by walking up from the cwd to the nearest directory with `ecosystem.config.cjs` and a `packages/web`, then asks git whether that checkout is a linked worktree (`git rev-parse --git-dir --git-common-dir`; differing paths mean a worktree).
- The canonical checkout always gets the well-known ports, `:4747` (API) and `:5173` (web). A worktree gets a stable pair derived from its absolute path (`portOffset`: a simple string hash mod 100, giving `:48xx` and `:52xx`), so the same worktree gets the same ports across runs without a registry.
- pm2 process names are `flock-api`/`flock-web` for the canonical checkout and `flock-api@<dir>`/`flock-web@<dir>` for a worktree, where `<dir>` is the worktree's directory basename. This lets `pm2 jlist` show every checkout's processes side by side and lets `flock dev status` list them all.
- `flock dev` refuses to start a worktree on the canonical ports: if `--port`/`--web-port`/`FLOCK_PORT`/`FLOCK_WEB_PORT` would put a non-canonical checkout on `:4747` or `:5173`, it errors instead of starting. There is no override; drop the port flags to get the worktree's own ports.
- Every checkout shares `~/.flock/flock.db` by default. `flock dev up --isolated` gives the current checkout a private `.flock/flock.db` instead, which the CLI also picks up automatically when run from inside that directory (`resolveDbPath`'s walk-up).
- `up` is idempotent: it compares each expected process's running `FLOCK_PORT`/`FLOCK_WEB_PORT`/`FLOCK_DB` against what this invocation would start it with, and reports one of "already running" (all up to date), "started" (nothing was running), or "restarted with new settings" (only the processes whose env changed are deleted and restarted, e.g. toggling `--isolated`). This is what makes running `flock dev up` again after changing flags safe.
- `flock dev up` and `flock dev url` print the local URL plus every non-internal LAN IPv4 address and, if the `tailscale` binary is present and returns a DNS name, the Tailscale hostname, so a board can be opened from a phone on the same network or over Tailscale.

## Consequences

- Any number of worktrees plus the canonical checkout can run their dev environments at once without colliding, as long as none of them explicitly overrides its ports onto the canonical pair.
- The port a worktree gets is a hash of its path, not configurable except by explicit `--port`/`--web-port`. Deleting and re-creating a worktree at the same path reproduces the same ports; a differently-named worktree gets a different, unpredictable pair (visible via `flock dev status` or `flock dev url`).
- `flock dev` requires pm2 and fails loudly without it (a clear error, nothing starts). Worktree detection uses git; if `git` is unavailable or the probe fails, the checkout holding the CLI's own source is treated as canonical and any other path as a worktree, rather than falling back to "no worktree detected".
- Since `up` mutates already-running processes when settings drift, `flock dev up --isolated` and a later `flock dev up` (without `--isolated`) toggle a worktree between the shared and isolated database without a manual `flock dev down` in between.
