# ADR 0020: Reap orphaned dev children instead of refusing around them

**Status:** accepted, 2026-09-11

## Context

ADR 0012 supervises a daemon with nothing but a runfile, and a checkout's dev environment has two
children: `bun --watch … serve` (the API) and vite. The runfile's liveness is the API pid alone, and
a runfile whose pid is gone is pruned on read. Vite's pid is recorded in the runfile but never
checked on its own.

So when the API dies and vite doesn't, the runfile disappears and vite keeps running with nothing
pointing at it. It happened twice in one morning. A worktree bumped the shared database's schema,
so the canonical checkout's API exited on open ("supports schema v5, but the database is stamped
v6"). `up` had already spawned vite, waited 30 seconds for a runfile that never came, timed out, and
left vite on :5173. The next `up` saw :5173 held "elsewhere", fell back to :4838/:5238, and did the
same thing again. After that the checkout was stuck: `flock down` found no runfile and stopped
nothing, `flock up` found :5238 taken "by another process (not a flock daemon)" and refused, and the
web app stayed up with no API behind it. The only fix was `lsof` and `kill` by hand.

The "refuse rather than kill" rule (ADR 0012, `guardPorts`) is right for a port held by a different
daemon or by something that isn't flock. It's wrong for a port held by this checkout's own child,
which `up` itself spawned.

## Decision

- **`up` cleans up after a failed start.** The readiness wait also watches the API child: if it
  exits before writing its runfile, `up` fails at once instead of waiting out the 30-second timeout.
  On that failure or on a timeout, `up` stops every child it spawned, vite included, before it
  errors. The error message quotes the log lines this start appended (error lines first, vite's
  proxy noise dropped) and names the log file.
- **A stray is a dev child of this checkout that no runfile owns.** It has to meet all three
  conditions (`findStrays` in `packages/cli/src/procs.ts`, run over `ps -axo pid=,ppid=,command=`):
  - its command runs this checkout's `packages/cli/src/main.ts serve` or its
    `node_modules/.bin/vite`, matched as the absolute path `up` spawns, so another checkout, or a
    worktree whose path merely contains this one's, never matches;
  - its parent is pid 1. `up` spawns detached and exits, so a daemon child is always reparented.
    A `bun x vite` or `flock serve` someone runs by hand still has a live parent and is left alone;
  - its pid is not the `pid` or `webPid` of any live runfile.
- **`up`, `restart` and `down` reap this checkout's strays** (SIGTERM, then SIGKILL after the
  usual grace period). `up`/`restart` do it before planning, so a stray on :5173 neither blocks the
  start nor pushes the canonical checkout onto its fallback ports. They print one stderr line
  naming what was stopped. `down` includes the strays in its `stopped …` line, and in `--json` as
  `strays: [pid…]`.
- **`status` reports strays and never stops them.** It lists them under "Not tracked by any
  runfile", and `--json` carries `strays: [{pid, kind, port}]`.
- **Half a dev environment is not "already running".** If a checkout daemon's API is alive but its
  `webPid` is gone, `up` restarts it (action `restarted`) instead of reporting "already running".

## Consequences

- The morning's state heals itself. A bare `flock up` or `flock down` in the checkout gets it out,
  with no `lsof`.
- Only checkout mode reaps. An installed binary has a single child, so when that child dies nothing
  is left behind.
- The pid-1 test works where orphans are reparented to init: macOS, and Linux without a subreaper.
  Under a `systemd --user` subreaper an orphan's parent isn't 1, so it isn't recognized. There
  `up`'s own cleanup on a failed start still prevents the common case, and anything else falls
  back to the old refusal. The rule chooses to miss a stray rather than kill a process it can't
  attribute.
- A platform without `ps` skips stray detection with one stderr line. Everything else works as
  before.
