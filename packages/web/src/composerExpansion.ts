import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from "react";

/**
 * The phone composer's three shapes, after nib's web remote: one line at rest, an editor while
 * the keyboard is up, and optionally the editor filling the pane. Focus opens it; only the
 * keyboard going away closes it — not a tap on a control inside the composer, not the photo
 * picker taking the keyboard, not the app being backgrounded.
 */
export function useComposerExpansion(enabled: boolean) {
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  // The photo picker's sheet takes the keyboard too; that blur is not a dismissal.
  const picking = useRef(false);
  useEffect(() => {
    if (enabled) return;
    setEditing(false);
    setFull(false);
  }, [enabled]);

  const close = () => {
    setEditing(false);
    setFull(false);
  };

  return {
    editing: enabled && editing,
    full: enabled && editing && full,
    toggleFull: () => setFull((on) => !on),
    /** On the composer's root. iOS never focuses a tapped button, so a tap on the mode row or
     *  attach would blur the field with nowhere for focus to go and collapse the composer
     *  out from under the click. Holding focus on the field keeps it open. */
    holdFocus: (e: MouseEvent<HTMLElement>) => {
      if (!enabled) return;
      const target = e.target as HTMLElement;
      picking.current = !!target.closest("[data-attach]");
      if (!target.closest("textarea")) e.preventDefault();
    },
    onFocus: () => {
      picking.current = false;
      if (enabled) setEditing(true);
    },
    onBlur: (e: FocusEvent<HTMLTextAreaElement>) => {
      if (picking.current || document.hidden) return;
      if (e.currentTarget.form?.contains(e.relatedTarget as Node | null)) return;
      close();
    },
  };
}
