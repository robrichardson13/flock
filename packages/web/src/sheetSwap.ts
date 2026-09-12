/**
 * How long a sheet wears its crossfade classes (card 41).
 *
 * The roster and the actor view are two depths of one panel, so when one replaces the other
 * neither slides — `BoardView.swap()` raises a `swapping` flag for one `D_BASE` window and
 * both sheets wear it, which swaps their slide for a crossfade (`.sheet-swapped` in
 * styles.css).
 *
 * The flag is a *moment*, but the sheet it dressed stays on screen long after that moment has
 * passed, and that mismatch was the bug. Dropping a class that names an animation changes the
 * element's computed `animation-name`, and a browser restarts an animation whenever its name
 * changes — so taking the class off a sheet that had already settled replayed its *base*
 * entry animation: the desktop panel slid in from the right a second time, the phone's sheet
 * rose from 40px a second time, both about 70ms after the crossfade had finished (the swap
 * runs at `--d-fast` = 150ms, the flag is held for `D_BASE` = 220ms). That is the "it
 * re-appears" this fixes. styles.css documents the same trap for `animation: none` releases.
 *
 * So the class is latched instead: decided when the sheet arrives, kept until it is gone.
 * The exit is a second, separate class for the same reason — it is decided once, at the
 * moment the close begins, rather than following a flag that expires mid fade.
 */

/**
 * Whether this sheet's arrival was a swap, held for as long as it is on screen. `prev` is the
 * latched value from the last render; a sheet that is neither open nor still playing its
 * close is gone, so the next opening starts clean.
 */
export function latchSwapIn(prev: boolean, open: boolean, mounted: boolean, swap: boolean): boolean {
  if (!open && !mounted) return false;
  return prev || (open && swap);
}

/** The backdrop's class list: one entry latch, one exit latch, and `closing` itself. */
export function sheetBackdropClass(state: { closing: boolean; swappedIn: boolean; closeSwap: boolean }): string {
  return [
    "sheet-backdrop",
    state.closing ? "closing" : "",
    state.swappedIn ? "sheet-swapped" : "",
    state.closeSwap ? "sheet-swap-out" : "",
  ].filter(Boolean).join(" ");
}
