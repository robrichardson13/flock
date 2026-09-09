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

Dismissal: the selection collapsing or emptying (the next `selectionchange`), any scroll (hide, don't reposition — a selection scrolled out of view is honestly gone), a window `resize` (which relays out the feed under the selection, so the measured rect is stale), window `blur`, and `Escape`. The scroll listener is on `document` in the capture phase rather than on the scroller element: `scroll` does not bubble but it does capture, so one listener covers whichever element is actually scrolling — including a scroller React replaced after this effect last ran, which a listener bound to `scopeRef.current` would have missed, and the programmatic pin `useStickToBottom` performs when a new message arrives, which is what keeps a tip from outliving an SSE-driven re-render beneath it.

### Placement: fixed, portalled, measured before shown

`AddToChatTip` portals a `<button>` to `document.body` via `createPortal` — never inside `.pane`, whose crossfade/push transforms (`styles.css`) would otherwise become the containing block for `position: fixed` and break the anchoring. `tipPlacement(rect, tip, viewport, margin)` is the pure arithmetic: above the selection by `margin` when there's room, flipped below when there isn't, both axes clamped into the viewport. The button renders with `visibility: hidden` on the frame it first appears so its own size can be measured (`offsetWidth`/`offsetHeight` after layout, in a `useLayoutEffect`) before `tipPlacement` runs and it is shown at the right spot — a `display: none` element would measure zero.

Activation is `onMouseDown` with `preventDefault()`, not `onClick`: a `mousedown` anywhere collapses the browser's selection before `click` would fire, so a click handler would always see empty text. `preventDefault` also keeps focus from moving off whatever had it. Enter and Space are handled in `onKeyDown` alongside it — the button is portalled to the end of `document.body` and so is in the tab order, and answering only `mousedown` made it a dead stop there (found in review, card #3). Not `onClick`, which would double-fire behind the `mousedown`.

### Format: a blockquote, with attribution

`quoteBlock(text, author, limit = 4000)` (pure): normalise CRLF/CR to LF, drop leading and trailing blank lines, return `null` if nothing is left (whitespace-only selections offer no tip in the first place, but the formatter is defensive on its own). Every remaining line is prefixed `> ` (a bare `>` for an empty interior line). Truncation happens at a line boundary under the character limit, appending a `> …(truncated)` line — a channel message is not a transcript, so the cap is 4000 rather than nib's 8000. When an author is known, a `> **author** said:` line leads the quote. The whole block ends `\n\n`, so a caret placed right after it starts a fresh line.

```
> **ada** said:
> the first selected line
>
> the third
<blank line, caret here>
```

`markdown.tsx` gained a `{ t: "quote"; lines: string[] }` block in `splitMessageBlocks`, matched by `/^>\s?(.*)$/` ahead of the task/list checks (a `> - x` line can never match either of those regexes — both anchor on optional whitespace then the marker — so the quote check only ever claims lines nothing else wanted), rendered as a `<blockquote>` in `MessageBody`. Styled with a `--line` left rule and `--text` (not `--muted`, which would need its own contrast check against `--bg-me`); no new colour. `flock help formatting` (`packages/cli/src/main.ts`) and the handoff doc (`packages/cli/src/handoff.ts`) both now mention it; the same help text's stale claim that headings are not interpreted (they have been for some time) went with it.

### Delivery: a pub/sub hand-off in `compose.ts`, not a draft-store write

`requestInsert(key, text)` / `subscribeInsert(key, fn)`, keyed by the same `draftKey` the draft store uses, sit beside it in `compose.ts`. Fire-and-forget: a request with no listener at its key is dropped rather than queued, since "Add to chat" is only ever offered while its composer is mounted and enabled. `LineComposer` subscribes for its own `key` and, on notification, appends the quote to the end of its draft through `joinDraft(existing, quote)`: nothing onto an empty draft, and a blank line onto anything else. It appends rather than inserting at the caret. The first implementation tried the caret when the field was focused; review (card #3, driven in a headless browser) found that branch both unreachable and wrong when reached — making a selection in the feed blurs the textarea, since a `mousedown` on non-focusable content does, so at pick time there is no live caret in the composer, and the `selectionStart` the engine still reports has been reset to 0, which put the quote in front of the sentence the human was mid-way through writing. A blank line rather than a single newline, so the human's own sentence and the quote read as two blocks in the textarea as well as in the rendered message (`markdown.tsx` gives the `>` run its own block either way, but the composer is where the difference is felt). The insertion goes through `setText`, so the existing `saveDraft` effect (already reacting to `text` changes) picks the quote up for free; nothing writes the draft store directly. After the state update lands, the composer focuses itself (`focusNoScroll`) and places the caret at the end of what was just inserted.

### Desktop gate: doubled, deliberately

`useAddToChat` is only invoked with `enabled = !useIsMobile() && useHasFinePointer()` — the same predicate `LineComposer` already uses for `enterSends`. `.add-to-chat`'s only rule lives inside `board-desktop.css`'s existing `@media (min-width: 900px)` block, so even if the JS gate were somehow bypassed the tip would render unstyled and inert. Belt and braces, matching the rest of the desktop-only surface in this file.

## Consequences

- No server or core change: this is composer text insertion only, with no reply-to metadata, no threading. Quoting from card comments or the activity tab is out of scope — the scoping check (`.msg-body` inside the channel's own scroller) naturally excludes both.
- The pure quarter — `quoteBlock`, `joinDraft`, `tipPlacement` — is unit-tested in `addToChat.test.ts`; the insertion channel in `compose.test.ts`; the new blockquote block in `markdown.test.ts`. The DOM half (`useAddToChat`, `AddToChatTip`) has no test: this package has no DOM environment that can drive a `Selection` (`testdom.ts` is hand-written and doesn't implement one), so it is verified by hand on the dev URL — matching how `viewstate.test.ts`/`live.dom.test.tsx` already split pure logic from real-DOM wiring elsewhere in this codebase. Card #3's review drove it in a headless Chromium (Playwright, installed outside the repo) instead of by eye, which is how the scroll-dismissal and keyboard-activation bugs above were found; nothing about that harness is committed, so the gap stands.
- A card comment composer and the decisions composer both mount through the same `LineComposer` and therefore carry the same `subscribeInsert` effect, but nothing ever calls `requestInsert` for their keys — harmless dead capacity today, and the seam a future "quote a comment" feature would reuse rather than build again.
- `blockquote` styling is a left rule on `--line` plus `--text`, so the contrast gate (`scripts/contrast.ts`) needs no new token pair.
