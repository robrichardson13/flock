# ADR 0014: A user personalization file the skill reads at run start

**Status:** accepted, 2026-09-09

## Context

`skills/flock/SKILL.md` is vendored. `flock setup` writes it to `~/.claude/skills/flock/SKILL.md` and compares the destination's own hash against the embedded content on every run, so any hand-edit is repaired — that is deliberate (`packages/cli/src/setup.ts`), and `flock upgrade` and auto-update run the same path. A user therefore has nowhere to put a standing preference about how the skill conducts a run: edit the installed copy and the next update erases it; edit a contributor checkout's copy and it is a tracked file in someone else's repo.

The concrete want is routing. `### Routing` (under `## Delegate`) names sonnet, opus, haiku and fable and nothing else. A user who runs Codex models as subagents needs the conductor to know they exist and how to invoke them, and that is a property of their machine, not of flock.

## Decision

- **`~/.flock/skill.md`** — `$FLOCK_HOME/skill.md` when `FLOCK_HOME` is set. Optional; absent means today's behavior exactly. Nothing in flock ever writes it, and no code reads it either.
- **The skill text reads it, at run start.** `SKILL.md` instructs the conductor to read the file if it exists, before step 2. No compose step in `flock setup`, no build-time merge: `writeSkill()`'s "the file's own hash is the truth, drift gets repaired" property stays intact, and a symlinked checkout behaves identically to an installed binary because the file lives outside that question entirely.
- **Supplement with precedence, not section replacement.** The file adds to the vendored skill, and wherever the two conflict the user's file wins. That is the whole rule. The precedence ladder, stated in the skill: vendored skill < `~/.flock/skill.md` < the board's brief and decisions < what the human says now.
- **Plain markdown, no frontmatter, no required headings.** The file is never loaded as a Claude Code skill, so frontmatter would only imply otherwise. `##` headings are a suggestion for the user's own sake. Keep it short — it is read on every run.
- **The skill states the path literally**, as `~/.flock/skill.md`, with a parenthetical for `FLOCK_HOME`. The skill already hard-codes `~/.claude/skills/flock/SKILL.md` in its own text; asking an agent to expand an env var to find a file is worse than telling it the path.
- **`flock setup` prints one line when the file exists**, and nothing when it does not; `--json` carries the path either way. Discovery when absent is `docs/config.md` and `flock help`.
- **No `flock skill` verb.** There is no path to compute, no schema to validate, and `cat` and `$EDITOR` already show and edit it.

## Consequences

- Personalization is machine-global and conductor-only. Subagents never see it; they are onboarded by `flock handoff`. Per-project preferences already have a home in the brief's `## Notes`, which outranks this file.
- Precedence is re-derivable from the two documents on every read, which matters because the brief tells a resumed run to re-read the vendored skill. A merge computed once at run start would not survive that; a precedence rule does not need to.
- A user can override effectively anything by writing enough, including negations ("never route to fable"). That is intended, and it is on them: a broadly rewritten file will drift from vendored improvements it never sees.
- `~/.flock/` now holds `skill.json` (flock's record of the installed skill) next to `skill.md` (the user's, never touched by flock). The docs must say so in as many words.
- No core or server change, and no domain rule — the mechanism is one paragraph of skill text plus one line of `flock setup` output.

## Alternatives considered

- **`~/.claude/skills/flock/local.md`.** Sits inside the directory Claude Code owns the meaning of, and in the checkout case resolves into the repo — either tracked, and so no longer personal, or untracked in every clone.
- **Named-section override** (a `## Routing` in the user file replaces the vendored section). More expressive on paper, but it asks the conductor to locate section boundaries and hold a merge result across compaction and re-reads, and the heading levels do not even line up (`### Routing` is nested). Precedence gets the same outcome from a rule that cannot be misapplied.
- **Full-file override.** One flag's worth of simplicity in exchange for silently freezing the skill at the version the user forked.
- **Composing the installed `SKILL.md` from vendored + user file at setup/upgrade time.** Deterministic, but it forces `writeSkill()` to distinguish intentional from accidental drift, and the symlinked checkout never goes through it at all, so the contributor workflow would need a second mechanism.
