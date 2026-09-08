/**
 * The desktop board's keyboard shortcuts, as one pure function (critique #17 B4, P2.1).
 *
 * A kanban is a wide page, and Tab walks it in reading order: the pane's own controls and
 * its composer sit past every tile and every message. Demoting the redundant faces to
 * `tabindex="-1"` fixes the first half of that; this is the second — the few single-key
 * verbs that jump straight to the thing, the way a mail client's `c` and `/` do.
 *
 * The dispatch is a pure match over a key event's shape so it can be tested without a DOM
 * and without React: the hook that owns the listener does nothing but call this and act on
 * what comes back.
 *
 * Deliberately not a chord: every one of these is a bare letter or digit, so the two
 * guards below are what keep them out of the way. A modifier means the browser or the OS
 * owns the keystroke (⌘1 is a browser tab, ⌥/ is a character), and a typing target means
 * the reader is writing, where `n` is a letter and nothing else.
 */

export type BoardPane = "channel" | "activity" | "decisions";

export type Shortcut =
  | { kind: "new-card" }
  | { kind: "focus-composer" }
  | { kind: "pane"; pane: BoardPane };

/** The parts of a KeyboardEvent this decision reads. A plain object in the tests. */
export type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: TargetLike | null;
};

/** The parts of an EventTarget this decision reads. */
export type TargetLike = {
  tagName?: string;
  isContentEditable?: boolean;
  /** A `<div contenteditable>` in a DOM that does not implement `isContentEditable`. */
  getAttribute?: (name: string) => string | null;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Is the keystroke going into a field? Then it is text, not a command.
 *
 * `contenteditable` is checked two ways because `isContentEditable` is a live property the
 * browser computes (and inherits into children), while the attribute is what a test fixture
 * can hand over.
 */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const editable = target.getAttribute?.("contenteditable");
  if (editable != null && editable !== "false") return true;
  return TYPING_TAGS.has(String(target.tagName ?? "").toUpperCase());
}

/** Any modifier means the keystroke belongs to the browser or the OS, not to the board. */
export function hasModifier(e: KeyLike): boolean {
  return !!(e.ctrlKey || e.metaKey || e.altKey);
}

const PANE_KEY: Record<string, BoardPane> = { "1": "channel", "2": "activity", "3": "decisions" };

/**
 * The shortcut this keystroke asks for, or null when it asks for nothing.
 *
 * `/` is the one key that is also punctuation, and it is the one people expect: it is the
 * search-and-say key everywhere from Gmail to GitHub, and here it puts the caret in the
 * board's composer without walking the channel to get there.
 */
export function matchShortcut(e: KeyLike): Shortcut | null {
  if (hasModifier(e)) return null;
  if (isTypingTarget(e.target)) return null;
  // Shift is allowed only where the key needs it on some layout; none of these do, and
  // letting it through would make `?` (Shift-/) focus the composer.
  if (e.shiftKey) return null;
  if (e.key === "n" || e.key === "N") return { kind: "new-card" };
  if (e.key === "/") return { kind: "focus-composer" };
  const pane = PANE_KEY[e.key];
  if (pane) return { kind: "pane", pane };
  return null;
}

/** What the ⋯ menu and `docs/web-shortcuts.md` say, in one place. */
export const SHORTCUT_HINT = "n new card · / composer · 1-3 panes";
