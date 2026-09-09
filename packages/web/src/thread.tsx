/**
 * The thread: one presentation for the board channel and the card's comments.
 *
 * Both are the same conversation shape — a run of messages from one actor, your own writes
 * answering them — so they are one set of components rather than two that drift. What each
 * screen keeps for itself is what it wraps around this: the channel fills a pane and sticks
 * to the bottom, the card page hangs a thread under the body and details and keeps its
 * question/answer/resolution rows visibly apart from ordinary talk.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { api, attachmentUrl, type Attachment } from "./api.ts";
import type { ActorKind } from "@flock/core/types";
import { ATTACHMENT_MIMES, MAX_ATTACHMENTS_PER_MESSAGE } from "@flock/core/attachments";
import { planImage } from "./images.ts";
import { MessageBody } from "./markdown.tsx";
import { useImageViewer } from "./Viewer.tsx";
import { timeAgo } from "./App.tsx";
import { clearDraft, draftKey, getDraft, saveDraft, shouldSendOnEnter, subscribeInsert, takeDroppedCount, type DraftAddress, type StagedAttachment } from "./compose.ts";
import { joinDraft } from "./addToChat.tsx";
import { hasHighlight, highlightDraft } from "./draftHighlight.ts";
import { useAutoGrow } from "./autogrow.ts";
import { focusNoScroll } from "./focus.ts";
import { ActorTap, Avatar, Icons, useHasFinePointer, useIsMobile } from "./ui.tsx";

/** One bubble's worth of thread: what both a channel message and a card comment carry. */
export interface ThreadEntry {
  id: string;
  author: string;
  authorKind: ActorKind;
  createdAt: string;
  body: string;
  attachments?: Attachment[];
}

/**
 * A just-sent message or comment, in flight or freshly confirmed, overlaid onto the fetched
 * list so an own send appears the instant `onSubmit` returns rather than waiting for the next
 * SSE-triggered refetch to bring it back (#31). Kept in the caller's own state, separate from
 * the fetched list, so a refetch never has to know about it — see `mergeThread`.
 */
export interface PendingSend<T extends ThreadEntry> {
  /** The id this send is filed under until the POST resolves and lends it a real one (see
   *  `resolvePending`) — also `entry.id` while `sending`. */
  tempId: string;
  entry: T;
  /** True from the optimistic insert until the POST resolves. Only used to dim the bubble;
   *  a failure never leaves this true — the entry is dropped instead (see `failPending`). */
  sending: boolean;
  /** What was in the field when this was sent, restored to the composer's draft store on
   *  failure alongside the field itself (`LineComposer.submit` already leaves the typed text
   *  in place on a thrown error — this is only for a caller that wants to re-stage it). */
  draftText: string;
  draftAttachmentIds: string[];
}

let tempSendSeq = 0;
/** Not a ULID — local-only, and only needs to avoid colliding with a real id (`@flock/core`'s
 *  are short base36 strings, never prefixed like this) or another temp id from the same tab. */
export function nextTempId(): string {
  tempSendSeq += 1;
  return `optimistic-${Date.now()}-${tempSendSeq}`;
}

/**
 * The list a thread actually renders: every fetched row, then any not-yet-confirmed sends
 * appended after them. A pending entry drops out the instant its id (its temp id while
 * `sending`, its real one once `resolvePending` runs) shows up in `fetched` — the point a
 * refetch has genuinely confirmed it, so keeping the overlay around would render the same
 * message twice. Until then it renders from `pending` alone, whether still in flight or
 * already carrying its real id and simply waiting on the next refetch.
 *
 * Pure so the merge — and the exact instant an id "arrives" from the reader's perspective —
 * is testable without touching React or a network.
 */
export function mergeThread<T extends ThreadEntry>(fetched: readonly T[], pending: readonly PendingSend<T>[]): T[] {
  const fetchedIds = new Set(fetched.map((e) => e.id));
  const stillPending = pending.filter((p) => !fetchedIds.has(p.entry.id));
  return [...fetched, ...stillPending.map((p) => p.entry)];
}

/** `pending` with one entry's real id and body substituted in, once its POST resolves — the
 *  `setState` updater a caller passes straight through. */
export function resolvePending<T extends ThreadEntry>(pending: readonly PendingSend<T>[], tempId: string, real: T): PendingSend<T>[] {
  return pending.map((p) => (p.tempId === tempId ? { ...p, entry: real, sending: false } : p));
}

/** `pending` with one failed entry dropped — `LineComposer.submit` already leaves the typed
 *  text and any staged images in place when `onSubmit` throws, so the optimistic row's only
 *  job on failure is to get out of the way. */
export function failPending<T extends ThreadEntry>(pending: readonly PendingSend<T>[], tempId: string): PendingSend<T>[] {
  return pending.filter((p) => p.tempId !== tempId);
}

/**
 * A run of entries from one actor under a single header: avatar and name and time on the
 * first line, then the bubbles. `mine` mirrors the whole group to the right on a tinted
 * ground — avatar, header and all (#45). Both speakers are named and faced: a thread where
 * only one side has a face reads as a log with your replies in the margin.
 * The caller decides what a run is (see `groupMessages`) and what, if anything, rides in the
 * header beside the name (`headerExtra` — the card page hangs its runtime tag there).
 */
export function ThreadGroup<T extends ThreadEntry>({
  group,
  mine,
  boardId,
  headerExtra,
  entryClass,
  entryStyle,
}: {
  group: readonly T[];
  mine: boolean;
  boardId: string;
  headerExtra?: ReactNode;
  /** Extra classes per bubble, e.g. the arrival animation's `enterClass`. */
  entryClass?: (entry: T) => string;
  entryStyle?: (entry: T) => CSSProperties | undefined;
}) {
  const mobile = useIsMobile();
  const head = group[0];
  if (!head) return null;
  return (
    <div className={`msg-group${mine ? " mine" : ""}`}>
      {/* The face is a way in to that actor's view (#49) — a bubble is where you most often
          meet an agent you cannot place — and so is the name beside it. Which is why on
          desktop only the name is a tab stop: two stops per bubble down a full channel is
          what put the composer 137 Tabs from the top bar (#17 B4). The face keeps its
          click, its label and its ring when it is reached. */}
      <Avatar name={head.author} kind={head.authorKind} size={28} quiet={!mobile} />
      <div className="msg-main">
        <div className="msg-head">
          <ActorTap name={head.author}><span className={`who ${head.authorKind}`}>{head.author}</span></ActorTap>
          {headerExtra}
          <span className="muted tiny">{timeAgo(head.createdAt)}</span>
        </div>
        {group.map((m, i) => (
          <div
            key={m.id}
            className={`msg bubble${i > 0 ? " bubble-cont" : ""}${entryClass?.(m) ?? ""}`}
            style={entryStyle?.(m)}
            title={mine ? timeAgo(m.createdAt) : undefined}
            data-msg-author={m.author}
          >
            {m.body.trim() && <ClampedBody text={m.body} />}
            {m.attachments && m.attachments.length > 0 && (
              <MessageAttachments boardId={boardId} attachments={m.attachments} author={m.author} createdAt={m.createdAt} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A long message clamps to ten lines behind a "Show more". Almost every agent post is a
 * status report whose first sentence is the payload; the rest is available, not imposed.
 * The toggle only appears when the text actually overflows, measured after layout rather
 * than guessed from character count (markdown, code blocks and lists all wrap differently).
 */
export function ClampedBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Layout, not passive (#43): a passive effect measures after the browser has painted, so
  // every long message landed once with no toggle and gained one on the next frame — 24 of
  // them at once added 672px under content already pinned to the bottom of the channel,
  // which then snapped back. Measuring before the frame is shown puts the toggles, the
  // heights and `useStickToBottom`'s re-pin (a layout effect too) in one frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured while clamped: `open` re-runs it so collapsing again keeps the toggle.
    if (open) return;
    // A link inside the body gets `padding-block` on the phone (`.msg-body a`) to grow its
    // tap target without shifting surrounding text — vertical padding on an inline element
    // doesn't push lines apart, but it does bleed past the line box, and with `overflow:
    // hidden` on this very element (the line-clamp) that bleed still counts toward
    // `scrollHeight`. A one-line message ending in a URL was reading as ~30px "taller" than
    // its `clientHeight` purely from that padding, well past the 2px slack below, and got a
    // fold button that had nothing to hide. Strip the padding for the measurement only —
    // `msg-measuring` zeroes it in CSS — so the comparison reflects the text's real layout,
    // then restore it before the next paint.
    el.classList.add("msg-measuring");
    const measuredOverflow = el.scrollHeight - el.clientHeight > 2;
    el.classList.remove("msg-measuring");
    setOverflows(measuredOverflow);
  }, [text, open]);
  return (
    <>
      <div ref={ref} className={`msg-body${open ? "" : " msg-body-clamped"}`}><MessageBody text={text} /></div>
      {overflows && (
        <button type="button" className="msg-more" onClick={() => setOpen((v) => !v)}>{open ? "Show less" : "Show more"}</button>
      )}
    </>
  );
}

/** Sent images: one image up to 320px with its box reserved, or a wrapping grid. Tapping
 *  one opens the full-screen viewer (Viewer.tsx) on that image, with the whole message's
 *  images behind it to swipe through. */
export function MessageAttachments({ boardId, attachments, author, createdAt }: { boardId: string; attachments: Attachment[]; author: string; createdAt: string }) {
  const thumbs = useRef<(HTMLElement | null)[]>([]);
  const images = useMemo(
    () => attachments.map((a) => ({ url: attachmentUrl(boardId, a.id), name: a.name, width: a.width, height: a.height })),
    [boardId, attachments],
  );
  const thumbAt = useCallback((i: number) => thumbs.current[i] ?? null, []);
  const viewer = useImageViewer({ images, author, createdAt, thumbAt });
  if (attachments.length === 0) return null;
  const single = attachments.length === 1;
  return (
    <div className={`msg-attachments${single ? " msg-attachments--single" : ""}`}>
      {attachments.map((a, i) => {
        // Only the single-attachment layout reserves a box: the grid fixes width/height to
        // 96x96 in CSS, and an inline width here would win over that and break it. With no
        // known dimensions, apply nothing — let the image size naturally.
        const known = single && a.width && a.height;
        const style = known ? { aspectRatio: `${a.width} / ${a.height}`, width: `${Math.min(a.width!, 320)}px` } : undefined;
        return (
          <button
            key={a.id}
            type="button"
            className="msg-attachment"
            ref={(el) => {
              thumbs.current[i] = el;
            }}
            onClick={() => viewer.open(i)}
            aria-label={`Open ${a.name ?? "image"}`}
          >
            <img src={attachmentUrl(boardId, a.id)} alt={a.name ?? "attachment"} width={a.width ?? undefined} height={a.height ?? undefined} style={style} />
          </button>
        );
      })}
      {viewer.node}
    </div>
  );
}


const ACCEPTED_IMAGE_TYPES: readonly string[] = ATTACHMENT_MIMES;

/**
 * The impure half of the image plan (`planImage` in images.ts is the pure half): decode the
 * file to get its real dimensions, then either pass it through as-is or downscale it onto a
 * canvas and re-encode per the plan. Runs client-side so a paste/drop/pick starts uploading
 * immediately.
 */
async function prepareUpload(file: File): Promise<{ blob: Blob; width: number; height: number; mime: string; name: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const plan = planImage({ mime: file.type, width: bitmap.width, height: bitmap.height, size: file.size });
    if (plan.action === "as-is") {
      return { blob: file, width: bitmap.width, height: bitmap.height, mime: file.type, name: file.name };
    }
    const scale = Math.min(1, plan.maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("failed to encode image"))), plan.mime, 0.8);
    });
    return { blob, width, height, mime: plan.mime, name: file.name };
  } finally {
    bitmap.close();
  }
}

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
}

/**
 * Pinned-to-bottom composer used by the channel, decisions and the card page's comments: a
 * textarea that wraps and
 * grows with its content up to a max height, then scrolls. On a device with a mouse or
 * trackpad, Enter sends and Shift+Enter inserts a newline, matching chat apps generally; on
 * a touch device (including a wide one, like an iPad in landscape) Enter inserts a newline,
 * as it does in a note, since there is no keyboard shortcut convention to match there. ⌘/Ctrl+Enter
 * always sends. `attachable` (the channel
 * and a card comment, not decisions and not Ask/Resolve) turns on paste/drop/file-pick image
 * intake: each staged image uploads immediately, tracked as uploading/ready/error, and send
 * waits for any upload in flight. The ids reach `onSubmit`, which binds them to the message or
 * comment it posts.
 *
 * One composer for all three so the field cannot end up a different shape on the card page
 * than in the channel — the mismatch caught on #41. What the card page adds it hands in
 * as `above` (its Comment / Ask / Resolve row) and `sendClass` (the amber send button for
 * Ask); the field, its radius, the chin, the attach button and the send button are the
 * channel's.
 */
export function LineComposer({
  placeholder,
  action,
  onSubmit,
  boardId,
  attachable,
  address,
  above,
  leading,
  sendClass,
  className,
  onTextChange,
  compact,
  onExpandedChange,
  onUserExpandedChange,
}: {
  placeholder: string;
  action: string;
  /** `attachments` mirrors `attachmentIds` as the full, already-uploaded objects (name,
   *  dimensions and all) — a caller building an optimistic row (#31) needs them to render a
   *  realistic thumbnail immediately rather than waiting for the confirmed entry. */
  onSubmit: (text: string, attachmentIds: string[], attachments: Attachment[]) => Promise<void>;
  boardId?: string;
  attachable?: boolean;
  /** Where this composer writes, so a half-typed message survives the sheet closing and the
   *  pane unmounting when the reader switches tabs. */
  address: DraftAddress;
  /** Rendered inside the chin, above the field. */
  above?: ReactNode;
  /** Rendered on the field's own line, before the attach button — the card drawer's mode
   *  control lives here so the chin is one row rather than two (#23). */
  leading?: ReactNode;
  /** Extra classes on the send button, e.g. `tone-warn` when the card page is asking. */
  sendClass?: string;
  /** Extra classes on the chin itself. */
  className?: string;
  /** Told what is in the field, for callers that gate something on a half-typed message. */
  onTextChange?: (text: string) => void;
  /** Card page only (#6): idle, this collapses to a single-line field and a send button —
   *  `above` and the attach control disappear rather than standing over an empty field — and
   *  restores its full shape the moment the field is focused, on the same field, so nothing
   *  remounts. It collapses back on blur only while the field is empty and nothing is
   *  staged, so a draft in progress never vanishes out from under a stray tap elsewhere.
   *  The channel and decisions composers do not pass this and are unaffected. */
  compact?: boolean;
  /** Card page only (#29 reopened): told whenever `compact`'s expanded/collapsed state
   *  changes, so a caller can hide something (the jump-to-latest button) while the composer
   *  is focused or holding a draft, and let it back once the composer collapses. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Channel only (#4): told whenever *the reasons a caller can actually control* — focus, or
   *  a non-empty draft/staged attachment — change, independent of `compact`/`expanded` itself.
   *  `expanded` above is `!compact || focused || text || staged`, which is unconditionally
   *  true on the very first render of a composer whose `compact` prop starts `false` (exactly
   *  Channel's case, since its `compact` is itself derived from scroll progress) — a caller
   *  driving that same scroll progress off `onExpandedChange` would latch its "user is
   *  editing" override permanently on that first tick and never let go (#4 reopened). This
   *  callback only ever reflects the user-driven reasons, so it starts `false` regardless of
   *  `compact`'s own initial value. */
  onUserExpandedChange?: (expanded: boolean) => void;
}) {
  const key = draftKey(address);
  const [text, setText] = useState(() => getDraft(key).text);
  const [staged, setStaged] = useState<StagedAttachment[]>(() => getDraft(key).staged);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const { ref: areaRef, resize } = useAutoGrow(text);
  // A mouse/trackpad on a wide-enough layout gets Enter-to-send, like other chat composers;
  // a touch device (any width — an iPad in landscape included) keeps Enter as a newline.
  const isMobile = useIsMobile();
  const hasFinePointer = useHasFinePointer();
  const enterSends = !isMobile && hasFinePointer;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "Add to chat" (ADR 0014): a request arrives with no reference to this component at all,
  // through `compose.ts`'s insertion channel keyed on the same `key` the draft store uses.
  // The quote appends to the end of the draft, after the blank line `joinDraft` supplies,
  // and the caret goes after it. Not at the caret: making a selection in the feed takes
  // focus off this textarea (a `mousedown` on non-focusable content blurs it), so by the
  // time a quote is picked there is no live caret in here to insert at — what
  // `selectionStart` still reports is a position the human left, or 0 once the engine has
  // reset it, and honouring it put the quote in front of a sentence they were mid-way
  // through writing (found in review, card #3).
  // The caret position to restore is stashed in a ref because `setText`'s updater runs before
  // the DOM value it computes exists to place a selection in.
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => subscribeInsert(key, (quote) => {
    setText((prev) => {
      const joined = joinDraft(prev, quote);
      pendingCaret.current = joined.length;
      return joined;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [key]);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    const el = areaRef.current;
    if (!el) return;
    focusNoScroll(el);
    el.setSelectionRange(caret, caret);
    resize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // The quote's visual treatment (ADR 0014, card #6). The quote stays ordinary text in the
  // field — that is what lets a reply be typed between two of them — and the treatment is
  // painted by a mirror layer behind a field whose own glyphs go transparent, the web's
  // answer to what nib does by colouring the `>` lines of its NSTextView directly. The
  // draft string is never rewritten, so send, drafts, autogrow and Enter-to-send are all
  // untouched, and the posted markdown is what it always was.
  //
  // The mirror only exists while the draft holds a quoted line: with nothing to paint the
  // field keeps its own visible text and this costs nothing.
  const hlLines = highlightDraft(text);
  const highlighted = hasHighlight(hlLines);
  const hlRef = useRef<HTMLDivElement>(null);
  // The mirror does not scroll itself (it has no scrollbar and no pointer events); it is
  // moved to wherever the field is scrolled to. Both on the field's own scroll and after a
  // text change, since growing past `max-height` scrolls the field without a scroll event.
  const syncScroll = () => {
    const hl = hlRef.current;
    const el = areaRef.current;
    if (hl && el) hl.scrollTop = el.scrollTop;
  };
  useEffect(syncScroll, [text, highlighted]);

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  };

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  // #1: on the phone the Channel and Decisions chin floats over its scroller rather than
  // ending it (styles.css, `.screen:has(.tabbar) .pane > .pane-foot`), so the room it takes is
  // no longer paid by the flex flow — the scroller has to reserve it as trailing padding, and
  // the "N new" pill has to sit above it. That room is not a constant: the field grows to
  // eight rows, staged image chips add a strip and a send error adds a line. So publish the
  // measured height on the parent (the `.pane`, where the CSS reads it) and let every
  // clearance derive from it. Harmless anywhere else the composer is used — the card page and
  // the desktop set the property on a box whose stylesheet never reads it.
  const footRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const el = footRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const publish = () => parent.style.setProperty("--composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      parent.style.removeProperty("--composer-h");
    };
  }, []);

  // A restored draft can have lost a staged image that had not finished uploading when the
  // tab was last written to storage (or evicted before it finished at all) — say so once,
  // rather than let the image just quietly not be there any more.
  useEffect(() => {
    const dropped = takeDroppedCount(key);
    if (dropped > 0) showNotice(`${dropped} attachment${dropped === 1 ? "" : "s"} need${dropped === 1 ? "s" : ""} re-adding.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The draft outlives this component: the sheet closing keeps it, and so does switching
  // tabs, which unmounts the pane entirely. Nothing is revoked on unmount for the same
  // reason — the store holds the previews until the message is sent or a chip is removed.
  useEffect(() => {
    saveDraft(key, { text, staged });
  }, [key, text, staged]);

  useEffect(() => {
    onTextChange?.(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const stageFiles = (files: File[]) => {
    if (!attachable || !boardId || files.length === 0) return;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - stagedRef.current.length;
    if (room <= 0) {
      showNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`);
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > accepted.length) {
      showNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message; only the first ${accepted.length} were added.`);
    }
    for (const file of accepted) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const previewUrl = URL.createObjectURL(file);
      setStaged((prev) => [...prev, { localId, previewUrl, status: "uploading" }]);
      prepareUpload(file)
        .then((prepared) =>
          api.uploadAttachment(boardId, prepared.blob, { width: prepared.width, height: prepared.height, name: prepared.name, mime: prepared.mime }),
        )
        .then((attachment) => setStaged((prev) => prev.map((s) => (s.localId === localId ? { ...s, status: "ready", attachment } : s))))
        .catch((err) => setStaged((prev) => prev.map((s) => (s.localId === localId ? { ...s, status: "error", error: (err as Error).message } : s))));
    }
  };

  const removeStaged = (localId: string) => {
    setStaged((prev) => {
      const found = prev.find((s) => s.localId === localId);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((s) => s.localId !== localId);
    });
  };

  const uploading = staged.some((s) => s.status === "uploading");
  const hasErrored = staged.some((s) => s.status === "error");
  const readyIds = staged.filter((s) => s.status === "ready" && s.attachment).map((s) => s.attachment!.id);
  const atCap = staged.length >= MAX_ATTACHMENTS_PER_MESSAGE;
  const canSend = (!!text.trim() || readyIds.length > 0) && !uploading && !hasErrored;
  // A non-compact composer (the channel, decisions) is always "expanded" — this only ever
  // reads false while `compact` is set, the field is unfocused, and there is nothing in it
  // or staged worth keeping open for.
  const expanded = !compact || focused || !!text.trim() || staged.length > 0;
  // Unlike `expanded`, never true merely because `compact` is false — see
  // `onUserExpandedChange`'s doc comment for why that distinction matters (#4 reopened).
  const userExpanded = focused || !!text.trim() || staged.length > 0;

  useEffect(() => {
    onExpandedChange?.(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  useEffect(() => {
    onUserExpandedChange?.(userExpanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userExpanded]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    const t = text.trim();
    const ids = readyIds;
    const atts = staged.filter((s) => s.status === "ready" && s.attachment).map((s) => s.attachment!);
    setSendError(null);
    try {
      await onSubmit(t, ids, atts);
      // Only clear text and staged images once the send has actually succeeded, so a
      // rejected or errored api.say never silently discards what the human typed/attached.
      setText("");
      setStaged((prev) => {
        for (const s of prev) if (ids.includes(s.attachment?.id ?? "")) URL.revokeObjectURL(s.previewUrl);
        return prev.filter((s) => !ids.includes(s.attachment?.id ?? ""));
      });
      // Reset to one row immediately; the effect above would otherwise wait for the next
      // paint, and an empty textarea should never sit tall.
      requestAnimationFrame(resize);
      clearDraft(key);
    } catch (err) {
      setSendError((err as Error).message || "Failed to send");
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, enterSends)) return;
    // preventDefault regardless of canSend, so a send-key on an empty field does nothing
    // rather than falling through to the textarea's default newline — submit() itself is a
    // no-op while canSend is false.
    e.preventDefault();
    submit();
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachable) return;
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      // Only suppress the default paste when there's no usable text alongside the image(s);
      // otherwise a paste that carries both (e.g. from a rich editor or a spreadsheet) would
      // lose its text half.
      if (!e.clipboardData.getData("text/plain")) e.preventDefault();
      stageFiles(files);
    }
  };

  const onDrop = (e: ReactDragEvent<HTMLElement>) => {
    // Always prevent the default so dropping any file (not just an image) never navigates
    // the browser away from the app and discards what was typed/staged.
    e.preventDefault();
    if (!attachable) return;
    const files = imageFilesFrom(e.dataTransfer);
    if (files.length) {
      stageFiles(files);
    } else if (e.dataTransfer.files.length) {
      showNotice("Only PNG, JPEG, GIF and WebP images can be attached.");
    }
  };
  const onDragOver = (e: ReactDragEvent<HTMLElement>) => {
    // Always prevent the default (same reasoning as onDrop) so the form stays a valid drop
    // target regardless of file type.
    e.preventDefault();
  };

  const noticeBlock = (notice || sendError) ? <div className="composer-notice" role="status">{sendError ?? notice}</div> : null;

  const chips = staged.length > 0 && (
    <div className="attach-strip">
      {staged.map((s) => (
        <div key={s.localId} className={`attach-chip attach-chip--${s.status}`}>
          <img src={s.previewUrl} alt="" />
          {s.status === "uploading" && <span className="attach-chip-spinner" aria-hidden />}
          {s.status === "error" && <span className="attach-chip-error" title={s.error}>!</span>}
          <button type="button" className="attach-chip-remove" onClick={() => removeStaged(s.localId)} aria-label="Remove attachment">
            {Icons.close(12)}
          </button>
        </div>
      ))}
    </div>
  );

  // One file input and one attach button, wherever the composer currently is: inline on
  // desktop, inside the sheet on the phone.
  const attachControls = attachable && (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        disabled={atCap}
        onChange={(e) => {
          stageFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="icon-btn"
        aria-label="Attach image"
        disabled={atCap}
        onClick={() => (atCap ? showNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`) : fileInputRef.current?.click())}
      >
        {Icons.attach(18)}
      </button>
    </>
  );

  // The same inline field on the phone as on the desktop (#34, after a detour through a
  // pill-and-sheet): the shell is sized to the visual viewport, so the field rides the
  // keyboard and the tab bar steps out from under it while a field is focused.
  const compactClass = compact ? (expanded ? " composer-expanded" : " composer-collapsed") : "";
  return (
    <form ref={footRef} className={`pane-foot${className ? ` ${className}` : ""}${compactClass}`} onSubmit={submit} onDrop={onDrop} onDragOver={onDragOver}>
      {expanded && above}
      {noticeBlock}
      {chips}
      <div className="line-composer">
        {leading}
        {expanded && attachControls}
        <div className={`composer-field${highlighted ? " has-hl" : ""}`}>
          {highlighted && (
            // `aria-hidden`: it is a picture of the textarea's own value, which a screen
            // reader already reads from the textarea.
            <div className="composer-hl" ref={hlRef} aria-hidden="true">
              {hlLines.map((line, i) => (
                <div
                  key={i}
                  className={line.quote ? `hl-line hl-quote${line.start ? " hl-quote-start" : ""}${line.end ? " hl-quote-end" : ""}` : "hl-line"}
                >
                  {line.spans.map((span, j) => (
                    <span key={j} className={span.kind === "hidden" ? "hl-hidden" : undefined}>{span.value}</span>
                  ))}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={areaRef}
            className="input textarea line-composer-input"
            rows={1}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={syncScroll}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            enterKeyHint="enter"
            data-composer
          />
        </div>
        <button type="submit" className={`icon-btn icon-btn-primary${sendClass ? ` ${sendClass}` : ""}`} disabled={!canSend} aria-label={action}>{Icons.send(18)}</button>
      </div>
    </form>
  );
}
