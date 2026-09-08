# ADR 0012: One compiled binary, one installer, one daemon — and no pm2

**Status:** accepted, 2026-09-07

## Context

Today the only way to get flock is to clone the repo: `scripts/setup.sh` needs bun, runs `bun install`, `bun link`s a global `flock` that points at that checkout, installs pm2 globally, symlinks `skills/flock` into `~/.claude/skills`, and starts two pm2 processes. That is a reasonable contributor setup and a bad product. A user who wants a board has to become a contributor first; an agent in a sandbox cannot install it at all; a fix on `main` reaches nobody until someone runs `git pull`.

What we want instead: one command installs everything, the CLI is the only thing anyone runs, the CLI starts a daemon serving the web app and the API, agents use the same CLI, the Claude Code skill arrives with the CLI, and a push to `main` reaches every install with no user action. Local development in the canonical checkout and in worktrees has to keep working, including the per-checkout ports of ADR 0003.

A sibling worktree (`feature/hosting`) already explored most of this for a hosted deployment and is being archived. Its web-app changes are stale against `main`, but its build, install and runtime machinery works and is worth taking almost verbatim: `scripts/gen-assets.ts`, `scripts/build-release.ts`, `scripts/install.sh`, `packages/cli/src/runtime.ts`, `packages/cli/src/upgrade.ts`, and the `release` and `install-test` workflows.

Two facts were verified against this checkout rather than assumed. Bun 1.3.4 compiles `packages/cli/src/main.ts` with the current `packages/web/dist` embedded — every file imported with `with { type: "file" }` is carried into the binary and readable through `Bun.file` at runtime. Bun appends its own hash to each embedded name and flattens the tree (`assets/index-DjIgrgNt.js` becomes `/$bunfs/root/index-DjIgrgNt-043nxx43.js`), so the mapping from request path to embedded path cannot be reconstructed by convention and must be generated at build time. The resulting binary is ~60 MB, of which ~400 KB is the web app; the rest is the Bun runtime. `Bun.isStandaloneExecutable` does not exist on 1.3.4 and reads `undefined` both in and out of a binary, so "am I a compiled binary" is detected from `import.meta.dir` starting with `/$bunfs`.

## Decision

### One binary, with the web app inside it

`bun build --compile` over `packages/cli/src/main.ts` produces a single self-contained executable. It carries the Bun runtime, `bun:sqlite`, core, the server, the built web app, `scripts/install.sh` and `skills/flock/SKILL.md`. There is no node, no npm, no bun and no clone on the user's machine.

`scripts/gen-assets.ts` walks `packages/web/dist` after `vite build` and writes `packages/cli/src/assets.generated.ts`: one `import … with { type: "file" }` per file plus an `ASSETS` map from request path (`/index.html`, `/assets/index-<hash>.js`) to embedded path. It is build output, gitignored, and never imported statically — `runtime.ts` loads it through a `try`/`catch`ed dynamic import, so a plain checkout with no web build still runs. A committed `assets.generated.d.ts` is what the rest of the CLI type-checks against.

`serve` gains an `assets` option alongside the existing `staticDir` and prefers it when present. In a binary the map is the only source; in a checkout `packages/web/dist` on disk still works, so `bun run flock serve` is unchanged.

`SKILL.md` and `install.sh` are committed, so they embed with a plain static import and need no generated manifest.

### Install

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/flock/main/scripts/install.sh | sh
```

POSIX `sh`, not bash: an agent sandbox is often an Alpine container with no bash. The script detects OS, architecture and libc (`ldd --version | grep -qi musl`, falling back to the presence of `/lib/ld-musl-*.so.1`), downloads `flock-bun-<os>-<arch>[-musl].tar.gz` from the GitHub release, verifies it against `SHA256SUMS` (or the per-asset `.sha256`), extracts it, and moves it into `$HOME/.flock/bin/flock` through a temp name in the same directory so the swap is atomic. No sudo, ever: the install directory sits beside the database flock already owns. It then smoke-tests `flock --version`, prints the absolute path on stdout so a sandboxed agent can run it without a second round trip, and prints PATH advice on stderr. `FLOCK_VERSION`, `FLOCK_INSTALL_DIR` and `FLOCK_RELEASE_BASE` override the three things worth overriding; the last is how the installer is tested against a local HTTP server.

The asset naming scheme is a contract shared by `scripts/build-release.ts`, `scripts/install.sh` and the release workflow. Changing it means changing all three.

Finally the installer runs `"$INSTALL_DIR/flock" setup` unless `FLOCK_NO_SETUP=1`. That is what makes one command install everything rather than just a binary.

The running daemon also serves the same embedded script at `GET /install.sh`, so an agent that can reach a flock instance can install the matching CLI from it and only ever learns one hostname.

### `flock setup`

`flock setup` does the two things an install still needs and nothing else:

- Writes `~/.claude/skills/flock/SKILL.md` from the embedded copy — a **real file**, written to a temp name and renamed, not a symlink. It records the version it wrote in `~/.flock/skill.json`. If the destination is already a symlink it leaves it alone and says so on stderr: that is a contributor pointing the skill at a checkout, and silently replacing it with a release copy would be a genuinely confusing thing to do.
- Starts the daemon (`flock up`), unless `--no-start`.

`--skill-only` does the first without the second; it is what the update path calls.

Claude Code is the only harness we install into. There is no npx-published skill package and no plugin marketplace entry: the CLI already carries the file, and a second distribution channel would only add version skew between the skill and the CLI it documents.

### Daemon lifecycle, without pm2 — and without any other runtime dependency

**An installed user installs exactly one thing: the flock binary.** No Docker, no container runtime, no node, no npm, no bun, no pm2, no git. The binary spawns and supervises its own daemon: a detached child process, a pidfile and a log file under `~/.flock`, and signals. Anything that would require a user to install a second runtime before flock works is out of bounds by decision, not by preference. The hosting worktree ran flock in a container behind a platform's process supervisor; that model is the right one for a hosted instance and the wrong one here, so we borrow its build, install and runtime code and none of its Docker or platform-deploy setup.

The lifecycle verbs move to the top level and lose their supervisor:

```
flock up [--port N] [--host H] [--isolated] [--foreground] [--open]
flock down [--all]
flock restart
flock status            # every daemon on this machine
flock logs [-f] [-n N]
flock url
```

`flock serve` stays exactly as it is: the foreground primitive that `up` spawns. `flock dev <sub>` becomes an alias for the top-level verb with one deprecation line on stderr, so existing muscle memory and docs keep working through one release. (Superseded: the alias was dropped outright rather than kept as a deprecation shim — see card 18 / commit `aa21e93`. `flock dev` is no longer recognized; there is no transition period.)

What `up` starts depends on where it runs, and nothing else:

- **From an installed binary** it spawns one detached child — itself, `serve`ing the embedded web app and the API on the same port (`:4747` by default, `FLOCK_PORT`/`--port` to move it, `127.0.0.1` unless `--host` says otherwise).
- **From a checkout** (`bun run flock up`, detected by `isStandalone()` being false) it starts the dev environment instead: `bun --watch … serve` on the API port and `bun x vite --strictPort` on the web port, with the ports, the canonical/worktree distinction, the refusal to serve `:4747`/`:5173` from a worktree, and `--isolated` all exactly as ADR 0003 defines them. Only the supervisor changes; the port scheme does not.

Supervision is a pidfile, not a process manager. Each daemon writes `~/.flock/run/<name>.json` (`{pid, mode, apiPort, webPort, root, db, version, startedAt, url}`) **itself, once it is listening**, which makes the runfile a readiness signal rather than a race: `up` spawns the child, polls for the runfile with a timeout, then prints the URL. `<name>` is the runfile namespace: `flock` for an installed daemon, `dev` for the canonical checkout, `dev@<dir>` for a worktree (`<dir>` its directory basename, the per-checkout naming ADR 0003 gave pm2). An installed daemon and a checkout's dev environment are two different things, so they get two different names and can run side by side; `flock status` reads the directory and lists them all the way `pm2 jlist` used to. Liveness is `process.kill(pid, 0)`; a runfile whose pid is gone is pruned on read. `down` signals `SIGTERM`, waits, then `SIGKILL`. Logs are appended to `~/.flock/logs/<name>.log` and `flock logs` tails that file. Children are spawned with stdio pointed at the log, `nohup` semantics so a closing terminal does not take them down, and `unref()` so `up` can exit.

`up` stays idempotent in the sense ADR 0003 gave it: it compares the running daemon's recorded settings against what this invocation would start, and reports "already running", "started", or "restarted with new settings". It restarts only *its own* runfile's daemon: if a port it wants is held by a different runfile, or by a process that is not flock at all, it prints one line and exits 1 rather than killing anything.

pm2 and `ecosystem.config.cjs` are deleted. `scripts/setup.sh` shrinks to what a contributor actually needs — `bun install` and a hint to run `bun run flock up` — and stops installing pm2. (Superseded on the `scripts/setup.sh` skill symlink and `bun link`: it now symlinks the skill by default and never `bun link`s anything. `--link` instead writes a marked `sh` launcher over the installer's own slot — `~/.flock/bin/flock` — which the installer and auto-update both refuse to overwrite, so a dev checkout wins over a release without any PATH ordering. See cards 18 and 20.)

### Auto-update

The goal is that a push to `main` reaches every install with no user action, without ever making a command slower or a board unavailable.

State lives in `~/.flock/update.json` (`{lastCheck, lastSeen, channel}`). The check itself is one unauthenticated `GET https://api.github.com/repos/<owner>/flock/releases/latest` and compares the tag against the compiled-in version.

- **Every CLI invocation**, after the command has finished and its output is written, checks the stamp. If the last check is older than 24 h it spawns a detached `flock self-update --if-newer` and exits immediately. The command's latency and exit code are never affected.
- **The daemon** checks 60 s after start (jittered by up to 10 minutes so a fleet does not stampede GitHub) and every 6 h after that.

An update is not a bespoke self-replace. It runs the embedded `install.sh` with `FLOCK_INSTALL_DIR` set to the directory the running binary lives in — the same script, the same platform detection, the same checksum verification, the same atomic `mv`. Replacing a running executable is safe on macOS and Linux: `mv` unlinks and renames, and the running process keeps its old inode. The updater then calls `flock setup --skill-only` to refresh `~/.claude/skills/flock/SKILL.md`, and, if a daemon is running, restarts it by spawning the new binary's `up` and letting the old process exit. One line on stderr when something was actually upgraded; complete silence otherwise. `flock upgrade [--version vX.Y.Z]` is the same code path run deliberately.

Only one updater at a time: `~/.flock/update.lock` is created `O_EXCL` with the pid and a timestamp, and is considered stale after 10 minutes.

Auto-update never runs when `isStandalone()` is false — a checkout upgrades with `git pull`, and overwriting a contributor's linked CLI with a release would be worse than useless. It also never runs with `FLOCK_NO_UPDATE=1` set, or with `autoupdate: false` in `~/.flock/config.json`.

### Versioning and CI

CI cuts the tag; nobody bumps a version by hand. On every push to `main`, a workflow computes `v<YYYY>.<MM>.<DD>.<n>` — CalVer with a same-day counter derived from the tags already on that date — creates the tag, and runs the existing release job against it. The tag-triggered path stays too, so a `v*` tag pushed by hand still cuts a release, and `workflow_dispatch` can rebuild one.

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, plus `linux-x64-musl` and `linux-arm64-musl`. The two musl builds are not padding: the installer already detects musl, and an agent sandbox on Alpine is the case that most needs a zero-dependency binary. Windows is not built; `bun-windows-x64` is a target Bun supports and we can add later, but nothing here has been tested on it.

Each build uploads `flock-bun-<target>.tar.gz` and `<asset>.sha256`; a final job concatenates them into `SHA256SUMS` and creates the release with generated notes. A second workflow guards the installer: a hermetic job on every push that serves a fake release over localhost and asserts the checksum, install-dir and failure behaviour, and a container matrix (Alpine/musl, Debian/glibc, Debian with only wget) that runs after a release is published and is the only real test of libc detection.

## Consequences

- A user runs one `curl … | sh` and has a CLI, a skill, and a board at `http://127.0.0.1:4747`. An agent in a sandbox runs the same line and gets the same CLI. Nobody needs bun, node, npm, pm2, git, Docker or any other runtime — the binary is the entire dependency list, and keeping it that way is a constraint on every future change to the install or daemon path.
- Six targets at ~60 MB each is roughly 360 MB per release, and a release lands on every push to `main`. GitHub does not charge for release storage, but the list will get long fast; a retention job that prunes releases older than a few months should follow.
- **Version skew becomes normal.** A daemon that auto-updated, a CLI in a long-lived sandbox that has not, and a `bun run flock` checkout all share `~/.flock/flock.db`. Schema migrations must therefore be additive and forward-compatible, and core needs a `schema_version` the CLI checks on open so a binary older than the database fails with one clear line instead of a corrupt read. That guard is a prerequisite, not a follow-up.

  **Implemented as card D:** the stamp lives in SQLite's own `PRAGMA user_version`, not a meta table — `packages/core/src/db.ts` already migrates by checking `PRAGMA table_info(...)` ad hoc rather than running a numbered migration list, and `user_version` is a single integer read/write with no schema of its own, so it fits that style without adding a table. `user_version` defaults to `0` on every SQLite file, which doubles as "never stamped": `openDatabase` treats `0` as "adopt" (run `SCHEMA` and `migrate()`, then stamp to `SCHEMA_VERSION`) rather than rejecting it, so every database that predates this guard opens normally. A database stamped **higher** than the binary's `SCHEMA_VERSION` throws `SchemaVersionError` (a `FlockError`) before `SCHEMA` or `migrate()` run — nothing is written — naming both versions and telling the user to upgrade flock. Because `Flock`'s constructor opens the database and both the CLI and `flock serve` construct `Flock` at startup before doing anything else, this surfaces through the CLI's existing `FlockError` handling with no separate hook: one line on stderr, exit 1. **Migrations must stay additive** — only add columns, tables, or indexes, never rename or drop — so a newer binary's database is always still readable by whatever `SCHEMA_VERSION` an older binary shipped with prior to the bump; that older binary still refuses to open it, but the guard is what makes the refusal safe rather than a corrupt read.
- The installer's one-liner points at `raw.githubusercontent.com/<owner>/flock/main/scripts/install.sh`, which only resolves for a public repo. Publishing the repo publicly is a precondition of this design; a private repo would need authenticated release-asset downloads and the one-liner would stop working.
- Auto-update means we ship whatever is on `main` to every user within a day. `main` has to stay green, and the release workflow should not run when the test suite fails.
- ADR 0003's port scheme, worktree detection, canonical-port refusal and `--isolated` all survive verbatim; only its "under pm2" half is superseded. This ADR supersedes that half.
- `scripts/gen-assets.ts` must run after every `vite build`, because Vite rehashes its output filenames each time. `bun run build` does both, and `build-release.ts` calls both in order.
- The skill installed by `flock setup` is a copy, so a contributor's live-editing workflow (`~/.claude/skills/flock` symlinked into a checkout) is a deliberate opt-out that `setup` detects and preserves rather than the default.

## Alternatives rejected

- **npm as the primary channel** (a shim package plus per-platform optional dependencies, which the hosting worktree also built). It needs node and npm on the machine, which is exactly the dependency the compiled binary removes, and it makes auto-update someone else's job. Worth keeping as a secondary channel later; not the front door.
- **A Homebrew tap.** A second manifest to keep in sync, macOS-first, and no path to zero-action auto-update.
- **A Docker image, or any containerised daemon** (the hosting worktree's `Dockerfile` and Railway deploy). Right for a hosted instance, wrong for a CLI that has to install a Claude Code skill into the user's home directory and serve a board on their laptop — and it makes a container runtime a prerequisite for running flock at all, which the "one binary, nothing else" rule forbids. None of that worktree's Docker or platform-deploy material is carried over.
- **Keeping pm2.** It is a node package the binary cannot ship, so it would remain a separate install step for every user and a second process model to reason about. A pidfile is a hundred lines and covers what we use pm2 for.
- **Serving `packages/web/dist` off disk from the binary.** There is no dist on disk; `import.meta.dir` resolves into `/$bunfs`, where the relative path points at nothing.
- **Inlining the whole web app into one HTML string** (`vite-plugin-singlefile`). Loses per-asset caching, the icons and the web manifest, and the generated map costs one small build script.
- **Distributing the skill through npx or a plugin marketplace.** Another channel, another version to keep aligned with the CLI, for a single markdown file the binary already carries.
- **A launchd/systemd unit for the daemon.** Platform-specific, needs its own install and uninstall path, and buys us restart-on-boot we have not been asked for. A pidfile and `flock up` are enough; a boot unit can be added later without changing this design.
- **Checking for updates on every invocation with no stamp file.** Adds a network round trip to every `flock claim` and would hit GitHub's 60-requests-per-hour unauthenticated limit under a fleet of agents.
- **Hand-cut semver tags.** Any human step in the release path defeats "zero user action". Commit-sha tags were also rejected: they do not sort, so "am I behind?" stops being a comparison.
