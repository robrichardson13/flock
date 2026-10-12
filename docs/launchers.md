# Launchers

`flock spawn <card> --as <name> --model <m>` starts a top-level worker session on a card
([ADR 0029](adr/0029-agents-are-peer-sessions-that-talk-on-the-board.md)). Something has to
actually start that session: the **launcher**.

With no config, flock uses its built-in launcher. Set `launcher` in `~/.flock/config.json` to an
executable and flock hands every launch to it instead, so an environment that opens sessions its
own way (as IDE tabs, in a terminal multiplexer, on another machine) takes over without flock
knowing anything about it.

## The built-in launcher

| Harness | Starts | Session key |
| --- | --- | --- |
| `claude-code` | `claude -p --input-format stream-json --output-format stream-json --session-id <uuid>` under a detached `flock _supervise` process that holds its stdin open | `claude-code:<uuid>`, minted before launch |

`codex` and `opencode` are not built in yet. The harness comes from `--harness`, else from the
model: `gpt-*`/`o<digit>*` is codex, `opencode:<provider>/<model>` is opencode, anything else
Claude Code.

- **Permissions.** A headless worker has nobody to answer a prompt, so Claude Code runs with
  `--permission-mode bypassPermissions` unless `harnesses.claude-code.permissionMode` says
  otherwise; `harnesses.claude-code.allowedTools` is passed as `--allowedTools`. Outside
  `bypassPermissions`, Claude Code refuses every `flock …` command even when `Bash(flock:*)` is
  allowed: it reads `flock` as the Unix `flock(1)` wrapper, which runs another command. A worker
  under `acceptEdits` therefore needs `flock` reachable under another name.
- **Logs.** `$FLOCK_HOME/agents/<board>/<name>/`: `session.jsonl` (the stream-json output),
  `session.err`, `supervisor.log`.
- **Lifetime.** The supervisor polls the board every 30 seconds. Once the worker's card is closed,
  or it has released a card it claimed, and its inbox has been quiet for ten minutes, it closes
  the session's stdin and gives it two minutes to finish before killing it.
- **Worktrees.** `--worktree` makes `<repo>-<board>-<card>` beside the board's project, on branch
  `flock/<board>-<card>` (reused if it already exists), and links it to the board until the card
  closes.
- **Environment.** The worker gets `FLOCK_ACTOR`, `FLOCK_ACTOR_KIND=agent`, `FLOCK_MODEL`,
  `FLOCK_EFFORT` and `FLOCK_DB`; the spawning session's own Claude Code and flock identity
  variables are stripped so the worker does not inherit them.

## Writing an external launcher

The launcher is run once per operation with one JSON object on stdin, and must print one JSON
object on stdout and exit 0. A non-zero exit fails the `flock spawn` with the launcher's stderr.

### `launch`

```json
{
  "op": "launch",
  "board": "app",
  "card": 4,
  "name": "scout",
  "harness": "claude-code",
  "model": "sonnet",
  "effort": "high",
  "cwd": "/repos/app",
  "worktree": true,
  "prompt": "You are scout, a flock worker on board app. …",
  "env": { "FLOCK_ACTOR": "scout", "FLOCK_ACTOR_KIND": "agent", "FLOCK_MODEL": "sonnet", "FLOCK_EFFORT": "high" }
}
```

Start a session for `harness` with `model` and `effort`, in `cwd` (or in a new worktree of it when
`worktree` is true), and send it `prompt` as its first message. Pass `env` if you can; the prompt
already names the board and `--as` on every command, so a launcher that cannot is still correct.

Reply:

```json
{ "sessionKey": "claude-code:<session id>", "pid": 12345, "openUrl": "my-ide://open?tab=…", "cwd": "/repos/app-wt" }
```

Every field is optional. `sessionKey` is the harness run key flock links telemetry by
(`<family>:<session id>`). `openUrl` is where a human can open the session; a non-`http(s)`
scheme is only shown to loopback clients. `cwd` is where the session runs — return the worktree
path when you made one, and flock links it to the board until the card closes.

### `deliver`

```json
{ "op": "deliver", "board": "app", "name": "scout", "harness": "codex", "sessionKey": "codex:<thread>", "message": "…" }
```

Optional, for harnesses that cannot pull their own inbox: put `message` in front of the session.
Reply `{ "delivered": true }`, or `{ "delivered": false }` to leave it unread for later.
