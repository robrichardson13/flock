# Keyboard on the desktop web board

These are web-only, so `flock help` does not carry them — that text belongs to the CLI. The
board menu ("⋯") shows the same one-line legend, and each pane glyph names its digit in its
`title`.

Everything here is desktop only (≥900px). On the phone the board is a stack of full-screen
pages with a tab bar and a "+" within reach of a thumb, and its tab order is unchanged.

## Shortcuts

| Key | Does |
| --- | --- |
| `n` | New card |
| `/` | Put the caret in the right column's composer (switching to Channel first if you are on Activity, which has nothing to say into) |
| `1` `2` `3` | Channel, Activity, Decisions |
| `Esc` | Close the topmost thing: an open popover first, then the card drawer |

Every one of them stands down while an `input`, `textarea`, `select` or `contenteditable`
has the caret, and while any modifier is held — so `⌘1` is still a browser tab and `?` is
still a question mark. They also stand down while the card drawer or a popover is open: the
drawer traps focus and has a composer of its own.

The dispatch is one pure function, `matchShortcut` in `packages/web/src/shortcuts.ts`, with
its own tests. Adding a key means adding a case there and a row here.

## Tab order

The board is wide and Tab walks it in reading order, so two things keep the count sane:

- **A face is not its own tab stop on desktop.** An avatar inside something already
  focusable — a card tile, the team stack, the identity button — or sitting beside a link to
  the same actor (a message's author name) is `tabindex="-1"`. It keeps its click, its
  `aria-label` and its focus ring; the containing control is the way in. On the phone, where
  a face is a rare deliberate target, every avatar is still a stop.
- **A skip link is the board's first stop.** Invisible until it has focus, it goes straight
  to the composer — the one place Tab cannot reach in a reasonable number of presses, since
  it sits after the whole channel.

Measured on a 17-card board with a long channel, at 1920: the pane's Channel/Activity/
Decisions buttons went from stop 29 to stop 19, and the composer from stop 137 to stop 1
(the skip link) or 89 by Tab alone.

## The card drawer is a dialog

`role="dialog"`, `aria-modal="true"`, named by the card's own heading. Opening a card moves
focus to its close button, Tab and Shift+Tab wrap inside the panel, and closing it returns
focus to the tile that opened it — captured when the drawer opens, not read off
`document.activeElement` when it closes. If the board has re-rendered that tile away in the
meantime, the tile with the same card's href gets focus instead.

The wiring is `useDialogFocus` in `packages/web/src/focus.ts`; the two decisions worth
testing (where Tab wraps, and what to focus when the opener is gone) are pure functions
beside it.
