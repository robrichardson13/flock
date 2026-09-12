# `~/.flock/config.json`

Optional. flock works with no config file at all; this is only for turning something off.

```json
{
  "autoupdate": false,
  "host": "127.0.0.1",
  "tailscale": true
}
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `autoupdate` | boolean | `true` | `false` stops an installed flock from updating itself. |
| `host` | string | `0.0.0.0` | The bind host `flock serve`/`flock up` fall back to when there is no `--host` flag and no `FLOCK_HOST`. Precedence, highest first: `--host`, `FLOCK_HOST`, this key, then the built-in `0.0.0.0` default. Set it to `127.0.0.1` to keep every future `flock up` on this machine to loopback without having to pass `--host` (or export `FLOCK_HOST`) every time. See [ADR 0015](adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md). |
| `tailscale` | boolean | `false` | `true` makes every future `flock up`/`restart` on this machine front the browser-facing port with `tailscale serve`, for an HTTPS origin on the tailnet, without having to pass `--tailscale` every time. Precedence, highest first: `--tailscale`/`--no-tailscale`, `FLOCK_TAILSCALE`, this key, then off. A bare `up`/`restart` keeps a running daemon's own choice rather than recomputing it, same as `host`. See [ADR 0019](adr/0019-tailscale-serve-for-an-https-origin.md) and "HTTPS on the tailnet" below. |

Unknown keys are ignored, and a file that is missing or not valid JSON is treated as an empty
object — a broken config never stops a command from running.

The file lives under `FLOCK_HOME` when that is set, alongside `flock.db`, `update.json`,
`skill.json`, `run/` and `logs/`.

## Auto-update

An installed flock checks for a new release at most once a day, in a detached process that starts
after your command has already printed its output. See
[ADR 0012](adr/0012-single-binary-distribution-and-a-daemon-instead-of-pm2.md). Three things stop
it, any one of which is enough:

- Running from a checkout rather than an installed binary. A checkout upgrades with `git pull`.
- `FLOCK_NO_UPDATE=1` in the environment — the right switch for CI and for a container image.
- `{"autoupdate": false}` here — the right switch for a machine you want to pin.

`flock upgrade` ignores all three except the first: asking for an upgrade by hand is not the same
as one happening behind you. It writes what it did to `~/.flock/logs/update.log`, which is also
where the automatic checks leave their trail.

## HTTPS on the tailnet

See [ADR 0019](adr/0019-tailscale-serve-for-an-https-origin.md) for the full design. `flock up
--tailscale` (or the `tailscale` config key / `FLOCK_TAILSCALE` above) makes the daemon establish a
`tailscale serve` mount for its browser-facing port — vite's web port in a checkout, the one server
port in an installed binary — so the app is reachable at `https://<machine>.<tailnet>.ts.net`, with
a real certificate, from every device on the tailnet. `flock down` tears the mount down; `flock
up`/`restart` re-assert it every time, since tailscaled's own state (a `tailscale down`, a reboot, a
manual `tailscale serve reset`) can remove it independently of flock.

This needs two things enabled on the tailnet, both in the [admin
console](https://login.tailscale.com/admin/dns): MagicDNS (for the node's `<machine>.<tailnet>.ts.net`
name) and HTTPS certificates. Without either, `--tailscale` refuses with a one-line error naming
what to enable — it never starts an HTTP-only daemon with a warning instead (ADR 0017's Web Push and
the iOS home-screen install path both need a secure origin, so a silent HTTP fallback would look
healthy while quietly lacking the one capability it was started for).

Once a mount is active, `flock url`, `flock status`, and the `up`/`serve` banners lead with the
https URL; `flock status` also adds a `tls` line naming what it proxies to. `--open` (on `up` and on
`serve`) always opens the loopback address on this machine, never the tailnet one — the browser tab
it opens is local, so it does not need the tailnet round-trip.

| Env var | Default | What it does |
| --- | --- | --- |
| `FLOCK_TAILSCALE` | unset | Same as `--tailscale`/`--no-tailscale`, for `up`/`restart`/`serve` without passing the flag. `0`/`false`/`no` (any case), or empty, are treated as an explicit *off*; any other non-empty value is *on*. Precedence: `--tailscale`/`--no-tailscale`, this var, the `tailscale` config key, then off. |
| `FLOCK_TAILSCALE_BIN` | unset | Path to the `tailscale` binary, for an install `flock` cannot otherwise find (e.g. the macOS App Store build, which ships no CLI on `PATH` — only `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). Trusted as given: a path that does not resolve fails at the first `tailscale` call with a clear error, rather than falling back silently. |

A machine with no Tailscale installed, and no `--tailscale`/`FLOCK_TAILSCALE`/config key set, is
unaffected: nothing in flock looks for the binary or runs a subprocess on that path. The pre-existing
`*.ts.net` hint in `flock url`/`status` (from `tailscale status --self --json`, used only to name a
possible LAN/tailnet address) keeps degrading silently when the binary is missing or the node is
logged out; only an explicit `--tailscale` request errors, and it errors in one line.

## Web Push notifications

See [ADR 0017](adr/0017-web-push-notifications.md) and
[docs/notifications-contract.md](notifications-contract.md) for the full design. The server
generates a VAPID key pair on first use and writes it to `~/.flock/vapid.json` (mode 0600,
`FLOCK_HOME`-aware like everything else here) — not to `config.json`, since it is a secret rather
than a setting.

| Env var | Default | What it does |
| --- | --- | --- |
| `FLOCK_VAPID_PUBLIC_KEY` + `FLOCK_VAPID_PRIVATE_KEY` | none | Set both to skip `vapid.json` entirely and use these keys instead. For a deploy with no durable disk, where a generated file would be lost — and every subscription silently invalidated — on each redeploy. |
| `FLOCK_VAPID_SUBJECT` | `https://github.com/robrichardson13/flock` | The VAPID JWT's contact subject. Must be an `https:` URL or a `mailto:` URI that resolves for real — APNs rejects a placeholder like `mailto:flock@localhost` with 403 `BadJwtToken`. |
| `FLOCK_NO_PUSH` | unset | `1` turns off the push pump and VAPID key generation entirely; `GET /api/push/key` then reports `{ enabled: false }`. |

**Which notifications you get is not configured here.** ADR 0024's four switches — needs me,
review requested, everything else, quiet check-in — plus the check-in threshold are per person,
not per machine, so they live in the database rather than in `config.json`, with an optional
override per board. Set them in the app's notifications sheet, or from the CLI:

```sh
flock notify settings                    # what is in force here, and what is inherited
flock notify set --everything on         # every channel line buzzes again
flock notify set --settled on --threshold 30m
flock notify set my-board --review off   # just this board
```

There is no server-wide default to set: an actor with no row gets needs-me and review on,
everything else and the check-in off, and a 20-minute threshold. See
[ADR 0024](adr/0024-notification-levels.md) and
[docs/notifications-contract.md](notifications-contract.md) §5.

## Harness telemetry

See [ADR 0026](adr/0026-harness-telemetry.md) and
[docs/harness-telemetry.md](harness-telemetry.md) for the full design. Nothing here needs a config
key: the card→session link is read from the harness's own environment and needs no install, and the
one thing that is installed — a `SessionEnd`/`SubagentStop` hook in `~/.claude/settings.json` —
is asked for by hand with `flock setup --hooks` and removed with `flock setup --remove-hooks`.

| Env var | Default | What it does |
| --- | --- | --- |
| `FLOCK_SESSION` | auto-detected | The harness run key this write's events carry, e.g. `claude-code:<session id>`. Detected from `CLAUDE_CODE_SESSION_ID` when flock is running under Claude Code; set this for a harness flock cannot detect. Precedence: `--session`, this var, then detection. |
| `FLOCK_NO_HOOKS` | unset | `1` (or any non-empty value that is not `0`/`false`) makes `flock setup` skip the telemetry hook install entirely, even with `--hooks`. The same fail-closed rule as `FLOCK_NO_MODIFY_PATH`: an unwanted install costs more than a missed opt-out. |

The hook is opt-in, marked with `"_flock": "harness-telemetry"`, additive, and removable exactly.
flock reads transcripts on this machine only, stores numbers and paths and never transcript text,
and the HTTP API omits the stored transcript path unless the request comes from loopback.

## `~/.flock/skill.md`

Optional. This is the one place to put a standing personalization of the `/flock` skill — routing
preferences, models beyond the four the skill ships with and how to invoke them, house conventions
— without it being erased. Editing the installed `~/.claude/skills/flock/SKILL.md` in place does
not work: `flock setup`/`upgrade` and auto-update hash that file against the embedded copy and
repair any drift on every run (see ADR 0012 and `packages/cli/src/setup.ts`). `~/.flock/skill.md`
sits outside that mechanism entirely — **flock never writes it and no flock code ever reads it.**
It lives under `FLOCK_HOME` when that is set, next to `skill.json` (flock's own record of what it
last wrote to the installed SKILL.md, not to be confused with this file).

The skill's own text is what reads `~/.flock/skill.md`: at the start of every run the conductor
reads it, if present, before continuing. Precedence, highest last: the vendored skill,
`~/.flock/skill.md`, the board's brief and decisions, then whatever the human says in the current
session. The file supplements the vendored skill and wins wherever the two conflict — there is no
section-by-section merge, so a plain-language override (including a negation like "never route to
fable") is enough.

Format: plain markdown, no frontmatter, no required headings — it is never loaded as a Claude Code
skill in its own right, only read as text. Keep it short; it is read on every run.

`flock setup` prints `skill personalization: <path>` when the file exists, and says nothing when
it does not; `--json` always includes `personalization` and `hasPersonalization`. See
[docs/examples/skill-codex-routing.md](examples/skill-codex-routing.md) for a worked example: a
`## Routing` addendum for a user who runs Codex models as subagents. See
[ADR 0014](adr/0014-user-personalization-for-the-flock-skill.md) for the full decision and the
alternatives it rejected.
