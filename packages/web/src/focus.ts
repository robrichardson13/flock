/**
 * #13: focusing a field on the phone without letting WebKit scroll to reveal it.
 *
 * Cards #7, #9 and #10 all tried to *correct* the visual-viewport offset the keyboard opens
 * up, and all three left the phone unchanged. #11 found why from WebKit's own sources: the
 * offset is not something the keyboard does on its own — it is WebKit scrolling to reveal
 * the focused element (`WKContentViewInteraction._zoomToRevealFocusedElement`), and since
 * the page cannot scroll (html and body are `overflow: hidden` here) it slides the visual
 * viewport down inside the layout viewport instead. Everything downstream — the shell riding
 * `--vvt`, the bar's travel between the eight events iOS sends — is that reveal.
 *
 * WebKit bug 236584 (fixed r290646, shipped Safari 15.5) added a `preventScroll` flag to
 * `FocusedElementInformation` and guards the reveal on it: `el.focus({ preventScroll: true })`
 * suppresses the reveal outright. The catch is that it only applies to *scripted* focus — a
 * raw tap on an `<input>` never goes through `focus()`. So the tap has to be intercepted:
 * `pointerdown` → `preventDefault()` → focus it ourselves. This is the same lever Ionic's
 * scroll-assist pulls, by a much heavier route (focus a decoy input, scroll by hand, hand
 * focus back).
 *
 * What the interception has to preserve:
 * - the caret lands where the finger did, not at the start of the value;
 * - a tap inside a field that is *already* focused is left completely alone, so dragging a
 *   selection, moving the caret and the magnifier all behave exactly as they did;
 * - `<select>`, date/time pickers, checkboxes, files and buttons are never touched — they
 *   open their own UI and preventing their default breaks it;
 * - the desktop is untouched: mouse pointers and the wide breakpoint fall straight through.
 */

import { useEffect, useRef, type RefObject } from "react";

const PHONE = "(max-width: 899px)";

/** Input types that take a keyboard and support a text selection. */
const TEXT_INPUT_TYPES = /^(text|search|url|tel|password|email|number|)$/;

const isPhone = () => window.matchMedia(PHONE).matches;

/** Whether this element is one whose focus opens a software keyboard over the page. */
export function isTextField(el: Element | EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    // `type` normalises unknown values to "text", which is what we want.
    return !el.disabled && !el.readOnly && TEXT_INPUT_TYPES.test(el.type);
  }
  // No contenteditable in the app today; covered so one added later is not a regression.
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Focus without WebKit's scroll-to-reveal. Use this everywhere the app focuses a field
 * itself — a restored draft, the tap interception — since a programmatic `focus()`
 * triggers exactly the same reveal. For a *sheet's own autofocus on open*, use
 * `autoFocusField` instead: see why below.
 */
export function focusNoScroll(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
}

/**
 * Whether a successful send should blur the composer's field afterward.
 *
 * On a touch device the field's only job once the message is away is to hold the on-screen
 * keyboard open — there is no Enter-to-send there (`shouldSendOnEnter` in compose.ts always
 * treats Enter as a newline on a coarse pointer), so a tap on the send button is the one path
 * that fires, and e958cbd's `preventDefault` on that button's `mousedown` means nothing blurs
 * the field on its own any more. Blurring it explicitly after the send resolves is what lets
 * the keyboard slide back down, matching every native chat app. A mouse/trackpad keeps focus
 * after send exactly as it does today: `hasFinePointer` is `LineComposer`'s own
 * `useHasFinePointer()` reading, the same "coarse pointer, no hover" signal its Enter-to-send
 * decision already keys off, chosen over a width media query so a touch device at a wide
 * breakpoint (an iPad in landscape) still gets its keyboard dismissed.
 */
export function shouldBlurOnSend(hasFinePointer: boolean): boolean {
  return !hasFinePointer;
}

/**
 * #15: a sheet's autofocus, which on the phone is deliberately nothing at all.
 *
 * Every mobile engine refuses to raise the keyboard for a `focus()` that is not inside a
 * user gesture, and a sheet's autofocus never is — it runs from a timer a frame or two
 * after the sheet mounts, so the tap that opened the sheet is long over. On the phone it
 * therefore focuses a field that shows no keyboard and no caret ("Nothing focused", the
 * human's words), and it costs two things while it is at it:
 *
 * - the `focusin` it fires arms the #10 keyboard prediction (App.tsx), so `--vvh` drops to
 *   the height a keyboard *would* have left, the sheet — which is sized and anchored to
 *   `--vvh` — jumps into the top of the screen, and it stays there until the prediction
 *   times out 700ms later and it drops back. That is the "comes to the top of the screen
 *   then shoots back down" report, measured at 390x844 as 454 -> 95 -> 431.
 * - the field is now the `activeElement`, so when the human does tap it the interception
 *   below correctly leaves the tap alone (a tap inside an already-focused field is caret
 *   work) and WebKit handles it natively — with no `preventScroll`, which is the whole of
 *   the reveal that card #13 removed, back again inside sheets only.
 *
 * So on the phone the autofocus is skipped and the human's own tap does the focusing,
 * through the interception, exactly as it does for the channel composer. On desktop, where
 * a dialog that does not focus its first field is a real annoyance and there is no keyboard
 * or visual viewport in play, it is the plain scripted focus it always was.
 */
export function autoFocusField(el: HTMLElement | null | undefined): void {
  if (!el || isPhone()) return;
  focusNoScroll(el);
}

/**
 * #15: whether the code running right now is running inside a trusted user event.
 *
 * The #10 keyboard prediction is only ever right about a focus the user asked for: mobile
 * engines raise the keyboard for a scripted `focus()` only inside a gesture, so a focus
 * outside one predicts a keyboard that never comes. "Inside a gesture" is precisely "in the
 * same task as a trusted input event" — a handler runs synchronously in that dispatch, and
 * anything deferred to a timer or a promise runs in a later task. The flag is raised by a
 * capture listener ahead of every other handler and lowered by a zero-delay timer, which is
 * the first thing to run after the current task drains.
 */
let inGesture = false;
export function focusFromUserGesture(): boolean {
  return inGesture;
}

/** Where in the value the finger landed, or null if the engine will not say. */
function caretIndexAt(x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  // Standard, and what Chromium ships; for a form control it reports the index into `value`.
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) return pos.offset;
  }
  // WebKit's older spelling. Inside an input the range lands in the control's own text run,
  // so `startOffset` is the same index.
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return range.startOffset;
  }
  return null;
}

function placeCaret(el: HTMLElement, x: number, y: number): void {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    // contenteditable: the browser's own hit test is already a selection, so use it.
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = doc.caretRangeFromPoint?.(x, y);
    const sel = window.getSelection();
    if (range && sel) { sel.removeAllRanges(); sel.addRange(range); }
    return;
  }
  const hit = caretIndexAt(x, y);
  const i = hit === null ? el.value.length : Math.min(Math.max(hit, 0), el.value.length);
  try {
    el.setSelectionRange(i, i);
  } catch {
    // `email` and `number` do not support a selection at all. The caret goes wherever the
    // engine puts it, which for those one-line controls is the end.
  }
}

/**
 * Install the tap interception. Idempotent-ish: call once, from `main.tsx`.
 * Returns a teardown so a test can remove it.
 */
export function installNoScrollFocus(): () => void {
  /*
   * #14: the tap is not over when the field is focused.
   *
   * A touch on iOS leaves a *second*, synthetic gesture behind it: WebKit replays the tap
   * as `mousedown`/`mouseup`/`click` for pages written before touch existed, and it fires
   * them from the tap gesture recogniser after the tap has been recognised — some 300-500ms
   * later, which is the far end of the keyboard's slide-up. `preventDefault()` on
   * `pointerdown` does not reliably stop that replay (the Pointer Events spec exempts
   * `click` from it outright), and by the time it arrives the shell has shrunk to `--vvh`:
   * the point the finger touched is no longer over the composer, it is under the keyboard,
   * so the replayed `mousedown` lands on whatever is left there — `#root` below the shell —
   * and `mousedown`'s own default action on a non-focusable element is to blur what has
   * focus. Measured in Chromium 390x844 (#14 diag): `mousedown` on `div#root` at t+416ms,
   * `focusout` with `relatedTarget: null` one millisecond later, no `blur()` call anywhere
   * in the stack and the textarea never remounted. That is the keyboard dismissing itself
   * the instant it finishes rising.
   *
   * So the interception has to cancel the whole gesture, not just its first event. After an
   * intercepted tap, any mouse-shaped event that lands *off* the field we focused, within
   * the replay window, is that phantom: swallow it. A phone has no mouse, so the only way
   * such an event can exist is synthesis; and a genuine second touch clears the window
   * before its own replay can be mistaken for this one. An event that lands back on the
   * field is left alone — it is the harmless case, and swallowing it could break a field
   * wrapped in a label or a button.
   */
  const REPLAY_MS = 1000;
  let pending: { el: HTMLElement; until: number } | null = null;

  const openGesture = (e: Event) => {
    if (!e.isTrusted || inGesture) return;
    inGesture = true;
    setTimeout(() => { inGesture = false; }, 0);
  };

  /** Is this the synthetic tail of the tap we already handled, gone astray? */
  const isPhantom = (e: Event): boolean => {
    if (!pending) return false;
    if (performance.now() > pending.until) { pending = null; return false; }
    const t = e.target;
    return !(t instanceof Node && (t === pending.el || pending.el.contains(t)));
  };
  const swallow = (e: MouseEvent) => {
    if (!isPhantom(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "click") pending = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") { swallow(e); return; }
    // A real new touch ends the previous tap's replay window: from here on, anything
    // synthetic belongs to this tap or to nothing.
    pending = null;
    // Desktop is unchanged, in both senses: a mouse anywhere, or any pointer at the wide
    // breakpoint, falls through to the browser's own focus handling.
    if (!isPhone()) return;
    if (e.button !== 0 && e.button !== -1) return;
    const el = e.target;
    if (!isTextField(el)) return;
    // A tap inside the field that already has focus is the browser's to handle: that is
    // caret movement, selection dragging and the magnifier, and no reveal happens on it
    // because no focus change happens on it.
    if (document.activeElement === el) return;
    e.preventDefault();
    focusNoScroll(el);
    placeCaret(el, e.clientX, e.clientY);
    pending = { el, until: performance.now() + REPLAY_MS };
  };
  // #15: the gesture window, raised ahead of every other handler — this listener is
  // registered first so it runs first, since the interception below focuses the field from
  // inside its own `pointerdown` and the `focusin` that follows has to see the flag already
  // up — and dropped by a zero-delay timer at the end of the task.
  // `focusFromUserGesture()` is what App.tsx's keyboard prediction reads.
  const GESTURES = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "touchend", "keydown"] as const;
  for (const g of GESTURES) document.addEventListener(g, openGesture, true);
  // Capture, so a component that stops propagation on its own field still gets this.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("click", swallow, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("click", swallow, true);
    for (const g of GESTURES) document.removeEventListener(g, openGesture, true);
  };
}

/* ---------- the desktop dialog: focus in, trapped, and returned ---------- */

/**
 * Focus for the desktop's one modal surface: the card drawer (critique #17 B4, P2.1).
 *
 * Before this, `.drawer` was a `<div>` over a backdrop. Opening a card with Enter left focus
 * on the tile *behind* the backdrop, and six Tabs from there walked the kanban underneath
 * the modal — so the drawer's own close button, status chip, actions and composer were
 * unreachable by keyboard, and Escape handed focus back to whatever tile the drift had
 * landed on rather than the one that opened the card.
 *
 * The two decisions worth testing are arithmetic and a fallback, so they are pure functions
 * here and the hook below is only the wiring: `nextTrapIndex` decides where Tab goes when it
 * runs off either end of the dialog, and `focusReturnTarget` decides what gets focus back
 * when the dialog closes and the element that opened it may no longer exist.
 */

/**
 * Everything a browser would put in the tab order, minus what it would then skip.
 * `[tabindex="-1"]` is excluded on purpose: that is exactly the marker the redundant faces
 * wear, and a trap that stopped on them would undo the point of demoting them.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Where Tab goes next inside a dialog, wrapping at both ends.
 *
 * `current` is the index of the focused stop, or -1 when focus is outside the dialog
 * altogether — which is the state the drawer opens in, and the state a stray click on the
 * backdrop can leave behind.
 */
export function nextTrapIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return back ? count - 1 : 0;
  if (back) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

/**
 * What to focus when the dialog closes.
 *
 * The opener is captured at open — reading `document.activeElement` at close time is what
 * gave the old drawer its wrong answer — but between open and close the board refetches on
 * every SSE event, so the tile that opened the card may have been replaced or filtered out
 * of the DOM. Hence the connectedness check and the caller's selector fallback.
 */
export function focusReturnTarget<T>(
  opener: T | null | undefined,
  isConnected: (el: T) => boolean,
  fallback: () => T | null | undefined,
): T | null {
  if (opener && isConnected(opener)) return opener;
  return fallback() ?? null;
}

/** The dialog's tab stops, in document order. */
export function focusableIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // `offsetParent` is null for anything `display: none`, which is how a collapsed popover
    // and the sheets that only render on the phone stay out of the cycle.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Make `ref` a modal dialog for the keyboard: focus moves in on activation, Tab and
 * Shift+Tab wrap inside it, and on teardown focus returns to whatever had it when the
 * dialog opened (or to `fallbackSelector`, if that element has since gone).
 *
 * Off by default on the phone, where the card is a full-screen page rather than a modal and
 * there is nothing behind it to trap focus away from.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  { initialSelector, fallbackSelector }: { initialSelector?: string; fallbackSelector?: string } = {},
) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const doc = ref.current?.ownerDocument ?? document;
    opener.current = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    // One frame, so the drawer is in the DOM and laid out (its entrance transform does not
    // matter to focus, but a `display: none` ancestor would).
    const raf = requestAnimationFrame(() => {
      const host = ref.current;
      if (!host) return;
      const first = (initialSelector && host.querySelector<HTMLElement>(initialSelector)) || focusableIn(host)[0] || host;
      first.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const host = ref.current;
      if (!host) return;
      const stops = focusableIn(host);
      if (stops.length === 0) return;
      const current = stops.indexOf(doc.activeElement as HTMLElement);
      const next = nextTrapIndex(stops.length, current, e.shiftKey);
      // Always handled: at the ends this is the wrap, and in the middle it is the same stop
      // the browser would have chosen — but taking it here is what keeps focus in when the
      // dialog's last stop is followed by the whole kanban underneath.
      e.preventDefault();
      stops[next]?.focus();
    };
    doc.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      doc.removeEventListener("keydown", onKey, true);
      const target = focusReturnTarget(
        opener.current,
        (el) => el.isConnected,
        () => (fallbackSelector ? doc.querySelector<HTMLElement>(fallbackSelector) : null),
      );
      target?.focus();
      opener.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialSelector, fallbackSelector]);
}
