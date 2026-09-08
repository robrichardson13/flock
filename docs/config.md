# `~/.flock/config.json`

Optional. flock works with no config file at all; this is only for turning something off.

```json
{
  "autoupdate": false
}
```

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `autoupdate` | boolean | `true` | `false` stops an installed flock from updating itself. |

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
