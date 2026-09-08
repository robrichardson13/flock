# Installing flock

```sh
curl -fsSL https://raw.githubusercontent.com/robrichardson13/flock/main/scripts/install.sh | sh
```

That downloads a compiled `flock` binary for your platform, verifies it, installs it, writes the
Claude Code skill, and starts the daemon. No node, no npm, no bun, no git, no Docker, no sudo:
the binary is the entire dependency list.

This line only resolves for a **public** repo — `raw.githubusercontent.com` cannot serve a private
one. If the repo is private, download a release asset by hand instead (see Manual upgrade below).

## What it installs

1. `flock` at `$HOME/.flock/bin/flock` (override with `FLOCK_INSTALL_DIR`), moved into place with
   an atomic rename so an upgrade never leaves a half-written binary.
2. `~/.claude/skills/flock/SKILL.md`, written by `flock setup`, which the installer runs
   automatically as its last step (unless `FLOCK_NO_SETUP=1`). If that path is already a symlink
   — a contributor pointing it at a checkout with `scripts/setup.sh` (the default there) — `flock setup`
   leaves it alone and says so on stderr.
3. The daemon, started by that same `flock setup` call, serving the web app and the API at
   `http://127.0.0.1:4747`.

The installer prints the absolute path to the binary on stdout (so a sandboxed agent can run it
without a second round trip) and, if `$INSTALL_DIR` is not already on `PATH`, prints advice for
adding it on stderr.

A running flock daemon also serves this same script at `GET /install.sh`, so a machine that can
already reach a flock instance learns only one hostname.

## Supported platforms

Six prebuilt targets, matching `scripts/build-release.ts` and the release workflow:

- `darwin-arm64`, `darwin-x64`
- `linux-x64`, `linux-arm64`
- `linux-x64-musl`, `linux-arm64-musl` (Alpine and other musl-based images — an agent sandbox is
  the case that most needs a zero-dependency binary)

Windows is not built. The installer detects OS, architecture, and (on Linux) musl vs. glibc via
`ldd --version` and the presence of `/lib/ld-musl-*.so.1`, and fails with one line on stderr if
your platform isn't one of the six above.

## Environment overrides

| Variable | Default | What it does |
| --- | --- | --- |
| `FLOCK_VERSION` | latest release | Tag to install, e.g. `v2026.09.07.1`. |
| `FLOCK_INSTALL_DIR` | `$HOME/.flock/bin` | Destination directory for the binary. |
| `FLOCK_RELEASE_BASE` | GitHub Releases download URL for `FLOCK_VERSION` | Base URL the tarball and checksums are fetched from — override to install from a mirror or a local test server. |
| `FLOCK_NO_SETUP` | unset | Set to `1` to skip the automatic `flock setup` call after install (so you get just the binary). |

The installer verifies the download against the release's `SHA256SUMS` (or the per-asset
`.sha256`) before installing anything. A checksum mismatch is one line on stderr and a non-zero
exit; nothing is written.

## How updates work

An installed flock checks for a new release on its own, in a detached background process that
never adds latency to a command or changes its exit code:

- **Any CLI invocation** checks a stamp in `~/.flock/update.json`; if the last check was more than
  24 hours ago, it kicks off a check after the command's own output has already been printed.
- **The running daemon** checks 60 seconds after it starts (jittered up to 10 minutes so a fleet
  doesn't stampede GitHub at once) and every 6 hours after that.

An update runs the same embedded `install.sh` against the directory the running binary lives in,
then `flock setup --skill-only` to refresh the skill, then restarts any daemon that was running —
one line on stderr when something was actually upgraded, silent otherwise.

Three things turn auto-update off, any one of which is enough:

- Running from a checkout rather than an installed binary (a checkout upgrades with `git pull` and
  is never touched).
- `FLOCK_NO_UPDATE=1` in the environment.
- `{"autoupdate": false}` in `~/.flock/config.json` (see `docs/config.md`).

## Manual upgrade

```sh
flock upgrade [--version=v2026.09.07.1]
```

Runs the exact same install-and-restart path as an automatic update, on demand and ignoring the
guards above (asking for an upgrade by hand is not the same as one happening behind you — it still
refuses when run from a checkout). Both the automatic and the manual path log to
`~/.flock/logs/update.log`.

## Contributor checkouts

A checkout built from source (`scripts/setup.sh`, see the README's Contributing section) never
puts a dev build on `PATH` by default. Run the CLI from source as `bun run flock <verb>`; the only
global `flock` is the installed binary above.

`scripts/setup.sh --link` is the opt-in for a maintainer who wants a bare `flock` to be their
checkout's source. It writes a POSIX `sh` launcher over the install slot itself
(`$FLOCK_INSTALL_DIR`, else `$FLOCK_HOME/bin`, else `~/.flock/bin`) that runs the checkout's
`packages/cli/src/main.ts` under `bun`, in whatever directory you called it from. An installed
binary already there is set aside as `flock.bin.bak`; `--unlink` removes the launcher and puts it
back.

The launcher is marked with `# flock-dev-launcher: <checkout>` on line 2, and dev wins over prod:
this installer refuses to overwrite it, printing one line on stderr and exiting 0, and auto-update
does the same. `FLOCK_FORCE=1` installs over it anyway.

## Uninstall

```sh
rm -rf ~/.flock/bin/flock ~/.claude/skills/flock
```

That removes the binary and the skill. Add `rm -rf ~/.flock` to also drop the database, logs, and
every other piece of state flock keeps under its home directory (`FLOCK_HOME` if you set one) —
back up `~/.flock/flock.db` first if you want to keep your boards.
