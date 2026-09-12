/**
 * When to sweep this device's push notifications away because the app is in front of the person.
 *
 * PR 48 hung this off presence's `becameLooking` edge, which is the wrong signal on iOS: a
 * standalone home-screen app is *suspended*, not merely hidden, so the `visibilitychange` ->
 * hidden evaluate that would have recorded `looking: false` is not guaranteed to run. Presence
 * then still believes it is looking when the app comes back, no transition happens, and nothing
 * is dismissed. Send-suppression survives that (the server's presence TTL expires on its own
 * while the process is frozen); dismissal does not, because it needs the edge itself.
 *
 * So this module stops asking "did we transition?" and asks "is the app in front of me *now*?",
 * from every signal iOS might give us — `visibilitychange` to visible, `pageshow` (persisted or
 * not, the bfcache restore an iOS resume usually looks like), and `focus` — with a short dedupe
 * window so a resume that fires all three does the work once.
 */

/** Two signals from the same resume land within milliseconds of each other; a person cannot
 *  background and foreground the app inside this window, so anything closer is the same event. */
export const DISMISS_DEDUPE_MS = 1_500;

/**
 * Pure. `lastRunAt` is null before the first run. True when enough time has passed that this is a
 * genuinely new foregrounding rather than a second signal from the one we already handled.
 */
export function shouldDismiss(lastRunAt: number | null, now: number, windowMs = DISMISS_DEDUPE_MS): boolean {
  if (lastRunAt === null) return true;
  // A clock that went backwards (NTP step, a fake in a test) must not lock the gate shut.
  if (now < lastRunAt) return true;
  return now - lastRunAt >= windowMs;
}

/**
 * A stateful `shouldDismiss`: returns true and records the time when the caller should run, false
 * when the call is a duplicate inside the window. `now` is injectable so the window is testable
 * without sleeping.
 */
export function createDismissGate(windowMs = DISMISS_DEDUPE_MS, now: () => number = Date.now): () => boolean {
  let lastRunAt: number | null = null;
  return () => {
    const t = now();
    if (!shouldDismiss(lastRunAt, t, windowMs)) return false;
    lastRunAt = t;
    return true;
  };
}

/** The slice of the DOM this needs, so a test can hand it a fake instead of a whole document. */
export interface DismissTargets {
  doc: Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState };
  win: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Calls `run` whenever the app comes to the front, at most once per `DISMISS_DEDUPE_MS`. Returns
 * the teardown. `run` is fired synchronously from the listener and must never throw or reject —
 * it is a fire-and-forget sweep, not something anyone awaits.
 *
 * `visibilitychange` is filtered to the visible direction; `pageshow` is taken in both the
 * persisted and fresh-load forms (an iOS resume presents as either, depending on whether WebKit
 * kept the page alive); `focus` is the belt to those braces on the resumes that fire neither.
 */
export function installForegroundDismiss(
  run: () => void,
  targets: DismissTargets = { doc: document, win: window },
  gate: () => boolean = createDismissGate(),
): () => void {
  const { doc, win } = targets;
  const fire = () => {
    if (!gate()) return;
    try {
      run();
    } catch (err) {
      // Never swallowed, never propagated into an event listener: a failed sweep must not take
      // the page down, and a silent one would be exactly the bug this module exists to fix.
      console.warn("[dismiss] foreground sweep threw", err);
    }
  };
  const onVisibility = () => { if (doc.visibilityState === "visible") fire(); };
  const onPageshow = () => fire();
  const onFocus = () => fire();

  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pageshow", onPageshow);
  win.addEventListener("focus", onFocus);
  // The app may already be in front on mount — a cold launch from the Home Screen icon is the
  // single most common way the person gets here with notifications still in the tray, and it
  // fires none of the three events above.
  if (doc.visibilityState === "visible") fire();

  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onPageshow);
    win.removeEventListener("focus", onFocus);
  };
}
