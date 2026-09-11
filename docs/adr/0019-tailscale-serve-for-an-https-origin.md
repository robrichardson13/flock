# ADR 0019: `tailscale serve` for an HTTPS origin

**Status:** accepted, 2026-09-11

## Context

ADR 0017 adds Web Push. Push registration, `navigator.serviceWorker`, and the iOS home-screen
install path all require a secure context: browsers grant those APIs to `https://` origins and to
`http://localhost` only. Every URL flock advertises today (ADR 0015) is `http://` — loopback, LAN
IPv4s, and the tailnet address on the daemon's own port. So the one machine where push can be tested
is the machine running the daemon, in a tab pointed at localhost, and the phone that would actually
receive the notification cannot install the app at all.

Tailscale already solves this for a tailnet: `tailscale serve` terminates TLS on `:443` using a
certificate tailscaled obtains for the node's MagicDNS name, and reverse-proxies to a local port.
The result is `https://<machine>.<tailnet>.ts.net` — a real certificate, a stable origin, reachable
from every device on the tailnet and from nowhere else. Rob has been running that command by hand
after every `flock up`, and losing it on every restart.

Funnel — exposing the same origin to the public internet — is explicitly not in scope.

## Decision

- **`flock up --tailscale`** makes the daemon establish a `tailscale serve` mount for its
  browser-facing port, and tear it down on `flock down`. `--no-tailscale` turns it off for one
  invocation.
- **Resolution** follows ADR 0015's chain: `--tailscale`/`--no-tailscale`, else `FLOCK_TAILSCALE`
  (`0`/`false`/`no`/empty are off), else `"tailscale"` in `~/.flock/config.json`, else off.
  `resolveTailscale` in `packages/cli/src/tailscale.ts` is the single place this is decided.
  As with `host`, a bare `up`/`restart` does not recompute the default: `preserveRunningTailscale`
  reads the choice back off the running daemon's runfile, so restarting a dev server does not
  silently drop the HTTPS origin that a phone's installed app depends on.
- **One mount, on the browser-facing port**: vite's `webPort` in checkout mode, the single
  `apiPort` in binary mode. The web app fetches only relative `/api` paths and vite proxies them
  onward, so nothing in the browser ever addresses the API port and a single mount raises no
  mixed-content problem. The mount is at `/`, never a sub-path — vite's client assets and the app's
  own fetches are absolute-rooted.
- **The commands**, all through an injectable runner so nothing is hard-wired to a subprocess:
  - `tailscale status --json` for preflight and for the MagicDNS name (`.Self.DNSName`,
    `.BackendState`, `"https" in .Self.CapMap`);
  - `tailscale serve --bg --yes --https=443 http://127.0.0.1:<port>` to mount;
  - `tailscale serve status --json` to read the live mount table;
  - `tailscale serve --https=443 off` to unmount.
  The binary is located as `FLOCK_TAILSCALE_BIN`, else `tailscale` on `PATH`, else known install
  paths — on macOS the App Store build ships no CLI on `PATH`, only
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- **`off`, not `reset`.** `tailscale serve reset` clears the node's entire serve configuration,
  including mounts flock never created and cannot restore. Teardown removes only the `:443` handler,
  and only after reading `serve status --json` and confirming the live `/` mount still proxies to
  the target this daemon recorded; if it points anywhere else, flock leaves it alone and says so.
- **Refuse, do not warn.** If tailscale was asked for and cannot be established — binary missing,
  `BackendState` not `Running`, HTTPS certificates not enabled on the tailnet, `/` already mounted
  elsewhere, the serve command failing — `up` fails with a message naming the next command to run,
  and starts nothing (the read-only half of preflight runs before spawning, in `resolvePlan`) or
  stops what it just started (the mount itself is asserted only after the daemon is listening). A
  daemon that is up but silently lacks the secure origin it was started for surfaces as
  "notifications stopped working" days later, with no path back to the cause. A `tailscale: true`
  in the config file is treated exactly like the flag: a standing instruction, not a preference.
  In the implementation this preflight-then-mount split is two functions, not one:
  `preflightTailscale` (read-only: locate the binary, `status --json`, the four checks above) runs
  once before `spawnChildren`, and `establishTailscale` (preflight, then the `serve --bg …` mount
  itself) runs after the daemon is listening — every `up`, whether it just started the daemon or
  found one already running, so a fresh start and a re-assert share one code path.
- **The runfile records the mount** — `tailscale`, `tailscaleUrl`, `tailscaleTarget` — so `down`,
  `status` and `url`, which are separate process invocations, know what is active without probing
  tailscaled. The stored *target* is what teardown compares against, not a recomputed one: a daemon
  may have fallen back onto offset ports since (ADR 0003), and a recomputed target would fail the
  ownership check and leave the machine serving. `tailscale` joins `settingsOf`, so toggling it
  restarts the daemon rather than introducing a third reconfigure-in-place lifecycle path.
  Every `up` re-asserts the mount, since tailscaled's state can change underneath us
  (`tailscale down`, a reboot, a manual `reset`) — `flock up` is the reconciler.
- **The https URL is advertised first**, by `advertisedUrls(host, port, interfaces, tailscaleUrl)`
  — still the one function that decides what is advertised. It becomes `urls[0]`, so `flock url`,
  `flock status`, and the `up`/`serve` banner all lead with it; the loopback and LAN entries still
  follow, because they stay reachable and the mount is state someone else can remove. In the
  loopback-bind branch the "to reach from other devices" hint is dropped: with a mount there now is
  a way, and it is the first line. `flock status` adds a `tls` line naming the mechanism and the
  target.
  **`--open` is the one exception and stays on the loopback/bound address**, not `urls[0]`, in both
  `flock up` and `up --foreground`/`serve`. `--open` puts a browser tab up on this same machine, so
  there is no reason for it to leave loopback and take the tailnet round-trip (extra latency, a
  dependency on tailscaled being reachable at that moment). It also preserves the flock skill's
  documented behaviour of treating the first line of `flock url` as a same-machine base: with a
  mount active, `flock url`'s first line is now the https URL rather than loopback, and that URL
  still works from this machine (the tailnet routes back to itself), so the skill's instruction to
  take the first line as the base stays correct even though the wording that used to say "always
  loopback form" no longer does.

## Consequences

- `flock up --host 127.0.0.1 --tailscale` becomes the most locked-down useful configuration:
  nothing bound to any interface, reachable only through tailscaled, authenticated by the tailnet.
- Web Push and the iOS home-screen install work against a dev checkout, not only against a
  deployed instance.
- flock now writes state outside its own directories — tailscaled's serve configuration — which is
  why teardown is guarded and why `reset` is never run on the user's behalf.
- `:443` on the node can serve one thing. A machine already using it for something else gets a
  refusal, not a takeover.
- A machine with no Tailscale is unaffected: with the feature off — the default — no tailscale
  binary is looked for and no subprocess is run. The pre-existing tailnet *hint* in `networkHosts()`
  keeps its current behaviour of failing silently when the binary is absent or the node is logged
  out. Only an explicit request errors, and it errors in one line.
- Funnel is still out of scope; nothing here exposes anything beyond the tailnet.
- `flock url`'s first line is no longer unconditionally loopback/localhost form on a machine running
  a tailscale-mounted daemon — it is the https tailnet URL. Anything that reads "the first line" as
  a same-machine base (the flock skill's board-URL step) still works, since that URL is reachable
  from the same machine too; `--open` is unaffected either way, since it never followed `urls[0]`.
