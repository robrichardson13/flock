# ADR 0013: A board remembers the tab you left it on, and where each tab was scrolled

**Status:** accepted, 2026-09-09

## Context

Leaving a board for the boards list and coming back always landed on Cards, at the top. The panes are keyed on the tab (`key={tab}` on mobile, `key={pane}` on desktop), so a tab switch unmounts one surface and mounts the other: nothing is kept alive and hidden, and every switch starts at the top too. Two surfaces are top-anchored (Cards scrolls `.screen-body`, Decisions scrolls `.pane-scroll`) and two are bottom-anchored (Channel and Activity both scroll `.pane-scroll` under `useStickToBottom`, which pins to the bottom on mount, re-pins on new messages while the reader is at the bottom, and shows an "N new" pill when they are not).

Two route facts constrain the answer. `parseRoute` cannot tell `#/b/<slug>` from "no tab named": the Cards tab's own route *is* the bare board route (`paneHref(slug, "cards") === "#/b/<slug>"`), and the app never writes `#/b/<slug>/cards`. And boards-list rows link at `#/b/<slug>`, so the bare route is both the entry point and an in-board destination.

The app already persists five things — `flock.kbh`, `flock.brief.<slug>`, `flock.actor`, `flock.compose.<hash>`, `flock.snap.<v>.<key>` — all in localStorage, all `try`/`catch`ed on every access, all treated as a cache the UI works without.

## Decision

### Storage: localStorage, with staleness handled by a TTL rather than by the store's lifetime

`sessionStorage` was the working assumption, on the reasoning that a scroll offset from last week is noise. The reasoning is right and the medium is wrong. sessionStorage's lifetime does not track content staleness — a phone PWA tab lives for weeks — while it does introduce a second persistence idiom, and it splits the remembered offset from the `flock.snap` cache that provides the synchronous first paint the restore has to ride on. So: localStorage, matching the idiom, and the staleness is stated outright.

- The **remembered tab has no TTL**. Which surface of a board you read is a preference, and it is as right a week later as it is a minute later.
- **Remembered offsets expire after 8 hours** (`SCROLL_TTL_MS`), one working session. Past that the tab still restores and the surface opens at its natural resting position — top for Cards and Decisions, bottom for Channel and Activity.

### Key shape

One record per board, at `flock.view.1.<slug>`, alongside `flock.brief.<slug>`:

```ts
{ tab: BoardTab, at: number, scrollAt?: number, scroll: { cards?: number, channel?: Pos, activity?: Pos, decisions?: number } }
type Pos = { y: number; bottom: boolean }
```

`at` is when the record was last written and drives the 50-key prune. `scrollAt` is when an
offset was last written and is the only clock `SCROLL_TTL_MS` reads. They are separate because
the tab has no TTL and `rememberTab` fires on entry and on every tab the router settles on: a
single shared timestamp meant walking into a board refreshed the offsets' age too, so a
nine-hour-old offset came back to life for the rest of the session. A record without `scrollAt`
predates the split and falls back to `at`, so the version does not have to move.

Slots are named by surface, not by tab, so a surface that is not a tab can be added without reshaping the record. `kanban` is reserved and deliberately unwritten: the desktop kanban never unmounts on a pane switch, scrolls on a different axis from the mobile Cards list, and would collide with the `cards` slot at the same key across a window resize.

The `1` is a schema version, swept the way `flock.snap` sweeps: on first use, drop every `flock.view.` key that does not carry the current prefix. Growth is bounded on write — when the count of `flock.view.1.` keys exceeds 50, drop the oldest by `at`. Per-board keys rather than one map keyed by slug, so two browser tabs on two different boards cannot clobber each other's record through a stale read; two tabs on the *same* board are last-writer-wins, which is what the brief disclosure and the composer drafts already do.

### Entry rewrites the hash, and only on entry

Returning to a board **rewrites the hash** to the remembered tab through `history.replaceState`, rather than rendering a remembered tab under the bare route. Rendering it under the bare route breaks two things: the URL stops describing the screen, and tapping Cards from Channel sets the hash to `#/b/<slug>` — the value it already holds — which fires no `hashchange`, leaving the reader stuck on Channel.

`replaceState` and not `location.hash =`: assigning pushes a history entry, so Back would step from `#/b/<slug>/channel` to `#/b/<slug>`, which redirects forward again — a trap. With `replaceState` the entry the boards row pushed is edited in place, so **Back from a restored board goes to `#/`, the boards list**, exactly as it does today. `replaceState` fires no `hashchange`, so the rewrite and the router's own `setHash` happen in the same tick.

The rewrite is gated on **entering** the board, not on the hash's shape: it fires only when the board slug being rendered differs from the previously rendered one (including the first render, where there is no previous). Without that gate, an in-board switch to Cards — which writes the bare route — would be read as a fresh entry and bounce the reader back to the tab they just left. The tab change writes `tab` to the record synchronously, so the *next* real entry restores Cards.

The check is one pure function in `packages/web/src/viewstate.ts`, applied by a hook beside `useHash` in `App.tsx`:

```ts
/** The hash the app should be on instead, or null to leave it alone. */
export function entryRedirect(hash: string, prevBoard: string | undefined, remembered: (slug: string) => BoardTab | null): string | null
```

It returns null unless the hash matches `/^#\/b\/([^/]+)\/?$/`, the slug differs from `prevBoard`, and the remembered tab is something other than `cards`.

### An explicit URL always wins

`entryRedirect` matches only the bare board route, so `#/b/<slug>/c/<n>`, `#/b/<slug>/a/<actor>`, `#/b/<slug>/channel` and the never-app-written-but-valid `#/b/<slug>/cards` all pass through untouched. That single regex is the whole enforcement point; there is no second place to keep in step.

A card and an actor route carry no tab, and closing them already falls back to `lastTab`. On a *cold* entry straight onto one of those routes there is no last tab, so `lastTab` seeds from the remembered tab — the same "no tab in the URL, use the remembered one" rule, applied where the URL genuinely has no opinion.

### Restoring without fighting the bottom pin

Channel and Activity persist `{ y, bottom }`, where `bottom` is `useStickToBottom`'s own `atBottom` ref at write time.

- `bottom: true` — the overwhelmingly common case — **restores nothing**. The hook pins to the bottom on mount and keeps re-pinning as messages arrive, which is what "where I left off" means for a live log.
- `bottom: false` restores `y` *and* starts the hook unstuck, so the "N new" pill appears on arrival exactly as if the reader had scrolled up by hand.

The hook owns `stuck`, so the hook owns the restore: `useStickToBottom(ids, { slack?, restoreTop?: number | null })`. When `restoreTop` is a number it sets `stuck.current = false` and `first.current = false` before the first layout effect and applies the offset there. `first.current = false` is load-bearing — left true, the first batch of new messages would increment no pill. Restoring from outside the hook by poking the returned ref would run in the wrong layout-effect order and let the mount pin win.

Cards and Decisions store a bare `number` and restore it directly.

### Surviving a refetch, and an offset that no longer exists

Restore is a **clamped one-shot with a short settling window**, owned by whichever component mounts the scroll element:

1. In a `useLayoutEffect` on mount, apply `el.scrollTop = Math.min(y, el.scrollHeight - el.clientHeight)` — before paint, so there is no visible jump.
2. If the clamp landed short of `y`, keep a `ResizeObserver` on the container and its children and re-apply the clamped value as content grows (a late-sizing image, a font, the real snapshot replacing a cached one).
3. Close the window — disconnect, and never restore again for this mount — on the first of: the applied value reaching `y`; any scroll event the restore did not cause; `RESTORE_WINDOW_MS` (1000 ms) elapsing.

That is what makes a coalesced refetch safe rather than something to defend against. `useCoalescedRefetch` replaces `snap` but does not unmount `.pane-scroll` or `.screen-body`, so the browser keeps `scrollTop` and no restore is attempted: the window has closed. Only a mount restores.

Content that shrank below the remembered offset needs no special case — the clamp lands at the new maximum, and the window times out. Content that now fits its container clamps to 0.

Writes happen on **unmount** (the cleanup of the same layout effect, covering a tab switch, leaving the board, and opening a card) and on **`pagehide`** plus `visibilitychange → hidden` (covering a reload and an app switch, neither of which unmounts). Not on scroll. A process killed without `pagehide` loses the last offset, which costs one scroll.

The layout effect is load-bearing, not incidental. React 18 runs a deleted subtree's layout destroys in the mutation phase, before it detaches host refs, but defers its passive destroys until *after* the mutation phase has already set `ref.current = null`. An exit-writer in a passive `useEffect` therefore reads a null ref and writes nothing on any unmount — leaving `pagehide` as the only writer, so one backgrounding while scrolled up freezes a `bottom: false` offset that yanks the reader on every later visit. The first implementation of this ADR did exactly that on the bottom-anchored panes. Because the difference is invisible to a pure test, both hooks are mounted and unmounted for real in `packages/web/src/live.dom.test.tsx`, against the hand-written DOM in `testdom.ts`.

Both surfaces reach the settling window through one shared `settleRestore(el, y, windowMs)`, which returns a `RestoreWindow` (`{ release, settled }`) rather than a bare disposer. `useStickToBottom`'s own growth observer cannot stand in for it: `repinOnGrow` is gated on `stuck`, which a restore has just set false by design.

An unmount that lands *during* the settling window is a write hazard the clamp alone does not solve: `el.scrollTop` at that moment is the short clamp from a not-yet-grown pane, not the offset that was actually remembered, and writing it would overwrite a good stored offset with a worse one. The exit-writer checks `settled()` and skips the write while it is still `false`, leaving the store as it was; a later exit (the next `pagehide`, or a later unmount once the pane has had time to grow) writes the right value. For the same reason the window's `release()` is called from inside the same layout-effect cleanup as the write — never a neighbouring passive effect — and only after `write()` has run: a passive cleanup runs after React has already nulled the ref, so it could not close the window before the write needed to see whether it had settled, which is the same ordering hazard the layout-effect requirement above already exists to avoid.

## Consequences

- Retention is entirely client-side: no schema change, no core rule, no CLI or server surface. It is a cache — every access `try`/`catch`ed, every reader correct when it returns nothing (private mode, a cleared store, a first visit).
- A bookmark of `#/b/<slug>` now opens on the remembered tab rather than always Cards. `#/b/<slug>/cards` is the route that pins Cards, and it already parses.
- The URL always names the surface on screen, so a link copied out of a restored board is a link to what the sender was looking at.
- The desktop kanban's scroll is not retained. The slot exists if that turns out to matter.
- A record for a deleted board is *not* inert: `entryRedirect` reads it, so `#/b/<gone>` would keep redirecting and a slug reused later would inherit the dead board's tab and offsets. `BoardView` drops the record on a 404, beside the snapshot cache it already clears there.
- The pure parts are unit-testable and are what the tests should cover: `entryRedirect`, the record's read/write/prune, and the TTL. Scroll pixels are not.
