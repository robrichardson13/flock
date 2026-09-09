/**
 * "Add to chat": select text inside a channel message, get a small tip that quotes it into
 * the composer. Desktop only (ADR 0014) — the trigger, placement and format are modelled
 * on nib's equivalent (`AgentTranscriptWebView.swift` / `AgentQuote`).
 *
 * Split the way the rest of this package splits DOM wiring from logic: the four pure
 * functions below (`quoteBlock`, `joinDraft`, `tipPlacement`) are unit-tested in
 * `addToChat.test.ts`; `useAddToChat` and `AddToChatTip` are the impure half, exercised only
 * by hand on the dev URL — this package has no DOM environment that can drive a Selection
 * (see `markdown.test.ts`'s sibling split for the same reasoning applied to markdown).
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Size {
  w: number;
  h: number;
}

/** How much of a selection's text a quote will hold before it truncates. A channel message
 *  is not a transcript — nib's own cap (8000) is a whole conversation's worth. */
export const QUOTE_CHAR_LIMIT = 4000;

/**
 * The formatted blockquote for `text`, or null if there is nothing worth quoting (empty or
 * whitespace-only once trimmed). Pure, and the whole of the quote format: CRLF/CR normalise
 * to LF, leading and trailing blank lines drop, every remaining line gets `> ` (a bare `>`
 * for an empty interior line), truncation at a line boundary under `limit` chars appends a
 * `> …(truncated)` line, and — when `author` is given — a `> author said:` line leads
 * the quote (no `**`: the renderer styles that line as a cite, and every hidden character
 * is dead space in the composer's own highlight — card #7). Ends in a blank line, so a caret placed right after it starts a fresh line
 * rather than continuing the quote.
 */
export function quoteBlock(text: string, author: string | null, limit: number = QUOTE_CHAR_LIMIT): string | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  let lines = normalized.split("\n");

  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  lines = lines.slice(start, end);
  if (lines.length === 0) return null;

  let truncated = false;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].length + (i > 0 ? 1 : 0);
    if (total > limit) {
      lines = lines.slice(0, Math.max(1, i));
      truncated = true;
      break;
    }
  }

  const quoted = lines.map((l) => (l.trim() === "" ? ">" : `> ${l}`));
  if (truncated) quoted.push("> …(truncated)");

  const header = author ? [`> ${author} said:`] : [];
  return [...header, ...quoted].join("\n") + "\n\n";
}

/**
 * Where a quote lands in an existing draft: as-is onto an empty draft, and after a blank
 * line onto anything else — never mid-line onto whatever the human was already typing, and
 * never merely on the next line either. A blank line is what separates the human's own
 * sentence from the quote as two blocks, both in the textarea and in the rendered message
 * (`> ` lines directly under a text line still render as their own blockquote, but they
 * read as one run of text while being typed).
 */
export function joinDraft(existing: string, quote: string): string {
  if (!existing) return quote;
  if (existing.endsWith("\n\n")) return existing + quote;
  return existing.endsWith("\n") ? existing + "\n" + quote : `${existing}\n\n${quote}`;
}

/**
 * Fixed-position placement for a tip anchored above a selection `rect`, inside `viewport`.
 * Above by `margin` when there is room; flips below the selection when there is not; both
 * axes clamp so the tip never renders off-screen.
 */
export function tipPlacement(rect: Rect, tip: Size, viewport: Size, margin = 6): { top: number; left: number } {
  let top = rect.top - tip.h - margin;
  if (top < margin) top = rect.bottom + margin;
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.h - tip.h - margin));

  let left = rect.left + rect.width / 2 - tip.w / 2;
  left = Math.min(Math.max(left, margin), Math.max(margin, viewport.w - tip.w - margin));

  return { top, left };
}

/* ---------- the impure half: watching the selection, portalling the tip ---------- */

export interface SelectionInfo {
  rect: Rect;
  text: string;
  author: string | null;
}

function nearestAuthor(node: Node | null): string | null {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    const author = el.getAttribute("data-msg-author");
    if (author) return author;
    el = el.parentElement;
  }
  return null;
}

/** The current selection, or null unless it sits entirely inside one `.msg-body` under
 *  `scope` — which is what makes a selection spanning two messages, one reaching outside the
 *  feed (into the composer, say), or a collapsed/whitespace-only one, all report nothing. */
function readSelection(scope: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (!text.trim()) return null;

  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  if (!anchor || !focus || !scope.contains(anchor) || !scope.contains(focus)) return null;

  const anchorEl = anchor instanceof Element ? anchor : anchor.parentElement;
  const focusEl = focus instanceof Element ? focus : focus.parentElement;
  const anchorBody = anchorEl?.closest(".msg-body");
  const focusBody = focusEl?.closest(".msg-body");
  if (!anchorBody || !focusBody || anchorBody !== focusBody) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const startAuthor = nearestAuthor(range.startContainer);
  const endAuthor = nearestAuthor(range.endContainer);
  // A selection that starts in one actor's bubble and ends in another's (only possible
  // through DOM ordering oddities, since a cross-bubble span is already rejected above)
  // gets no attribution rather than a misattributed one.
  const author = startAuthor && startAuthor === endAuthor ? startAuthor : null;

  return { rect, text, author };
}

/**
 * Watches the document's selection while `enabled` and reports the one currently eligible
 * for "Add to chat" — or null, which is what hides the tip. Dismisses on any scroll (rather
 * than repositioning: a selection scrolled off is honest to abandon), on a window resize,
 * on window blur and on Escape, on top of the collapse/whitespace/cross-message rejections
 * in `readSelection`.
 */
export function useAddToChat(scopeRef: RefObject<HTMLElement | null>, enabled: boolean): SelectionInfo | null {
  const [info, setInfo] = useState<SelectionInfo | null>(null);

  useEffect(() => {
    if (!enabled) {
      setInfo(null);
      return;
    }
    const onSelectionChange = () => {
      const el = scopeRef.current;
      setInfo(el ? readSelection(el) : null);
    };
    const dismiss = () => setInfo(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    // `scroll` on `document` in the capture phase, not on `scopeRef.current`: a scroll event
    // does not bubble, but it does capture, and the scroller element this hook is pointed at
    // is not the same node for the life of the hook — the pane mounts a skeleton first and
    // swaps the real scroller in when the snapshot lands, so a listener bound to whatever
    // `scopeRef.current` happened to be when this effect ran sat on a detached node and the
    // tip never dismissed on scroll at all. Capture on the document catches every scroller,
    // including the programmatic pin `useStickToBottom` performs when a new message arrives.
    document.addEventListener("scroll", dismiss, true);
    // A resize relays out the feed underneath a selection, so the rect the tip was placed
    // from is stale the moment it happens.
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      setInfo(null);
    };
  }, [scopeRef, enabled]);

  return info;
}

/**
 * The tip itself: a fixed-position button portalled to `document.body` (never inside `.pane`
 * — its crossfade/push transforms would become the containing block for `position: fixed`
 * and break the anchoring), positioned above `info.rect` via `tipPlacement`. Renders hidden
 * on the frame it (re)appears, so its own size can be measured before it is placed — a
 * `display: none` element measures zero, so this uses `visibility` instead.
 *
 * Bound on `onMouseDown` with `preventDefault()`, not `onClick`: a `mousedown` anywhere
 * collapses the browser's selection before `click` would fire, so a click handler would
 * always see an empty selection. `preventDefault` also keeps focus from moving off whatever
 * had it.
 */
export function AddToChatTip({ info, onPick }: { info: SelectionInfo | null; onPick: (info: SelectionInfo) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!info) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const size = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 0, h: 0 };
    setPos(tipPlacement(info.rect, size, { w: window.innerWidth, h: window.innerHeight }));
  }, [info]);

  if (!info) return null;
  return createPortal(
    <button
      ref={ref}
      type="button"
      className="add-to-chat"
      style={pos ? { top: pos.top, left: pos.left, visibility: "visible" } : { top: 0, left: 0, visibility: "hidden" }}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(info);
      }}
      // A button reachable by Tab (it is portalled to the end of `document.body`) that only
      // answered `mousedown` was a dead stop in the tab order. Enter and Space act here
      // instead of through `onClick`, which would double-fire after the `mousedown` above.
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onPick(info);
      }}
    >
      Add to chat
    </button>,
    document.body,
  );
}
