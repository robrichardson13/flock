# ADR 0015: Bind to all interfaces by default and advertise only reachable URLs

**Status:** accepted, 2026-09-10

## Context

Issue #14: the installer and `flock up` print LAN (`http://10.x:4747`) and Tailscale
(`http://<host>.ts.net:4747`) addresses alongside the loopback one, but `flock serve` — and every
path that spawns it (`up` in binary and checkout mode, `setup`, the installer's start step) —
defaulted `--host` to `127.0.0.1`. Every printed URL except the loopback one was dead: nothing was
listening on the interfaces those addresses named. `docs/adr/0008-board-creation-hook.md` and
`docs/adr/0012-single-binary-distribution-and-a-daemon-instead-of-pm2.md` both documented the
`127.0.0.1` default at the time; this ADR changes it and supersedes those mentions.

## Decision

- The default bind host becomes `0.0.0.0` (every interface), everywhere a host is chosen:
  `flock serve`, `flock up` (binary child and checkout mode's `bun --watch … serve` plus vite),
  `flock setup` (which just calls `up`), and the installer (which just calls `setup`).
- Precedence, matching `FLOCK_PORT`'s pattern: an explicit `--host` flag wins, else `FLOCK_HOST` (new),
  else `0.0.0.0`. `resolveHost(host, env)` in `packages/cli/src/dev.ts` is the one place this is
  decided; `planDaemon`, `canonicalFallbackPlan` and `flock serve`'s own arg handling all call it
  instead of repeating the fallback chain.
- The printed URL list is now host-aware rather than always appending every LAN/Tailscale address.
  `advertisedUrls(host, port, interfaces)` in `dev.ts` is a pure function (unit-tested beside it in
  `dev.test.ts`) that decides, from the bound host alone:
  - **loopback** (`127.0.0.1`, `localhost`, `::1`): just `http://localhost:<port>`, plus one hint
    line, `to reach from other devices: flock up --host 0.0.0.0`.
  - **wildcard** (`0.0.0.0`, `::`, empty string): the loopback URL first (this is the line the
    `flock` skill and everything else treats as *the* base URL), then one `http://<addr>:<port>`
    per interface `networkHosts()` finds (LAN IPv4s, plus a Tailscale DNS name when `tailscale` is
    on `PATH`).
  - **any other specific host**: just `http://<host>:<port>` — the one address we actually know is
    bound; no LAN/Tailscale list, since binding a specific address does not imply those are
    reachable.
  `flock up`, `flock status` and `flock url` all call this through `daemon.ts`'s `urls()`/`describe()`,
  so the three surfaces agree.
- The vite dev server's bind now follows the same host: `planDaemon` passes `--host <resolved>` on
  the `bun x vite` child command line (it previously ran with no `--host`, relying solely on
  `vite.config.ts`'s hardcoded `host: true`). That config's `host: true` remains as the fallback for
  a bare `bun run dev` invoked without going through the CLI.
- The daemon runfile (`~/.flock/run/<name>.json`) already carried a `host` field
  (`RunInfo.host`, added for the daemon design in ADR 0012); it is now the thing `flock url` and
  `flock status` read to decide which branch of `advertisedUrls` applies, since those are separate
  process invocations from the one that bound the socket. A runfile written before this change has
  no reason to name a wildcard bind it never did: `parseRunInfo` keeps defaulting a missing `host`
  to `127.0.0.1`, the honest reading of what an old build actually bound, not the new default.
- `guardPorts` (the pre-flight "would this collide with something already listening" check) and
  `canonicalFallbackPlan`'s port-freedom probe now check loopback in addition to the wildcard
  address when the target host is `0.0.0.0`/`::`/empty. Binding `0.0.0.0:<port>` can silently
  succeed on top of an existing `127.0.0.1:<port>` listener (`SO_REUSEADDR` lets both sockets exist,
  observed on macOS), which would have made the guard report a port free right before the child
  crashed trying to bind it for real. Probing both catches the collision up front.

## Consequences

- **Security:** flock's HTTP API has no authentication (ADR 0008 made the same point about the old
  `127.0.0.1` default and CORS). Binding `0.0.0.0` by default means every board, card, comment,
  attachment and the board-create hook's execution path is now reachable by anything that can reach
  the machine — every device on the LAN, and every node on a Tailscale tailnet if one is configured,
  not just processes on the same host. This is a deliberate trade: it's what makes the printed LAN
  and Tailscale URLs actually work, which was the entire point of issue #14. Anyone who wants the
  old, closed posture opts back in with `flock up --host 127.0.0.1` (or `FLOCK_HOST=127.0.0.1` set
  persistently, e.g. in shell rc or `~/.flock/config.json`'s environment). A future ADR should
  revisit adding real auth before flock is run on a network with untrusted peers.
- `docs/adr/0008-board-creation-hook.md` and `docs/adr/0012-...-daemon-instead-of-pm2.md` both state
  the old `127.0.0.1` default; both get a superseded pointer to this ADR rather than being rewritten,
  per this repo's convention for superseded ADR content.
- `CLAUDE.md`, `docs/install.md`, `flock help`'s `serve`/`up`/`url` text and env var list, and any
  code comment naming `127.0.0.1` as the default, are updated to say `0.0.0.0` and mention
  `FLOCK_HOST`.
- `flock url --json` and `flock status --json` keep their existing shapes (an array of strings for
  `url`; the existing object fields for `status`); nothing was removed, only made host-aware.
