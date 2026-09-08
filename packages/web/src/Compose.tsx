import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Icons, Sheet, prefersReducedMotion } from "./ui.tsx";
import { focusNoScroll } from "./focus.ts";

/* ---------- the pill ---------- */

/**
 * What an inline composer becomes on the phone: a tappable pill that says what could be
 * written here, wearing the two glyphs the real composer has (attach, send) so the row
 * still reads as a composer rather than as a search field. The send glyph is deliberately
 * inert — there is nothing to send until the sheet is open.
 *
 * A draft in progress shows through, in the text colour, so a half-written message is never
 * silently lost behind a placeholder.
 */
export function ComposePill({ placeholder, draft, attachable, onOpen, tone }: {
  placeholder: string;
  draft?: string;
  attachable?: boolean;
  onOpen: () => void;
  tone?: "warn" | "ok";
}) {
  const label = draft?.trim() || placeholder;
  return (
    <button type="button" className="compose-pill" onClick={onOpen} aria-label={placeholder} aria-haspopup="dialog">
      {attachable && <span className="compose-pill-icon" aria-hidden>{Icons.attach(18)}</span>}
      <span className={`compose-pill-text${draft?.trim() ? " has-draft" : ""}`}>{label}</span>
      <span className={`compose-pill-send${tone ? ` tone-${tone}` : ""}`} aria-hidden>{Icons.send(18)}</span>
    </button>
  );
}

/* ---------- opening it with the keyboard ---------- */

const AREA_MAX_LINES = 6;
const AREA_LINE_PX = 24;
/** Two rows of padding, matching --s2 top and bottom on `.compose-area`. */
const AREA_PAD_PX = 16;
export const AREA_MAX_PX = AREA_MAX_LINES * AREA_LINE_PX + AREA_PAD_PX;

/**
 * Opens a compose sheet from a tap *with the keyboard*, which on iOS Safari means the
 * textarea has to take focus inside the handler for the tap itself: a `focus()` in an
 * effect one commit later has lost the user gesture and Safari silently declines to raise
 * the keyboard. So the state change is flushed synchronously — the sheet's portal is in the
 * document by the time `flushSync` returns — and the focus happens in the same event, one
 * statement later.
 *
 * The effect is a belt-and-braces second attempt for the paths that do not come from a tap
 * (a keyboard-driven open, a re-open while closing) and for browsers where the ref is not
 * populated yet.
 */
export function useComposeSheet(): {
  open: boolean;
  areaRef: RefObject<HTMLTextAreaElement>;
  openSheet: () => void;
  closeSheet: () => void;
} {
  const [open, setOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const openSheet = useCallback(() => {
    flushSync(() => setOpen(true));
    const el = areaRef.current;
    if (el) {
      // #13: `preventScroll` — see focus.ts.
      focusNoScroll(el);
      // Land the caret at the end of a restored draft, not at its start.
      const end = el.value.length;
      try {
        el.setSelectionRange(end, end);
      } catch {
        // Not all engines allow a selection on a textarea that is not yet laid out.
      }
    }
  }, []);
  const closeSheet = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const el = areaRef.current;
    if (el && document.activeElement !== el) focusNoScroll(el);
  }, [open]);
  return { open, areaRef, openSheet, closeSheet };
}

/* ---------- drag down to close ---------- */

const DRAG_CLOSE_PX = 90;
const DRAG_CLOSE_VELOCITY = 0.5;

/**
 * The sheet's own dismissal gesture: a drag downward from its chrome (the grip, the title,
 * anywhere that is not the textarea or a control) follows the finger and closes past a
 * distance or a flick. Pulling up does nothing, so the gesture can never lift the sheet off
 * the keyboard.
 */
function useDragDownClose(ref: RefObject<HTMLElement>, onClose: () => void, enabled: boolean) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let tracking = false;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let pointerId: number | null = null;

    const reset = () => {
      tracking = false;
      pointerId = null;
      el.style.transition = "";
      el.style.transform = "";
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const target = e.target as HTMLElement | null;
      // Anything interactive keeps its own gesture: a drag inside the textarea is a
      // selection, a drag on the mode row is a horizontal scroll.
      if (target?.closest("textarea, input, button, a, .mode-row, .attach-strip")) return;
      tracking = true;
      pointerId = e.pointerId;
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      el.style.transition = "none";
    };

    const onMove = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dy = Math.max(0, e.clientY - startY);
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;
      el.style.transform = `translateY(${dy}px)`;
    };

    const onUp = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dy = Math.max(0, e.clientY - startY);
      const close = dy > DRAG_CLOSE_PX || velocity > DRAG_CLOSE_VELOCITY;
      reset();
      // The Sheet plays its own exit from wherever the finger left it; there is no need to
      // animate the last few pixels here first.
      if (close) onCloseRef.current();
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      reset();
    };
  }, [ref, enabled]);
}

/* ---------- the shell stops moving ---------- */

/**
 * While a compose sheet is up, the phone shell stops sizing itself to the visual viewport
 * and sizes to the layout viewport instead (`--lvh`, which iOS does not shrink for the
 * keyboard). The pane behind and the tab bar then stay exactly where they were — the chin
 * is simply hidden behind the keyboard — and the only thing that moves is the sheet, which
 * is anchored to `--vvh` and so rides the keyboard's top edge.
 */
function useFrozenShell(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const before = Number(root.dataset.composing ?? 0);
    root.dataset.composing = String(before + 1);
    return () => {
      const after = Number(root.dataset.composing ?? 1) - 1;
      if (after > 0) root.dataset.composing = String(after);
      else delete root.dataset.composing;
    };
  }, [active]);
}

/* ---------- the sheet ---------- */

/**
 * The phone's composer: the app's own sheet chrome (so it springs in and out exactly like
 * every other sheet) wrapped around what the inline composer had — an auto-focused textarea
 * that grows to six lines and then scrolls, the attach button and its staged chips, an
 * optional mode row, and Send.
 *
 * Everything about *what* is being written stays with the caller: this owns the presentation
 * and the gestures, and the channel's upload flow, the card page's modes and both submit
 * paths are unchanged behind it.
 */
export function ComposeSheet({
  open,
  onClose,
  areaRef,
  value,
  onChange,
  placeholder,
  sendLabel,
  canSend,
  onSend,
  onPaste,
  modeRow,
  attachButton,
  chips,
  notice,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  areaRef: RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  sendLabel: string;
  canSend: boolean;
  onSend: () => void;
  onPaste?: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  modeRow?: ReactNode;
  attachButton?: ReactNode;
  chips?: ReactNode;
  notice?: ReactNode;
  tone?: "warn" | "ok";
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useDragDownClose(sheetRef, onClose, open && !prefersReducedMotion());
  useFrozenShell(open);

  // Grow with the content up to six lines, then let it scroll. Layout effect, so a restored
  // draft is already the right height on the frame the sheet appears on.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el || !open) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, AREA_MAX_PX)}px`;
  }, [areaRef, value, open]);

  return (
    <Sheet open={open} onClose={onClose} className="sheet-compose" sheetRef={sheetRef}>
      {notice}
      {modeRow}
      {chips}
      <textarea
        ref={areaRef}
        className="input textarea compose-area"
        rows={1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSend();
          }
        }}
        enterKeyHint="enter"
      />
      <div className="compose-actions">
        {attachButton}
        <span className="grow" />
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn btn-primary${tone ? ` tone-${tone}` : ""}`} disabled={!canSend} onClick={onSend}>{sendLabel}</button>
      </div>
    </Sheet>
  );
}
