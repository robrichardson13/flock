# `~/.flock/config.json`

Optional. flock works with no config file at all; this is only for turning something off.

```json
{
  "autoupdate": false,
  "host": "127.0.0.1"
}
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `autoupdate` | boolean | `true` | `false` stops an installed flock from updating itself. |
| `host` | string | `0.0.0.0` | The bind host `flock serve`/`flock up` fall back to when there is no `--host` flag and no `FLOCK_HOST`. Precedence, highest first: `--host`, `FLOCK_HOST`, this key, then the built-in `0.0.0.0` default. Set it to `127.0.0.1` to keep every future `flock up` on this machine to loopback without having to pass `--host` (or export `FLOCK_HOST`) every time. See [ADR 0015](adr/0015-bind-to-all-interfaces-by-default-and-advertise-only-reachable-urls.md). |

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

## Web Push notifications

See [ADR 0017](adr/0017-web-push-notifications.md) and
[docs/notifications-contract.md](notifications-contract.md) for the full design. The server
generates a VAPID key pair on first use and writes it to `~/.flock/vapid.json` (mode 0600,
`FLOCK_HOME`-aware like everything else here) — not to `config.json`, since it is a secret rather
than a setting.

| Env var | Default | What it does |
| --- | --- | --- |
| `FLOCK_VAPID_PUBLIC_KEY` + `FLOCK_VAPID_PRIVATE_KEY` | none | Set both to skip `vapid.json` entirely and use these keys instead. For a deploy with no durable disk (e.g. Railway), where a generated file would be lost — and every subscription silently invalidated — on each redeploy. |
| `FLOCK_VAPID_SUBJECT` | `https://github.com/robrichardson13/flock` | The VAPID JWT's contact subject. Must be an `https:` URL or a `mailto:` URI that resolves for real — APNs rejects a placeholder like `mailto:flock@localhost` with 403 `BadJwtToken`. |
| `FLOCK_NO_PUSH` | unset | `1` turns off the push pump and VAPID key generation entirely; `GET /api/push/key` then reports `{ enabled: false }`. |

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
