# ADR 0005: Agents declare their harness, model, and effort

**Status:** accepted, 2026-09-05

## Context

A board is worked by several agents at once, and the only thing distinguishing them today is a
name someone chose. `identity-design` tells you nothing about what actually did the work. When a
card comes back thin, or a resolution reads as over-thought for its size, the useful question is
which harness ran it, on which model, at what reasoning effort. That answer currently lives only
in the conductor's head and is gone the moment the session ends.

Attribution in flock is already explicit and already denormalized: core methods take an `Actor`,
`events` carries `actor` and `actor_kind` columns rather than a foreign key, and the `actors`
table is a latest-seen roll-up. Runtime is the same shape of fact as `actor_kind` and should
follow the same path rather than invent a new one.

The complication is that a named agent is not stable. `composer-fix` may be Sonnet on one card
and Opus on the next, because the conductor routes per delegation (see ADR 0004). Runtime is a
property of a run, not of a name.

### What the harness actually exposes

Measured from inside a Claude Code 2.1.261 subagent on 2026-09-05, by reading the child
process environment:

| Variable | Value | Use |
| --- | --- | --- |
| `CLAUDECODE` | `1` | harness present |
| `AI_AGENT` | `claude-code_2-1-261_agent` | harness name, version, and role |
| `CLAUDE_CODE_ENTRYPOINT` | `cli` | surface |
| `CLAUDE_CODE_EXECPATH` | `.../versions/2.1.261` | version fallback |
| `CLAUDE_EFFORT` | `medium` | reasoning effort |
| `CLAUDE_CODE_SESSION_ID` | a uuid | correlates writes to one run |

No variable names the model. There is no `ANTHROPIC_MODEL`, no `CLAUDE_MODEL`, and nothing
under `CLAUDE_CODE_*` that carries one. The user's `~/.claude/settings.json` did contain
`"model": "sonnet"` while the probing process was running on Opus 5, because a `/model` change,
agent-definition frontmatter, and the Agent tool's per-delegation `model` override all bypass
that file. Reading settings.json would therefore produce confident wrong answers, which is worse
than producing none.

The harness does know: the statusline command receives `.model.display_name` and `.effort.level`
as JSON on stdin. That channel is not reachable from an arbitrary child process.

Effort is the pleasant surprise. `CLAUDE_EFFORT` is exported and mirrors the `effortLevel`
setting, so it is detectable, with the caveat that it reflects the session default rather than a
per-subagent override.

Other harnesses, from prior knowledge and **unverified here**: Codex CLI sets `CODEX_SANDBOX`
and `CODEX_SANDBOX_NETWORK_DISABLED` under its sandbox and exports no model name; Cursor sets
`CURSOR_TRACE_ID` and `CURSOR_AGENT`; Aider carries `AIDER_*` config variables. Each should be
confirmed before a detector is written for it.

## Decision

**Runtime is carried by the event and cached on the actor.** Three optional fields, `harness`,
`model`, and `effort`, ride on the `Actor` value that every core method already takes. `emit`
writes them onto the event row alongside `actor` and `actor_kind`; `touchActor` overwrites the
actor row's copy. The event log is the record, the actor row is the current answer.

Storing only on the actor loses history the first time an agent changes tier. Storing only on
events makes `flock actors` a group-by over the whole log. Both, with the actor row as a cache
of the last write, costs three nullable columns and no extra queries.

Three fields, not one string. They are filtered on independently: show me every card Sonnet
closed, show me what ran at high effort. Rendering collapses them back to one token.

`comments` and `messages` do not get runtime columns. Every comment already emits a
`comment.posted` event that carries it, and the UI renders comment runtime from the actor
cache. Duplicating onto a third and fourth table buys accuracy that no surface asks for.

**Resolution order is flag, then env, then detection, then nothing.** An explicit
`--model opus-5` always wins, because the process cannot see its own model and only the caller
knows. Detection fills what it can and stays silent otherwise; no field is ever guessed.

**Every field is optional, everywhere, forever.** Existing rows have nulls, `--json` gains keys
without losing any, and a runtime-unaware client is unaffected.

### Surface

- **CLI:** `--harness NAME`, `--model NAME`, `--effort LEVEL`, beside `--as`. Env
  `FLOCK_HARNESS`, `FLOCK_MODEL`, `FLOCK_EFFORT`, beside `FLOCK_ACTOR`. `flock help` lists them
  under IDENTITY.
- **Server:** `x-flock-harness`, `x-flock-model`, `x-flock-effort`, beside `x-flock-actor`.
- **Detection:** one `detectRuntime()` in core returning a partial. Claude Code is the only
  detector shipped: harness `claude-code` with the version from `AI_AGENT`, effort from
  `CLAUDE_EFFORT`, model left undefined.
- **Values are freeform strings**, lowercased and trimmed, capped at 64 characters. Effort is
  not an enum. Harnesses disagree about the ladder, and a rejected value is worse than an
  unfamiliar one.

### Who declares the model

The conductor knows, because it chose. `skills/flock/SKILL.md` already forbids omitting `model`
on a delegation; the same line now requires passing that model into the subagent's board
contract, so the subagent runs `--as <name> --model <the model>`. `flock handoff` tells the
agent to keep passing it, and to add `--effort` if it knows its own.

### Where it shows

| Surface | Rendering |
| --- | --- |
| `flock actors` | `🤖 composer-fix   claude-code/opus-5 · medium   <last seen>` |
| Web actor chip | `composer-fix` with `claude-code / opus-5` as the title attribute |
| Activity feed | actor name, then a dim `opus-5` suffix; harness and effort on hover |
| Card "claimed by" | assignee chip gains a dim model suffix |
| Card comments | author line gains a dim model suffix, from the actor cache |

Model is the field that earns space inline. Harness is near-constant within a board and effort
is rarely the question, so both go to the tooltip.

## Consequences

- Model accuracy depends on the conductor passing it. An agent launched by hand records nothing,
  which reads correctly as unknown rather than as wrong.
- `CLAUDE_EFFORT` is a session default, so a subagent whose effort was overridden reports the
  parent's until it declares its own. The flag exists for exactly that case.
- Runtime is self-reported and unauthenticated, like `--as` itself. It is for reading the board,
  not for enforcing anything.
- A future `flock log --model opus-5` filter is a where-clause away, because the columns are real
  columns and not JSON in the `data` blob.
- If comment-level historical runtime is ever wanted, it is an additive migration on `comments`
  plus a join; nothing here forecloses it.

## Implementation checklist

**`packages/core`**

1. `src/types.ts`: add `export interface Runtime { harness?: string; model?: string; effort?: string }`.
   Extend `Actor` with `harness?`, `model?`, `effort?` (flat, so `Actor` stays a plain value).
   Extend `Event` with the same three optional fields.
2. `src/db.ts`: add `harness TEXT`, `model TEXT`, `effort TEXT` to the `events` and `actors`
   `CREATE TABLE` statements, and add matching `ALTER TABLE ... ADD COLUMN` guards to `migrate()`
   following the existing `boards.project` pattern.
3. `src/flock.ts`: `touchActor` writes the three columns in both the INSERT and the ON CONFLICT
   update, but only overwrites a column when the incoming value is non-null, so a later
   runtime-less write does not erase a known model. `emit` writes them onto the event row.
   `rowToEvent` reads them back. `listActors` returns them.
4. New `src/runtime.ts`: `detectRuntime(env = process.env): Runtime` and
   `normalizeRuntime(r: Runtime): Runtime` (trim, lowercase, cap at 64 chars, drop empties).
   Detection: if `env.CLAUDECODE === "1"` or `AI_AGENT` starts with `claude-code`, set
   `harness` to `claude-code` plus the version parsed out of `AI_AGENT`
   (`claude-code_2-1-261_agent` becomes `claude-code@2.1.261`), falling back to the trailing path
   segment of `CLAUDE_CODE_EXECPATH`; set `effort` from `CLAUDE_EFFORT`; never set `model`.
5. `src/index.ts`: export `Runtime`, `detectRuntime`, `normalizeRuntime`.
6. Tests: `src/runtime.test.ts` covers a Claude Code env, an empty env, and a malformed
   `AI_AGENT`. `src/flock.test.ts` gains cases for runtime landing on the event, the actor cache
   holding the latest value, a null write not clobbering a known value, and an actor with no
   runtime staying null through claim and close.

**`packages/cli`**

7. `src/main.ts`: `resolveActor` merges flag, then env, then `detectRuntime()`, then nothing, and
   passes the result through `normalizeRuntime`. Add `--harness`, `--model`, `--effort` to the
   IDENTITY block of the help text with their env variables.
8. `src/main.ts` `case "actors"`: print `harness/model · effort` after the name, omitting absent
   parts and the whole column when everything is absent.
9. `src/handoff.ts`: one paragraph telling the agent to keep passing `--model`, to add `--effort`
   if it knows it, and that harness is detected. Only if the handoff caller has a model to name.
10. Tests: `src/args.test.ts` or a new `src/identity.test.ts` for the precedence chain.

**`packages/server`**

11. `src/index.ts`: `actorOf` reads `x-flock-harness`, `x-flock-model`, `x-flock-effort` and
    normalizes them. No route signatures change, since runtime rides inside `Actor`.
12. Test: a request with the headers lands runtime on the emitted event.

**`packages/web`**

13. `src/api.ts`: widen the `Actor`, `Event`, and actors-list types with the optional fields.
14. `src/ui.tsx`: a `RuntimeTag` component rendering the dim model suffix, with harness and
    effort in `title`. Returns null when there is no model.
15. `src/BoardView.tsx`: activity feed line (near line 482) and the assignee chips (lines 320
    and 337).
16. `src/CardPage.tsx`: the assignee chip (line 155) and the comment author line (line 208).
17. `src/styles.css`: one `.runtime` rule, dim and one step down in size.

**Docs and skill**

18. `skills/flock/SKILL.md`: in Routing, state that the chosen model must be passed into the
    subagent's board contract as `--model <model>`. In the delegation contract section, add it to
    the required elements beside `--as <name>`.
19. `CLAUDE.md`: add `FLOCK_HARNESS` / `FLOCK_MODEL` / `FLOCK_EFFORT` to the env var line.
20. `README.md`: mention the flags wherever `--as` is introduced.
21. Mark this ADR accepted once merged.
