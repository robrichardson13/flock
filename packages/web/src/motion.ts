/**
 * The motion system's one JS mirror. Every duration and curve here matches a custom
 * property in styles.css's token block 1:1 — see the comment above `--ease-out` there for
 * what each is for. `ui.tsx` re-exports the durations (existing imports elsewhere are
 * unaffected) and `live.ts` imports straight from here; neither file may spell out a
 * duration or a cubic-bezier of its own.
 *
 * This is the fix for critique #17's B9: before it, `live.ts` had its own `FLIP_MS = 340`
 * and its own copy of `--ease-out` as a string, `ui.tsx` had a second set of constants
 * that `live.ts` didn't import, and the two had already drifted (`FLIP_MS` disagreed with
 * `--d-slow` by 20ms; `MOVE_MS` was a flat 500 against a 520ms real CSS arrival). One file,
 * and `motion.test.ts` fails if it and styles.css ever say something different again.
 */

export const EASE_OUT = "cubic-bezier(.2, .8, .2, 1)";
export const EASE_SPRING = "cubic-bezier(.34, 1.35, .64, 1)";
export const EASE_IN = "cubic-bezier(.4, 0, 1, 1)";

export const D_FAST = 150;
export const D_BASE = 220;
export const D_SLOW = 320;
/** The card FLIP's own duration (`--d-flip`): long enough to read as travel between
 *  sections, short enough not to feel slow. Kept apart from `D_SLOW` because it times an
 *  inline `transform`, not a CSS animation. */
export const D_FLIP = 340;
