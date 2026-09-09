# ADR 0014: Add to chat — quoting a channel message into the composer

**Status:** accepted, 2026-09-09

## Context

Replying to something said earlier in the channel meant either scrolling back to keep it in view or retyping it by hand. nib (`/Users/robrichardson/Code/robrichardson/nib`) already solves this in its agent transcript: select text, a small "Add to chat" tip appears over the selection, clicking it quotes the text into the composer. Card #1 researched nib's implementation and flock's channel/composer path and proposed carrying the same shape over, desktop only.

Two obstacles specific to flock's code, not nib's:

- `LineComposer` (`thread.tsx`) owns its text in local `useState`, seeded from the module-level draft store (`compose.ts`) only at mount, with no subscription. Writing the draft store from outside does nothing to a composer already on screen — inserting a quote needs a live hand-off, not a write to storage.
- `markdown.tsx`'s message-mode renderer (`MessageBody`/`splitMessageBlocks`) had no blockquote block; a natural `> quoted` format would otherwise render as literal text.

## Decision

### Detection: `selectionchange`, scoped to one message body

`useAddToChat(scopeRef, enabled)` (`packages/web/src/addToChat.tsx`) listens for `selectionchange` on `document` while `enabled` and reports a `SelectionInfo` (`{ rect, text, author }`) or `null`. A selection is eligible only when it is not collapsed, not whitespace-only once trimmed, has both its anchor and focus inside `scopeRef` (the channel's own scroller — the same ref `useStickToBottom` already owns), and both ends land inside the *same* `.msg-body` element. That last check is what makes a selection spanning two messages, or one reaching into the composer or anywhere else in the app, report nothing — there is no special-casing of the composer at all; it simply isn't inside a `.msg-body`.

Each `.msg` bubble in `ThreadGroup` (`thread.tsx`) now carries `data-msg-author`. The tip's byline walks up from the selection's start and end containers to the nearest such attribute; when the two ends disagree (only reachable through DOM-ordering edge cases, since a cross-bubble selection is already rejected) the quote carries no attribution rather than a wrong name.

Dismissal: the selection collapsing or emptying (the next `selectionchange`), any scroll of the scroller itself (hide, don't reposition — a selection scrolled out of view is honestly gone), window `blur`, and `Escape`.

### Placement: fixed, portalled, measured before shown

`AddToChatTip` portals a `<button>` to `document.body` via `createPortal` — never inside `.pane`, whose crossfade/push transforms (`styles.css`) would otherwise become the containing block for `position: fixed` and break the anchoring. `tipPlacement(rect, tip, viewport, margin)` is the pure arithmetic: above the selection by `margin` when there's room, flipped below when there isn't, both axes clamped into the viewport. The button renders with `visibility: hidden` on the frame it first appears so its own size can be measured (`offsetWidth`/`offsetHeight` after layout, in a `useLayoutEffect`) before `tipPlacement` runs and it is shown at the right spot — a `display: none` element would measure zero.

Activation is `onMouseDown` with `preventDefault()`, not `onClick`: a `mousedown` anywhere collapses the browser's selection before `click` would fire, so a click handler would always see empty text. `preventDefault` also keeps focus from moving off whatever had it.

### Format: a blockquote, with attribution

`quoteBlock(text, author, limit = 4000)` (pure): normalise CRLF/CR to LF, drop leading and trailing blank lines, return `null` if nothing is left (whitespace-only selections offer no tip in the first place, but the formatter is defensive on its own). Every remaining line is prefixed `> ` (a bare `>` for an empty interior line). Truncation happens at a line boundary under the character limit, appending a `> …(truncated)` line — a channel message is not a transcript, so the cap is 4000 rather than nib's 8000. When an author is known, a `> **author** said:` line leads the quote. The whole block ends `\n\n`, so a caret placed right after it starts a fresh line.

```
> **ada** said:
> the first selected line
>
> the third
<blank line, caret here>
```

`markdown.tsx` gained a `{ t: "quote"; lines: string[] }` block in `splitMessageBlocks`, matched by `/^>\s?(.*)$/` ahead of the task/list checks (a `> - x` line can never match either of those regexes — both anchor on optional whitespace then the marker — so the quote check only ever claims lines nothing else wanted), rendered as a `<blockquote>` in `MessageBody`. Styled with a `--line` left rule and `--text` (not `--muted`, which would need its own contrast check against `--bg-me`); no new colour. `flock help formatting` (`packages/cli/src/main.ts`) and the handoff doc (`packages/cli/src/handoff.ts`) both now mention it.

### Delivery: a pub/sub hand-off in `compose.ts`, not a draft-store write

`requestInsert(key, text)` / `subscribeInsert(key, fn)`, keyed by the same `draftKey` the draft store uses, sit beside it in `compose.ts`. Fire-and-forget: a request with no listener at its key is dropped rather than queued, since "Add to chat" is only ever offered while its composer is mounted and enabled. `LineComposer` subscribes for its own `key` and, on notification, inserts at the caret when the field is actually focused (`document.activeElement === el`) or appends after existing text otherwise, joining through `joinDraft(before, quote)` — one separating newline when the existing text doesn't already end in one, none onto an empty draft. The insertion goes through `setText`, so the existing `saveDraft` effect (already reacting to `text` changes) picks the quote up for free; nothing writes the draft store directly. After the state update lands, the composer focuses itself (`focusNoScroll`) and places the caret at the end of what was just inserted.

### Desktop gate: doubled, deliberately

`useAddToChat` is only invoked with `enabled = !useIsMobile() && useHasFinePointer()` — the same predicate `LineComposer` already uses for `enterSends`. `.add-to-chat`'s only rule lives inside `board-desktop.css`'s existing `@media (min-width: 900px)` block, so even if the JS gate were somehow bypassed the tip would render unstyled and inert. Belt and braces, matching the rest of the desktop-only surface in this file.

## Consequences

- No server or core change: this is composer text insertion only, with no reply-to metadata, no threading. Quoting from card comments or the activity tab is out of scope — the scoping check (`.msg-body` inside the channel's own scroller) naturally excludes both.
- The pure quarter — `quoteBlock`, `joinDraft`, `tipPlacement` — is unit-tested in `addToChat.test.ts`; the insertion channel in `compose.test.ts`; the new blockquote block in `markdown.test.ts`. The DOM half (`useAddToChat`, `AddToChatTip`) has no test: this package has no DOM environment that can drive a `Selection` (`testdom.ts` is hand-written and doesn't implement one), so it is verified by hand on the dev URL — matching how `viewstate.test.ts`/`live.dom.test.tsx` already split pure logic from real-DOM wiring elsewhere in this codebase.
- A card comment composer and the decisions composer both mount through the same `LineComposer` and therefore carry the same `subscribeInsert` effect, but nothing ever calls `requestInsert` for their keys — harmless dead capacity today, and the seam a future "quote a comment" feature would reuse rather than build again.
- `blockquote` styling is a left rule on `--line` plus `--text`, so the contrast gate (`scripts/contrast.ts`) needs no new token pair.
