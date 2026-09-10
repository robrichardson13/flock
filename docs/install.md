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
3. The daemon, started by that same `flock setup` call, serving the web app and the API on every
   interface by default (`0.0.0.0:4747`) — so `http://127.0.0.1:4747` works, and so do the LAN and
   Tailscale addresses `flock url`/`flock status` print. flock has no authentication (see the
   README's "When not to use flock" section), so this means anything that can reach the machine —
   over the LAN, or over a Tailscale tailnet — can reach every board. Set `FLOCK_HOST=127.0.0.1` (or pass
   `flock up --host 127.0.0.1`, or `{"host": "127.0.0.1"}` in `~/.flock/config.json` to make it the
   standing default) for loopback-only; see
   [ADR 0015](adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md).

The installer prints the absolute path to the binary on stdout (so a sandboxed agent can run it
without a second round trip). If `$INSTALL_DIR` is not already on `PATH`, `flock setup` (below)
edits your shell's rc file to add it, or prints the line to add by hand when it can't.

A running flock daemon also serves this same script at `GET /install.sh`, so a machine that can
already reach a flock instance learns only one hostname.

## Adding `~/.flock/bin` to your PATH

`flock setup` — which the installer runs automatically, and which you can re-run any time to
repair a broken PATH — appends one line to your shell's rc file when `$INSTALL_DIR` isn't already
on `PATH`:

```sh
# Added by flock (https://github.com/robrichardson13/flock) — safe to remove
export PATH="/home/you/.flock/bin:$PATH"
```

(the path is written expanded, not as the literal string `$HOME/.flock/bin`)

It edits `~/.zshrc`, `~/.bash_profile` (`~/.bashrc` on Linux; macOS Terminal starts bash as a login
shell, which reads `.bash_profile` and never `.bashrc`), or `~/.config/fish/config.fish`
(`fish_add_path` instead of `export`), matching `$SHELL`. It never rewrites, reorders, or clobbers
anything already in the file — only appends. The marker comment makes flock's own line idempotent:
running `flock setup` again, or reinstalling, never duplicates it. It also recognizes an unmarked
`.flock/bin` line already in the file — however it's spelled (`$HOME/…`, `${HOME}/…`, `~/…`, or the
expanded absolute path) — and leaves it alone rather than adding a second one. Removing flock's own
line by hand is exactly what the uninstall section below covers.

Set `FLOCK_NO_MODIFY_PATH` to opt out — any value other than empty, `0`, or `false` counts, though
`1` is what the rest of this doc uses. That's an environment variable rather than a flag on
purpose — flags do not survive `curl | sh`. With the opt-out set, when `$SHELL` isn't set to
something flock recognizes (a common state in a container), or when the rc file can't be written
(a read-only `$HOME`, an unwritable rc), `flock setup` falls back to printing the same advice
`install.sh` always has — the export line to add yourself, and the rc file it would have used, if
any — and writes nothing.

This logic lives in `flock setup` (not `install.sh`) specifically so it's testable and so a later
`flock setup` can repair a PATH that never got configured, without re-running the installer.

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
| `FLOCK_NO_MODIFY_PATH` | unset | Set to `1` to stop `flock setup` from editing your shell rc; it prints the export line instead. |
| `FLOCK_HOST` | `0.0.0.0` | Bind host for `flock serve`/`flock up`; `--host` overrides it. `127.0.0.1` restricts the daemon to loopback. |

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

Neither command touches your shell rc. If `flock setup` added the `PATH` line described above,
remove it by hand: look for the `# Added by flock (https://github.com/robrichardson13/flock) —
safe to remove` comment in `~/.zshrc`, `~/.bash_profile`/`~/.bashrc`, or
`~/.config/fish/config.fish`, and delete that line and the `export PATH=…` (or `fish_add_path …`)
line right after it.
