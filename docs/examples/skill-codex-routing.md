<!-- Copy this file's content into ~/.flock/skill.md (or $FLOCK_HOME/skill.md). It is a
     worked example for a user who runs Claude Code as the conductor and OpenAI Codex CLI
     as subagents; adapt the model list and invocation details to what `codex --help` and
     `codex exec --help` show on your machine before trusting them. -->

## Routing

I run [Codex CLI](https://github.com/openai/codex) locally (`codex` on PATH) and want some
delegations routed to it instead of a Claude model. Codex is a separate product with its own
model family, sandboxing, and CLI — it is not one of the four tiers this skill ships with, and it
is invoked as a shell command, not through the Agent tool (Agent only spawns Claude models).

### Codex models

Current as of 2026-09-09 — verify with `codex --help` and `codex exec --help` before relying on
this, since OpenAI revises the lineup independently of this file:

- **gpt-6-astra** — the most capable current-generation Codex model: complex coding, computer use,
  research, cybersecurity-adjacent work. Use it where you would reach for opus.
- **gpt-5.6-sol** — advanced second-generation model for complex tasks. Similar use cases as gpt-6-astra.
- **gpt-5.6-terra** — the everyday workhorse, roughly the cost/quality slot sonnet fills for
  Claude. Most Codex delegations should land here.
- **gpt-5.6-luna** — the cheap, fast tier: mechanical edits, narrow fixes, boilerplate. The Codex
  analogue of haiku.
- **gpt-5.3-codex-spark** — a text-only, low-latency preview model for tight iteration loops
  (fast lint-fix-retry cycles); not for anything needing broad context or multi-file judgment.
- Older selectable models (`gpt-5.5`) still work but are being phased out. `gpt-5.4` and `gpt-5.4-mini`
  retired on August 31, 2026 — replace `gpt-5.4` with `gpt-5.6-terra` and `gpt-5.4-mini` with `gpt-5.6-luna`.

### When to route to Codex vs. sonnet/opus/haiku

Route to Codex when the task specifically benefits from a second, differently-trained model —
not as a default. In practice that means:

- **Adversarial verification of Claude's own work**: after a Claude subagent implements
  something, have Codex (`gpt-5.6-terra` or `gpt-6-astra` for higher stakes) review or re-derive
  it independently. A different model family catches different mistakes than a second Claude pass
  would.
- **A second opinion on a design or diagnosis** where being wrong is expensive (the same bar that
  would otherwise justify opus) and independence matters more than depth in Claude's own tool use.
- **Cost-sensitive mechanical fan-out** (many small, narrow, independently-checkable edits) where
  `gpt-5.6-luna` is meaningfully cheaper than haiku for the same shape of work.

Do not route to Codex by default, and never for a delegation that depends on Claude-specific tool
use, images in the conversation, or a long chain of this session's own context — Codex subagents
start cold from whatever prompt you give them, exactly like a fresh Claude subagent, but they
cannot fall back on shared training quirks or your own accumulated judgment calls the way another
Claude model might. When torn, stay in the four shipped tiers; reach for Codex only when the
reason is "a different model," stated plainly in the delegation.

### Invocation contract

Claude Code's `Agent` tool only spawns Claude models — there is no way to make it launch a Codex
process. The vehicle is a plain `Bash` tool call, run with `run_in_background` (or wrapped in a
`Monitor`) so the conductor is not blocked waiting on it:

```
codex exec --model gpt-5.6-terra --sandbox workspace-write --output-last-message <scratchpad>/codex/<card>.msg "<full prompt>"
```

- **`--model` / `-m`** selects the model; pass one of the names above (bare, not
  provider-prefixed) and never omit it, same as you would never omit `--model` on an Agent call.
- **`--sandbox workspace-write`** is the Codex analogue of a scoped write — it may edit files in
  the working tree but not reach outside it. Use `--sandbox read-only` for a review-only
  delegation, and never `--sandbox danger-full-access` for a subagent you have not written the
  prompt for yourself.
- **The prompt is the full self-contained brief**, exactly as this skill already requires for any
  delegation (see `## Delegate` above): paths, conventions, what not to touch, the card number,
  which cards to read for context (`flock card show <n> --json`, not pasted output), the `--as
  <name>` to use, and transcriptions of anything visual in this conversation — **Codex cannot see
  images either**, so the same "describe it in words" rule applies, no special-casing needed.
- **The result comes back over stdout**: Codex streams its own progress to stderr and prints only
  the final agent message to stdout; `--output-last-message <path>` additionally writes that final
  message to a file (still printing it), which is the more reliable thing to read back for a long
  run under `run_in_background`. Read the file (or the backgrounded command's captured stdout)
  once the process exits — do not parse stderr for the result.
- **The flock board contract is unchanged.** A Codex subagent is still an agent on the board: its
  prompt still ends with `flock handoff --as <name> --model <model>` first, a claim before any
  work, `flock comment` at meaningful steps, and `flock done --resolution "..."` (or `flock ask` +
  `flock release` if it needs the human) — identical to a Claude subagent's contract. The `<model>`
  recorded on the board is exactly the string you passed to `--model` above (e.g. `gpt-5.6-terra`);
  Codex cannot detect or report its own model any more than a Claude subagent can, so if you don't
  pass it the board records the delegation as unknown, not as "codex."

<!-- Verified 2026-09-09 against:
     - https://learn.chatgpt.com/docs/models (model list, retirement dates)
     - https://learn.chatgpt.com/docs/non-interactive-mode (flags: --sandbox values, -o/--output-last-message)
     
     Findings: Updated model list to include gpt-6-astra (new most capable). Corrected gpt-5.4/gpt-5.4-mini
     retirement status to reflect August 31, 2026 retirement date. --model/-m flag mentioned in invocation
     examples but not documented in OpenAI's primary non-interactive mode docs; marked for local verification.
     
     Note: `codex` CLI not installed locally. Verify with `codex --help` and `codex exec --help` before
     trusting flag names or invocation syntax. -->
