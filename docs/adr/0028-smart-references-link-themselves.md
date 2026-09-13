# ADR 0028: A reference written in prose links itself

**Status:** accepted, 2026-09-13

## Context

Agents and humans already cross-reference constantly on a board — "blocked by card 59", "per d8",
"Rob said in m194". The reader then has to go and find the thing by hand. ADR 0006 gave messages
and comments a light markdown renderer, so a writer *could* type `[card 59](#/b/flock-2/c/59)`, but
nobody does and nobody should have to know the route.

Two ways to fix it. Tell agents in the skill to write explicit links — cheap, but it burdens every
writer forever, does nothing for the thousands of messages already on the board, and helps a human
typing in the composer not at all. Or detect the references that are already being written. The
risk of detection is false positives: `#1 priority`, a GitHub issue number in a pasted PR body, a
version number that looks like a comment ref.

## Decision

Detect, and say so in one sentence of prose so writers know which forms are live.

- The grammar is the set of forms flock itself prints, and nothing more: `card <n>` / `cards <n>` /
  `card #<n>`, a bare `#<n>`, `d<n>` for a decision, `m<n>` for a channel message. Flock already bans
  writing a card as `#n` in GitHub text, where it would mean a PR or issue (d8), so inside flock a
  bare `#n` is unambiguous.
- Deliberately excluded: the bare comment ref `<card>.<n>` that `card show` prints. `1.5 seconds`
  and `v2.1` would both linkify, and `card <n>` already reaches the only page that ref has.
- Numbers are capped at five digits, `0` is never a reference, `d`/`m` are matched case-sensitively
  and only on a word boundary, and one body linkifies at most `MAX_REFS` (50) references.
- `findRefs`, `refHref` and `linkifyRefs` are pure and live in `packages/web/src/refs.ts`, tested
  directly in `refs.test.ts`. `tokenizeInline` is untouched: linkification is a **post-pass over its
  token tree**, which is what makes the two safety rules structural rather than regex trickery — a
  `code` token is never visited, and a `link`'s children are never descended into.
- Targets are the app's own hash routes: card → `#/b/<slug>/c/<n>`, decision →
  `#/b/<slug>/decisions`, message → `#/b/<slug>/channel`. There is no per-message or per-comment
  anchor route yet, so those two land on the surface the thing lives on.
- **Only inside a board.** The board in scope comes from the existing `ActorLinkCtx` provider (`useBoardRef`),
  the same fact avatars use to know where a tap goes. On Home, where the needs-you list mixes cards
  from every board, a written `card 12` is ambiguous, so nothing linkifies and the text stays plain.
- No new colour: a ref link keeps `--ink-link` and says "inside the app" with a dotted underline
  (`.ref-link`), so the contrast gate has nothing new to weigh.
- The React half of inline rendering moved out of `markdown.tsx` into `inlineRender.tsx`, which is
  also where the decision about whether refs are linkified at all now lives.

## Consequences

- Everything already written on every board becomes navigable, with no migration and no rewrite of
  stored text: bodies are still stored verbatim (ADR 0006), this is display only.
- A message that says "`#1` priority" now renders a link to card 1. That is the accepted cost of the
  bare-`#n` form; a writer who means otherwise puts it in backticks, where it stays literal.
- Widening the grammar — an actor reference, a board-qualified `slug#n`, a real per-message anchor —
  is a later decision, not a version bump, exactly as ADR 0006 framed its own subset.
