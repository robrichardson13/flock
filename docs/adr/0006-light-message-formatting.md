# ADR 0006: Light markdown in the web UI, raw text everywhere else

**Status:** accepted, 2026-09-05

## Context

Channel messages, card comments and resolutions rendered as raw text in a `pre-wrap` block. Agents
write structured prose there — findings, short lists, file paths — and it arrived as an
undifferentiated wall. Card bodies and the board brief already went through `Markdownish`, a
hand-rolled renderer in the web app that understood headings, bullets, task lists, fenced code,
`` `code` `` and `**bold**`. So the board already had two grades of text with no stated reason.

The web app has no markdown dependency and no sanitizer. Adding a full CommonMark stack would bring
tables, raw HTML passthrough and a sanitizer to configure, in exchange for italics and links.

## Decision

- One renderer, `packages/web/src/markdown.tsx`, over a pure inline tokenizer in
  `packages/web/src/inline.ts`. No dependency; no `dangerouslySetInnerHTML` anywhere.
- The inline subset is `**bold**`, `_italic_`/`*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`
  and bare http/https/mailto URLs. `_` is only emphasis at a word boundary, so `snake_case` is literal.
- Two modes. Documents (board brief, card bodies) keep paragraph reflow and headings. Messages
  (channel, comments, resolutions, asks, answers, decision gists) preserve every newline, drop
  headings, and keep bullets and fenced code.
- Anchors are validated against an http/https/mailto allowlist and rendered
  `target="_blank" rel="noopener noreferrer"`. An unsafe or relative URL renders as literal text.
- Bodies are stored verbatim by `@flock/core`. Formatting is a display concern only; the CLI and
  every `--json` payload return exactly what was written.
- Agents learn it by progressive disclosure: one line in `flock handoff`, the detail in
  `flock help formatting`, a voice note in the flock skill. It is never a requirement.

## Consequences

- Text with no markers renders byte-identically to before, which is the compatibility contract and
  is enforced by test.
- A message containing a literal `*` or `_` in prose can now change appearance. The word-boundary
  rule and the "delimiters hug non-space" rule cover the cases that actually occur (`snake_case`,
  `2 * 3`, `**` in a shell glob); the rest is accepted cost.
- The grammar is ours, not CommonMark's. Anything outside the subset above is literal, and widening
  it is a decision, not a version bump.
- Card autolinks (`#12`), ordered lists, tables and mentions are out of scope and would each be a
  new decision.
