import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, getActorName, type Card, type CardStatus, type Comment } from "./api.ts";
import { type ActorRuntimes } from "./BoardView.tsx";
import { Markdownish, MessageBody } from "./markdown.tsx";
import { agoText, timeAgo } from "./App.tsx";
import { enterClass, useNewIds } from "./live.ts";
import { threadChunks } from "./grouping.ts";
import { ClampedBody, failPending, hasReaction, LineComposer, mergeThread, MessageReactions, nextTempId, resolvePending, ThreadGroup, type PendingSend } from "./thread.tsx";
import { buildDetailRows, type DetailRow } from "./details.ts";
import { autoFocusField, useDialogFocus } from "./focus.ts";
import { readSnapshot, snapKey, writeSnapshot } from "./snapshot.ts";
import { useTopBarSlot } from "./TopBar.tsx";
import { ActionSheet, AnchoredMenu, Avatar, D_FAST, Icons, prefersReducedMotion, RuntimeTag, Sheet, STATUS_LABEL, StatusIcon, useAnyOverlayOpen, useEdgeSwipeBack, useIsMobile, usePrompt, type SheetAction } from "./ui.tsx";

const STATUSES: CardStatus[] = ["todo", "doing", "awaiting-human", "done", "wontfix"];

/** What a card caches between visits: the half of the page the board snapshot does not carry. */
interface CardSnapshot { comments: Comment[]; blocks: number[] }
type Mode = "comment" | "ask" | "resolve";

/** A card. Full-screen page on phones, right-hand drawer on desktop. */
export function CardPage({ boardId, boardSlug, card, allCards, actors, onChange, onClose, closing: pushClosing, atRest }: {
  boardId: string; boardSlug: string; card: Card; allCards: Card[]; actors: ActorRuntimes; onChange: () => void;
  /** `instant` says the page is already off the screen (the edge-swipe animated it there
   *  itself), so the board should not play the exit a second time. */
  onClose: (instant?: boolean) => void;
  /** Set by the board while the page plays its exit push; the board is sliding back at the
   *  same time, and the route only changes once both have finished. */
  closing?: boolean;
  /** The page was already on screen when the board arrived — a reload straight onto a card
   *  URL, where the skeleton drew it first. It is not entering, so it does not push: see the
   *  `coldCard` note in BoardView and `.page.at-rest` in styles.css. */
  atRest?: boolean;
}) {
  const mobile = useIsMobile();
  const prompt = usePrompt();
  // The card's own facts come down with the board snapshot, so a seeded board already paints
  // the title, body and details. Its thread does not, and used to arrive a round trip later
  // under everything else — so it is cached per card and read synchronously too (#43).
  const [seed] = useState(() => readSnapshot<CardSnapshot>(snapKey.card(boardSlug, card.num)));
  const [comments, setComments] = useState<Comment[] | null>(seed?.comments ?? null);
  const [blocks, setBlocks] = useState<number[]>(seed?.blocks ?? []);
  // #31: own comments are optimistic — a submit lands here immediately, rendered by
  // `mergeThread` right after `comments`, rather than waiting on `reload()`'s round trip.
  // Cleared (per entry) once the confirmed row it stands in for comes back in `comments`.
  const [pendingComments, setPendingComments] = useState<PendingSend<Comment>[]>([]);
  // Set (and consumed) around an optimistic insert so the layout effect below knows to jump
  // the thread to the bottom for it — never for an ordinary refetch bringing someone else's
  // comment in, which must leave the reader's scroll position alone.
  const scrollToLatestOnGrow = useRef(false);
  // LineComposer owns the field and its draft; the page only keeps what is in it, to know
  // whether the edge-swipe back should be armed.
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("comment");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const [blockerMenu, setBlockerMenu] = useState<number | null>(null);
  // The three Details rows that lead somewhere: each opens the flow that used to hang off a
  // chip or the overflow menu.
  const [labelsSheet, setLabelsSheet] = useState(false);
  const [blockedBySheet, setBlockedBySheet] = useState(false);
  const [blocksSheet, setBlocksSheet] = useState(false);
  // The reopen sheet holds the target status while it's open (todo or doing) rather than a
  // plain boolean, since Move-to can reopen straight into either.
  const [reopenSheet, setReopenSheet] = useState<CardStatus | null>(null);
  const me = getActorName();
  const shownComments = mergeThread(comments ?? [], pendingComments);
  const newComments = useNewIds(shownComments.map((c) => c.id), comments !== null);
  const sendingCommentIds = new Set(pendingComments.filter((p) => p.sending).map((p) => p.entry.id));
  const pageRef = useRef<HTMLDivElement>(null);
  // #29: a small floating "jump to latest" button, mobile only. `scrollerRef` is the
  // scrolling `.screen-body.card-body` itself (the observer's root and the scrollTo target);
  // `bottomSentinelRef` sits right after the thread, so the observer reports whether the
  // newest comment is actually in view rather than just "near" it; `composerWrapRef` wraps
  // the composer purely to measure its rendered height, so the button can float just above
  // it (mode row, attach strip and all) without hard-coding a composer height that drifts.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const [bottomHidden, setBottomHidden] = useState(false);
  // #29 reopened: starting a comment (the field focused, or already holding a draft) always
  // put the button over the very composer the human just opened to type into. `LineComposer`
  // already knows this as its own `expanded` state (compact + focused/non-empty/staged); it
  // is lifted here via `onExpandedChange` so the button can fold that in without duplicating
  // the focus/draft/staged tracking a second time.
  const [composerExpanded, setComposerExpanded] = useState(false);
  const showJump = bottomHidden && !composerExpanded;
  const [composerH, setComposerH] = useState(0);
  const noSheetOpen = !menu && !moving && !editing && blockerMenu === null
    && !labelsSheet && !blockedBySheet && !blocksSheet && !reopenSheet && !text.trim();
  // The gesture has already carried the page off screen by the time it fires, so it closes
  // instantly rather than handing back to the exit animation.
  const swipeClose = useCallback(() => onClose(true), [onClose]);
  useEdgeSwipeBack(pageRef, swipeClose, mobile && noSheetOpen);
  const overlayOpen = useAnyOverlayOpen();
  // Desktop drawer gets a brief exit animation (mobile already has its own via the edge-swipe
  // gesture, so this only delays the real onClose when we are not mobile).
  const [closing, setClosing] = useState(false);
  // The drawer is a modal dialog (#17 B4). Before this it was a bare div over a backdrop:
  // opening a card with Enter left focus on the tile *behind* the scrim, and Tab from there
  // walked the kanban underneath — the close button, the status chip, the actions and the
  // composer were all keyboard-unreachable. `useDialogFocus` moves focus in, wraps Tab and
  // Shift+Tab inside the panel, and on unmount hands focus back to the tile captured at
  // open (falling back to the tile's own href if the board has re-rendered it away).
  const drawerRef = useRef<HTMLDivElement>(null);
  const headingId = `card-dialog-title-${card.num}`;
  useDialogFocus(drawerRef, !mobile, {
    initialSelector: ".panel-close",
    fallbackSelector: `a.card-tile[href$="/c/${card.num}"]`,
  });
  const handleClose = () => {
    if (mobile) { onClose(); return; }
    setClosing(true);
    setTimeout(onClose, D_FAST);
  };

  // On a phone the bar over this page is the shell's, mounted once above the push stack
  // (TopBar.tsx), so the page lends it the two controls that are the card's: the overflow
  // menu, and the way back — which is `handleClose`, not the href, because the board owns
  // the exit and slides back in as the page leaves. The desktop drawer is a dialog, not the
  // app bar, so it keeps the `card-topbar` below and lends nothing.
  // Just the number: the full title already has exactly one home, the heading below
  // (`.card-heading`). A second copy up here duplicated it and, unbounded, could run the
  // whole bar off the screen on a long title — "#n" never does either.
  // Yielded the instant `pushClosing` goes true, rather than only on unmount: the board owns
  // the exit and holds the route on a card segment for the length of the animation
  // (`cardClosing` in BoardView.tsx), so without this the bar would sit on "#n" and the back
  // chevron until the page actually leaves the tree. Releasing the slot here drops `titles.card`
  // straight away, and `TopBar`'s `topBarShape` reads that instead of the still-stale route —
  // the bar falls back to the board's own slot (always registered, same content on every tab)
  // the moment the close starts, which is every other transition's timing already.
  useTopBarSlot("card", mobile && !pushClosing ? { onCardMenu: () => setMenu(true), onCardBack: handleClose, title: `#${card.num}` } : null);

  const reload = async () => {
    const r = await api.card(boardId, card.num);
    setComments(r.comments);
    setBlocks(r.blocks);
    writeSnapshot(snapKey.card(boardSlug, card.num), { comments: r.comments, blocks: r.blocks });
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, card.num, card.updatedAt]);

  // Toggle a reaction on a comment, then reload right away rather than waiting on the next
  // SSE-triggered refetch — the same "own click reads as janky if it waits" reasoning as the
  // channel's `toggleReaction` in BoardView.tsx. A failed toggle just leaves the chip as it
  // was; the next reload reconciles it either way.
  const toggleCommentReaction = async (commentNum: number, emoji: string, mine: boolean) => {
    try {
      if (mine) await api.unreactFromComment(boardId, card.num, commentNum, emoji);
      else await api.reactToComment(boardId, card.num, commentNum, emoji);
      onChange();
      reload();
    } catch {
      // best-effort; the chip reconciles on the next refetch either way
    }
  };

  // #29: show the jump button only while the newest comment is actually scrolled out of
  // view. The sentinel sits just past the thread, so a card whose whole page already fits
  // the screen never has anything to intersect away from — the observer's first callback
  // fires with it already on screen, `showJump` never flips true, and the button never
  // renders. No comments at all skips the observer entirely.
  useEffect(() => {
    if (!mobile || shownComments.length === 0) { setBottomHidden(false); return; }
    const root = scrollerRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(([entry]) => setBottomHidden(!entry.isIntersecting), { root, threshold: 0 });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [mobile, shownComments.length, comments]);

  // The composer's own height moves (idle one-liner vs. focused with the mode row and any
  // attach strip), so the button's clearance above it is measured rather than assumed. A
  // layout effect measures once, synchronously, before the browser paints — the button's
  // first frame is already clear of the composer instead of sitting on top of it for a tick
  // until the ResizeObserver's own (also async) first callback lands.
  useLayoutEffect(() => {
    if (!mobile) return;
    const el = composerWrapRef.current;
    if (!el) return;
    setComposerH(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(([entry]) => setComposerH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile]);

  const scrollToLatest = () => {
    const root = scrollerRef.current;
    if (!root) return;
    root.scrollTo({ top: root.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  // #31: an own comment jumps straight to the bottom, instantly — never the jump button's
  // smooth flight, which would read as lag for a row the reader just wrote themselves.
  // `scrollToLatestOnGrow` is armed in the optimistic insert below and consumed here, once
  // the new row has actually committed to the DOM and `scrollHeight` accounts for it; it is
  // never armed for a comment arriving from elsewhere, so those never move the reader.
  useLayoutEffect(() => {
    if (!scrollToLatestOnGrow.current) return;
    scrollToLatestOnGrow.current = false;
    const root = scrollerRef.current;
    if (root) root.scrollTop = root.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownComments.length]);

  useEffect(() => {
    // Any open sheet (menu, moving, label/blocker, or the PromptProvider's prompt)
    // handles its own Escape; the page itself must stay open while one is up.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !overlayOpen && handleClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, overlayOpen, mobile]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      onChange();
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveEdit = () =>
    act(async () => {
      await api.updateCard(boardId, card.num, { title: title.trim() || card.title, body });
      setEditing(false);
    });
  const cancelEdit = () => { setEditing(false); setTitle(card.title); setBody(card.body); };
  const openEdit = () => setEditing(true);
  // #25: the mobile edit sheet's own field, focused the same way every other sheet's first
  // field is (`autoFocusField` in focus.ts) — nothing on the phone, since a sheet's
  // autofocus never runs inside the tap that opened it and would only steal the keyboard
  // prediction from the human's own tap; a plain scripted focus on desktop, where this sheet
  // never actually mounts (desktop keeps its inline form below).
  const editTitleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || !mobile) return;
    const id = setTimeout(() => autoFocusField(editTitleRef.current), 50);
    return () => clearTimeout(id);
  }, [editing, mobile]);

  // Core owns the line rewrite, so a tick sends the item's index, not a new body:
  // two people ticking different items on the same card cannot clobber each other.
  const toggleTask = (index: number, checked: boolean) => act(() => api.toggleTask(boardId, card.num, index, checked));

  /** Whoever holds the card, for the assignee chip's shape and model suffix. */
  const holder = card.assignee ? actors.get(card.assignee) : undefined;

  const addLabel = async () => {
    const l = await prompt({ title: "Add label", placeholder: "e.g. wayfinder:grilling", submit: "Add label" });
    if (l) act(() => api.updateCard(boardId, card.num, { addLabels: [l] }));
  };
  const addBlocker = async () => {
    const n = await prompt({ title: "Blocked by", placeholder: "Card number", inputMode: "numeric", submit: "Add blocker", hint: "This card stays blocked until that one closes." });
    const num = Number(n?.replace("#", "").trim());
    if (num) act(() => api.block(boardId, card.num, num));
  };
  // Reopening a closed card always asks why: what's still not done, or why the same or a
  // related change is coming back. The reason lands as a comment on the card, so the ask
  // uses the same composer as the channel and the comment thread (#13 reopened) rather than
  // the plain-input usePrompt sheet: attach icon and send button inline, height that grows
  // as it wraps.
  const reopen = (status: CardStatus) => setReopenSheet(status);
  const reopenReason = async (t: string, attachmentIds: string[]) => {
    if (!reopenSheet) return;
    await api.move(boardId, card.num, reopenSheet, t, attachmentIds);
    setReopenSheet(null);
    onChange();
    reload();
  };

  const closed = card.status === "done" || card.status === "wontfix";
  const mine = card.assignee === me;

  // Move to, Add label and Add blocker each have a row of their own in Details now, and the
  // row says the current value while it offers the change. What is left here is what has
  // nowhere else to live.
  // On the phone the overflow menu is the only way back from a closed card. In the drawer
  // Reopen is the header's primary action (#23), so it is not also an item here — the two
  // buttons sat four inches apart saying the same word.
  const menuActions: SheetAction[] = [
    { label: "Edit title and description", icon: Icons.edit(18), onSelect: () => setEditing(true) },
    ...(closed && mobile ? [{ label: "Reopen", icon: Icons.undo(18), onSelect: () => reopen("todo") }] : []),
  ];
  const moveActions: SheetAction[] = STATUSES.map((s) => ({
    label: STATUS_LABEL[s],
    icon: <StatusIcon status={s} size={18} />,
    disabled: s === card.status,
    // Closed → todo/doing is a reopen and needs a reason; every other move goes straight through.
    onSelect: closed && (s === "todo" || s === "doing") ? () => reopen(s) : () => act(() => api.move(boardId, card.num, s)),
  }));

  // Desktop still edits title and description inline, in place, under the drawer's own
  // heading (unchanged by #25). The phone opens the same "Edit card" sheet the brief editor
  // uses instead — see the sheet rendered with the other mobile-only sheets below — reached
  // only from the top bar's overflow menu ("Edit title and description"), not from tapping
  // the title or body themselves: the human tried tap-to-edit and asked for it back out, so
  // on the phone the heading and body are plain, non-interactive content.
  const titleBlock = !mobile && editing ? (
    <div className="stack">
      <input className="input input-lg" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="textarea" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Description, in markdown" />
      <div className="row gap end">
        <button className="btn btn-ghost" onClick={cancelEdit}>Cancel</button>
        <button className="btn btn-primary" onClick={saveEdit}>Save</button>
      </div>
    </div>
  ) : (
    <>
      {/* The number moved into the nav title on the phone (TopBar.tsx) and is already in the
          drawer's own header (`.panel-num`) on desktop — it no longer needs a line of its own
          here, which used to read as a stray "#6" floating above the heading. */}
      <h1 className="card-heading" id={headingId}>{card.title}</h1>
      {card.body.trim() ? (
        <Markdownish text={card.body} onToggleTask={toggleTask} />
      ) : mobile ? (
        <p className="muted">No description.</p>
      ) : (
        <button className="linkish muted" onClick={openEdit}>Add a description</button>
      )}
    </>
  );

  // The card's own facts, as one iOS grouped-inset list rather than three chip rows in three
  // idioms. Every row leads to the flow that already existed: Status to the Move sheet,
  // Labels and Blocked by to a sheet holding the same prompt the overflow menu used to open.
  const labelActions: SheetAction[] = [
    { label: "Add label", icon: Icons.plus(18), onSelect: addLabel },
    ...card.labels.map((l) => ({
      label: `Remove ${l}`,
      tone: "danger" as const,
      icon: Icons.close(18),
      onSelect: () => act(() => api.updateCard(boardId, card.num, { removeLabels: [l] })),
    })),
  ];
  // The phone stacks a second sheet on the first to act on one blocker; a popover anchored
  // to a row cannot politely open another popover out of itself, and it does not need to —
  // at this width the list has room to say both verbs outright (#23).
  const blockerTitle = (n: number) => `#${n} ${allCards.find((c) => c.num === n)?.title ?? ""}`.trim();
  const blockedByActions: SheetAction[] = [
    { label: "Add blocker", icon: Icons.link(18), onSelect: addBlocker },
    ...card.blockedBy.flatMap((n) => [
      { label: blockerTitle(n), icon: Icons.chevron(18), onSelect: mobile ? () => setBlockerMenu(n) : () => (window.location.hash = `#/b/${boardSlug}/c/${n}`) },
      ...(mobile ? [] : [{ label: `Remove blocker #${n}`, tone: "danger" as const, icon: Icons.close(18), onSelect: () => act(() => api.unblock(boardId, card.num, n)) }]),
    ]),
  ];
  // Nothing on this card can add or drop a "blocks" edge — the other card owns it — so this
  // list only offers the one thing the old `#n` links did: go and read it.
  const blocksActions: SheetAction[] = blocks.map((n) => ({
    label: `Open #${n} ${allCards.find((c) => c.num === n)?.title ?? ""}`.trim(),
    icon: Icons.chevron(18),
    onSelect: () => (window.location.hash = `#/b/${boardSlug}/c/${n}`),
  }));

  // The drawer says the status in its header chip, which is also the control that changes
  // it, so the Details list does not say it a second time (#23; #16 F3 counted it three
  // times on one screen). The phone has no header chip and keeps the row.
  const detailRows = buildDetailRows({ card, blocks, allCards, holder }).filter((r) => mobile || r.key !== "status");
  // Mobile opens a sheet; the drawer toggles a popover anchored to the row itself, so the
  // same click both opens and dismisses it.
  const toggle = (set: (f: (v: boolean) => boolean) => void) => (mobile ? () => set(() => true) : () => set((v) => !v));
  const onRow = (r: DetailRow) => {
    if (r.key === "status") return () => setMoving(true);
    if (r.key === "labels") return toggle(setLabelsSheet);
    if (r.key === "blockedBy") return toggle(setBlockedBySheet);
    if (r.key === "blocks") return toggle(setBlocksSheet);
    return undefined;
  };
  // Which popover a Details row opens on desktop, and what it holds. Mobile passes none of
  // this: its rows are plain buttons that open the sheets at the bottom of the page.
  const rowMenu: Partial<Record<DetailRow["key"], { open: boolean; close: () => void; actions: SheetAction[] }>> = mobile ? {} : {
    labels: { open: labelsSheet, close: () => setLabelsSheet(false), actions: labelActions },
    blockedBy: { open: blockedBySheet, close: () => setBlockedBySheet(false), actions: blockedByActions },
    blocks: { open: blocksSheet, close: () => setBlocksSheet(false), actions: blocksActions },
  };
  const detailsList = (
    <div className="card-details" role="group" aria-label="Details">
      {detailRows.map((r) => {
        const row = <DetailRowView row={r} onSelect={onRow(r)} />;
        const m = rowMenu[r.key];
        if (!m) return <Fragment key={r.key}>{row}</Fragment>;
        return (
          <AnchoredMenu key={r.key} open={m.open} onClose={m.close} align="right" menuClass="menu-detail" trigger={row}>
            <MenuItems actions={m.actions} onClose={m.close} />
          </AnchoredMenu>
        );
      })}
    </div>
  );

  const createdLine = <div className="muted small">Created by {card.createdBy}, {agoText(card.createdAt)}. Updated {agoText(card.updatedAt)}.</div>;

  const askBox = card.status === "awaiting-human" && card.question && (
    <div className="ask-box">
      <div className="muted small">{card.questionBy} asks</div>
      <div className="needs-q"><MessageBody text={card.question} /></div>
      <AnswerBox onAnswer={(a) => act(() => api.answer(boardId, card.num, a))} />
    </div>
  );

  const holdCard = async () => {
    const reason = await prompt({ title: "Hold", placeholder: "Why (optional)", submit: "Hold card", hint: "No agent can claim this card until the hold is released.", allowEmpty: true });
    if (reason !== null) act(() => api.hold(boardId, card.num, reason || undefined));
  };

  const primaryActions = (
    <div className="primary-actions">
      {/* Held cards hide Claim rather than disabling it: a human acting as themselves gets
          no control that would always 409. */}
      {!closed && !card.assignee && !card.held && <button className="btn" onClick={() => act(() => api.claim(boardId, card.num, card.blocked))}>{Icons.hand(16)} Claim{card.blocked ? " anyway" : ""}</button>}
      {!closed && card.assignee && <button className="btn" onClick={() => act(() => api.release(boardId, card.num))}>{mine ? "Release" : `Unassign ${card.assignee}`}</button>}
      {!closed && card.held && <button className="btn" onClick={() => act(() => api.unhold(boardId, card.num))}>{Icons.pause(16)} Release hold</button>}
      {!closed && !card.held && <button className="btn btn-ghost" onClick={holdCard}>{Icons.pause(16)} Hold</button>}
      {!closed && <button className="btn btn-ok" onClick={() => act(() => api.close(boardId, card.num))}>{Icons.check(16)} Mark done</button>}
      {closed && <button className="btn" onClick={() => reopen("todo")}>{Icons.undo(16)} Reopen</button>}
    </div>
  );

  const errBlock = err && <div className="inline-error">{err}</div>;

  // The same conversation the channel is, drawn by the same components (thread.tsx): a run
  // of comments from one actor shares a header and stacks as bubbles, and your own go right
  // on a tinted ground. What the card keeps for itself is that a comment is not the only
  // thing in this thread — a question, its answer and the resolution are things that
  // happened to the card, so they break the run and stand as their own row.
  const commentsBlock = (
    <div className="comments">
      {comments !== null && shownComments.length === 0 && <div className="muted small">No comments yet.</div>}
      {threadChunks(shownComments).map((chunk) =>
        chunk.system ? (
          <SystemEntry key={chunk.items[0].id} comment={chunk.items[0]} isNew={newComments.has(chunk.items[0].id)} />
        ) : (
          <ThreadGroup
            key={chunk.items[0].id}
            group={chunk.items}
            mine={!!me && chunk.items[0].author === me}
            boardId={boardId}
            headerExtra={<RuntimeTag harness={actors.get(chunk.items[0].author)?.harness} model={actors.get(chunk.items[0].author)?.model} effort={actors.get(chunk.items[0].author)?.effort} />}
            entryClass={(c) => enterClass(newComments.has(c.id)) + (sendingCommentIds.has(c.id) ? " pending" : "")}
            // Double-tap-to-react (#6, reworked in #1): same reaction sheet and toggle path as
            // the channel message bubble, through the shared `ThreadGroup`/`useDoubleTapReact` —
            // num 0 is the unconfirmed optimistic placeholder, nothing to react to yet.
            doubleTapReact={{
              canReact: (c) => c.num > 0,
              isMine: (c, emoji) => hasReaction(c.reactions, me, emoji),
              onPick: (c, emoji, mine) => toggleCommentReaction(c.num, emoji, mine),
            }}
            entryFooter={(c) =>
              // num 0 is the not-yet-confirmed optimistic placeholder (see onSubmit below);
              // there is nothing to react to until the server has assigned a real one.
              c.num > 0 ? (
                <MessageReactions
                  reactions={c.reactions}
                  viewer={me}
                  onToggle={(emoji, mine) => toggleCommentReaction(c.num, emoji, mine)}
                />
              ) : null
            }
          />
        ),
      )}
    </div>
  );

  const modeRow = (
    <div className="mode-row">
      {(["comment", "ask", "resolve"] as const).map((m) => (
        <button type="button" key={m} className={`mode ${mode === m ? "active" : ""} mode-${m}`} onClick={() => setMode(m)} disabled={closed && m !== "comment"}>
          {m === "ask" ? "Ask a human" : m === "resolve" ? "Resolve and close" : "Comment"}
        </button>
      ))}
    </div>
  );
  // The same three modes, as one segmented control small enough to ride in the composer's
  // leading slot (#23). The drawer's chin was three stacked rows for one text field — the
  // primary action, the mode pills, the composer — and the selected pill was the only
  // near-black filled control in the app. The actions moved to the header; this is the
  // second row folded into the first.
  const modeSeg = (
    <div className="mode-seg" role="group" aria-label="What this message does">
      {(["comment", "ask", "resolve"] as const).map((m) => (
        <button
          type="button"
          key={m}
          className={`mode-seg-item mode-${m}${mode === m ? " active" : ""}`}
          aria-pressed={mode === m}
          onClick={() => setMode(m)}
          disabled={closed && m !== "comment"}
          title={m === "ask" ? "Ask a human" : m === "resolve" ? "Resolve and close" : "Comment"}
        >
          {m === "ask" ? "Ask" : m === "resolve" ? "Resolve" : "Comment"}
        </button>
      ))}
    </div>
  );
  const composePlaceholder = mode === "ask" ? "One precise question" : mode === "resolve" ? "What was done or decided" : "Comment";
  const sendLabel = mode === "ask" ? "Ask" : mode === "resolve" ? "Resolve" : "Comment";

  // The channel's composer, not a second one that looks like it (#41): same chin, same
  // field and radius, same send button, same auto-grow (#42) and the same draft store —
  // and, since #46, the same attach button, paste/drop intake and thumbnail strip.
  // Attaching belongs to a comment: a question and a resolution are card state, and neither
  // route carries images. So the glyph is only there in Comment mode, and switching mode
  // with images still staged is refused rather than quietly dropping them.
  const composer = (
    <LineComposer
      className="card-composer"
      placeholder={composePlaceholder}
      action={sendLabel}
      above={mobile ? modeRow : undefined}
      leading={mobile ? undefined : modeSeg}
      boardId={boardId}
      attachable={mode === "comment"}
      sendClass={mode === "ask" ? "tone-warn" : undefined}
      address={{ board: boardId, pane: "card", card: card.num }}
      onTextChange={setText}
      compact={mobile}
      onExpandedChange={mobile ? setComposerExpanded : undefined}
      onSubmit={async (t, attachmentIds, attachments) => {
        if (mode !== "comment" && attachmentIds.length > 0) {
          throw new Error("Images can only go on a comment. Switch back to Comment, or remove them.");
        }
        // Only a plain comment is optimistic (#31): Ask and Resolve change the card's own
        // status, not just the thread, and the rest of the page (status chip, Details, the
        // primary actions) waits on `reload()`/`onChange()` regardless, so there is nothing
        // for an optimistic row to buy there — and `SystemEntry` for a question/answer/
        // resolution renders from `Card` fields threadChunks would not have yet.
        if (mode === "comment") {
          const tempId = nextTempId();
          const optimistic: Comment = {
            id: tempId, cardId: card.id, author: me, authorKind: "human", kind: "comment",
            // `num` is 0 until the server allocates one: an unsent comment has no ref to react to.
            num: 0, cardNum: card.num, reactions: [],
            body: t, createdAt: new Date().toISOString(), attachments,
          };
          setPendingComments((prev) => [...prev, { tempId, entry: optimistic, sending: true, draftText: t, draftAttachmentIds: attachmentIds }]);
          if (mobile) scrollToLatestOnGrow.current = true;
          try {
            const real = await api.comment(boardId, card.num, t, attachmentIds);
            setPendingComments((prev) => resolvePending(prev, tempId, real));
          } catch (err) {
            setPendingComments((prev) => failPending(prev, tempId));
            throw err;
          }
        }
        if (mode === "ask") await api.ask(boardId, card.num, t);
        if (mode === "resolve") await api.close(boardId, card.num, t);
        setMode("comment");
        onChange();
        reload();
      }}
    />
  );

  const inner = (
    <>
      {/* On a phone there is no bar here at all: the shell's own top bar, which never
          unmounts, carries the back chevron and the overflow menu for a card route
          (TopBar.tsx), and the phone says the status once, in the Details list, where it
          sits next to the rest of the card's facts and is a row you can act on. */}
      {!mobile && (
        // The panel header, shared with the actor panel by shape (#23): 44px, one hairline,
        // everything left-to-right and nothing centred. The status chip is no longer a
        // label that happens to be a button — it is the popover's trigger, and the popover
        // opens against it rather than 950px away in the middle of the screen.
        <header className="panel-head">
          <button className="icon-btn panel-close" onClick={handleClose} aria-label="Close card">{Icons.close()}</button>
          <span className="panel-num">#{card.num}</span>
          <AnchoredMenu
            open={moving}
            onClose={() => setMoving(false)}
            align="left"
            trigger={(
              <button
                type="button"
                className={`status-chip status-${card.status}${moving ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={moving}
                onClick={() => setMoving((v) => !v)}
              >
                <StatusIcon status={card.status} size={14} /> {STATUS_LABEL[card.status]}
              </button>
            )}
          >
            <MenuItems actions={moveActions} onClose={() => setMoving(false)} />
          </AnchoredMenu>
          <span className="grow" />
          {primaryActions}
          <AnchoredMenu
            open={menu}
            onClose={() => setMenu(false)}
            menuClass="menu-card"
            trigger={(
              <button
                type="button"
                className={`icon-btn${menu ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label="More actions"
                onClick={() => setMenu((v) => !v)}
              >
                {Icons.more()}
              </button>
            )}
          >
            <MenuItems actions={menuActions} onClose={() => setMenu(false)} />
          </AnchoredMenu>
        </header>
      )}

      {/* Details sits where it belongs on both: after the body you were reading, before the
          conversation about it. Mobile then goes straight to the thread — the comments are
          why the card was opened (#6) — and pushes the byline, the primary actions and any
          error down after it, since they are read far less often than they used to be read
          past. Desktop keeps its own tail — created-by and the ask box after the thread —
          and pins the primary actions in their own bar above the composer instead of
          interrupting the body. */}
      {mobile ? (
        <div className="screen-body card-body" ref={scrollerRef}>
          {titleBlock}
          {detailsList}
          {askBox}
          {commentsBlock}
          {/* #29: marks where the thread actually ends, for the jump-to-latest observer
              below — not the bottom of the page, which still has the byline and actions
              to go. A card whose whole page fits the screen never scrolls this out of
              view, so the button never appears. */}
          <div ref={bottomSentinelRef} aria-hidden />
          {createdLine}
          {primaryActions}
          {errBlock}
        </div>
      ) : (
        <>
          <div className="screen-body card-body">
            {titleBlock}
            {detailsList}
            {commentsBlock}
            {createdLine}
            {askBox}
          </div>
          {/* The primary actions moved into the header, so what is left of the bar is the
              error — and with nothing to say it is not drawn at all, which is what makes
              the chin a single row (#23). */}
          {err && <div className="card-actions-bar">{errBlock}</div>}
        </>
      )}

      {/* Editing the title or description takes over the field the composer would ride
          above (on desktop, the inline form in place of the heading; on the phone, the
          "Edit card" sheet below); while it is up the composer has nothing to sit against
          and only ate space and a keyboard-avoidance quirk of its own, so it is not rendered
          at all rather than drawn disabled underneath. */}
      {!editing && (mobile ? <div ref={composerWrapRef}>{composer}</div> : composer)}

      {/* #29: floats above the composer once the newest comment has scrolled out of view.
          `composerH` (measured off `composerWrapRef`) keeps it clear of the composer at
          any of its heights — idle one-liner, focused with the mode row, or with an attach
          strip — and the composer's own bottom padding already carries the home-indicator
          inset (`.card-page .pane-foot`), so adding a flat gap on top of that measured
          height is enough; no separate safe-area math needed here.
          #29 reopened: also hidden while the composer is expanded (focused, or holding a
          draft/staged image) — starting a comment used to still show the button sitting
          right on top of the field the human just opened, even though there is nothing new
          to jump to. `bottomHidden` (the intersection state) is left untouched, so the
          button reappears the moment the composer collapses back, if the bottom is still
          out of view. */}
      {mobile && !editing && showJump && (
        <button
          type="button"
          className="icon-btn jump-latest"
          style={{ bottom: composerH + 12 }}
          onClick={scrollToLatest}
          aria-label="Jump to latest comments"
        >
          {Icons.arrowDown(16)}
        </button>
      )}

      {/* Reopening a closed card always asks why (#13): the same composer as the channel and
          the comment thread, not the plain-input usePrompt sheet — attach icon and send
          button inline, height that grows as it wraps. Rendered on both mobile and desktop,
          since Reopen is reachable from either (the header's status popover on desktop, the
          primary action and overflow menu on the phone).
          The composer (and the Cancel button below it) go in `foot`, not `children`: the
          composer cancels the sheet's own inset with a negative margin (`.composer-flush`) to
          reach the channel's full width, and `.sheet-body` clips at its own box — which sits
          *inside* that inset — so a flush child left there gets its edges clipped by the
          scrollport instead of only escaping the sheet's padding as intended. `.sheet` itself
          never clips, so `foot`, rendered as `.sheet-body`'s sibling there, doesn't clip it. */}
      <Sheet
        open={!!reopenSheet}
        onClose={() => setReopenSheet(null)}
        title="Reopen"
        hideClose
        foot={
          <div className="stack sheet-foot">
            <LineComposer
              placeholder="What's not done, or why this is coming back"
              action="Reopen"
              boardId={boardId}
              attachable
              address={{ board: boardId, pane: "reopen", card: card.num }}
              onSubmit={reopenReason}
              className="composer-flush"
            />
            {/* #28: the composer's send button submits the reason; this is the sheet's one way
                to back out without reopening the card. */}
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setReopenSheet(null)}>Cancel</button>
          </div>
        }
      >
        <></>
      </Sheet>

      {/* Seven sheets on the phone, where a sheet is the platform's answer to pick-one and
          the screen has no room for anything anchored. On desktop every one of them is a
          popover against the control that opened it, above and in `detailsList` (the edit
          sheet's own desktop equivalent is the inline form above), and none of this renders
          (#23). */}
      {mobile && (
        <>
          {/* #25: the same bottom sheet the brief editor uses, opened only from the top
              bar's overflow menu ("Edit title and description") — one sheet for both
              fields rather than the inline form this replaced. The title and body
              themselves are plain, non-interactive content; tap-to-edit on them was tried
              and pulled back out. */}
          <Sheet open={editing} onClose={cancelEdit} title="Edit card" tall hideClose>
            <div className="stack">
              <input
                ref={editTitleRef}
                className="input input-lg"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
              />
              <textarea
                className="textarea"
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Description, in markdown"
              />
              <div className="row gap end">
                <button className="btn btn-ghost" onClick={cancelEdit}>Cancel</button>
                <button className="btn btn-primary" onClick={saveEdit} disabled={!title.trim()}>Save</button>
              </div>
            </div>
          </Sheet>
          <ActionSheet open={menu} onClose={() => setMenu(false)} title={`#${card.num} ${card.title}`} actions={menuActions} />
          <ActionSheet open={moving} onClose={() => setMoving(false)} title="Move to" actions={moveActions} />
          <ActionSheet open={labelsSheet} onClose={() => setLabelsSheet(false)} title="Labels" actions={labelActions} />
          <ActionSheet open={blockedBySheet} onClose={() => setBlockedBySheet(false)} title="Blocked by" actions={blockedByActions} />
          <ActionSheet open={blocksSheet} onClose={() => setBlocksSheet(false)} title="Blocks" actions={blocksActions} />
          <ActionSheet
            open={blockerMenu !== null}
            onClose={() => setBlockerMenu(null)}
            title={`Blocked by #${blockerMenu}`}
            actions={[
              { label: `Open #${blockerMenu}`, icon: Icons.chevron(18), onSelect: () => (window.location.hash = `#/b/${boardSlug}/c/${blockerMenu}`) },
              { label: "Remove blocker", tone: "danger", icon: Icons.close(18), onSelect: () => act(() => api.unblock(boardId, card.num, blockerMenu!)) },
            ]}
          />
        </>
      )}
    </>
  );

  // Portalled to the document, not left inside the board's screen: the board takes a
  // transform while the page covers it, and a transformed ancestor would make this fixed
  // element position against the board instead of the viewport — the page would parallax
  // away with it.
  if (mobile) {
    return createPortal(
      <div className={`page card-page${atRest ? " at-rest" : ""}${pushClosing ? " closing" : ""}`} ref={pageRef}>{inner}</div>,
      document.body,
    );
  }
  return (
    <div className={`drawer-backdrop${closing ? " closing" : ""}`} onClick={handleClose}>
      {/* `aria-labelledby` names the dialog with the card's own heading; `aria-label` is
          what answers while the heading is swapped for the title field in edit mode, where
          the referenced id is absent and the browser falls through to it. */}
      <div
        ref={drawerRef}
        className={`drawer card-page${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-label={`#${card.num} ${card.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        {inner}
      </div>
    </div>
  );
}

/**
 * A question, its answer, or the resolution. These are not talk about the card, they are the
 * card's own record, so they never wear a bubble: a full-width row on the kind's colour,
 * labelled with what it is. It still clamps behind "Show more" like everything else in the
 * thread — a full agent resolution is several screens long, and a thread that opens with one
 * of those unrolled is a wall, not a conversation.
 */
function SystemEntry({ comment: c, isNew }: { comment: Comment; isNew: boolean }) {
  return (
    <div className={`thread-system kind-${c.kind}${enterClass(isNew)}`}>
      <div className="thread-system-head">
        <span className={`kind-chip kind-${c.kind}`}>{c.kind}</span>
        <span className={`who ${c.authorKind}`}>{c.author}</span>
        <span className="muted tiny">{timeAgo(c.createdAt)}</span>
      </div>
      <ClampedBody text={c.body} />
    </div>
  );
}

/**
 * One row of the Details group: the field's name on the left, its value right-aligned in
 * muted text on the right, a chevron when the row leads somewhere. A long value wraps onto a
 * second line inside the row rather than pushing the chevron off the edge.
 */
function DetailRowView({ row, onSelect }: { row: DetailRow; onSelect?: () => void }) {
  const tappable = row.tappable && !!onSelect;
  const inner = (
    <>
      <span className="detail-label">{row.label}</span>
      <span className={`detail-value${row.key === "status" ? ` detail-status status-${row.status}` : ""}`}>
        <DetailValue row={row} />
      </span>
      {tappable && <span className="detail-chev">{Icons.chevron(16)}</span>}
    </>
  );
  // A row that leads nowhere is a line of text, not a dead button: rendering it as a
  // disabled <button> would have every screen reader announce it as unavailable.
  if (!tappable) return <div className="detail-row detail-row-static">{inner}</div>;
  return (
    <button type="button" className="detail-row" onClick={onSelect}>
      {inner}
    </button>
  );
}

function DetailValue({ row }: { row: DetailRow }) {
  switch (row.key) {
    case "status":
      return (
        <>
          <StatusIcon status={row.status} size={15} /> {row.value}
        </>
      );
    case "assignee":
      return row.assignee ? (
        <>
          <Avatar name={row.assignee} kind={row.kind} size={20} />
          <span className="detail-name">{row.assignee}</span>
          {row.runtime && <span className="detail-runtime">{row.runtime}</span>}
        </>
      ) : (
        <span className="detail-empty">Unassigned</span>
      );
    case "labels":
      return row.labels.length > 0 ? (
        <>{row.labels.map((l) => <span key={l} className="label">{l}</span>)}</>
      ) : (
        <span className="detail-add">Add</span>
      );
    // Blocked by with nothing in it still offers the row; "None" is the honest trailing
    // value, and the chevron is how a blocker gets added now that the dashed chip is gone.
    // The padlock is only ever about this card: a blocker still open is what holds it, so
    // it is drawn on Blocked by and never on Blocks, where the state belongs to the other
    // card and an amber lock would read as an alarm about the wrong thing.
    case "blockedBy":
      return row.tokens.length > 0 ? (
        <>
          {row.tokens.map((t) => (
            <span key={t.num} className={`detail-token${t.open ? " is-open" : ""}`}>
              {t.open && Icons.lock(13)}#{t.num}
            </span>
          ))}
        </>
      ) : (
        <span className="detail-empty">None</span>
      );
    case "blocks":
      return <>{row.tokens.map((t) => <span key={t.num} className="detail-token">#{t.num}</span>)}</>;
    case "hold":
      return (
        <span>
          {row.reason ?? `held by ${row.heldBy}`}
          <span className="muted tiny"> · held by {row.heldBy} · {timeAgo(row.heldAt)}</span>
        </span>
      );
  }
}

function AnswerBox({ onAnswer }: { onAnswer: (a: string) => void }) {
  const [a, setA] = useState("");
  return (
    <form
      className="row gap"
      onSubmit={(e) => {
        e.preventDefault();
        if (a.trim()) onAnswer(a.trim());
      }}
    >
      <input className="input grow" placeholder="Your answer" value={a} onChange={(e) => setA(e.target.value)} enterKeyHint="send" />
      <button type="submit" className="btn btn-primary" disabled={!a.trim()}>Answer</button>
    </form>
  );
}

/**
 * A `SheetAction[]` drawn as the desktop popover's items rather than the phone's sheet
 * rows (#23). One list of actions, two grammars: the phone gets `ActionSheet`, the drawer
 * gets these inside an `AnchoredMenu`, and neither is a second definition of what the card
 * can do.
 */
function MenuItems({ actions, onClose }: { actions: SheetAction[]; onClose: () => void }) {
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          className={`menu-item${a.tone ? ` tone-${a.tone}` : ""}`}
          disabled={a.disabled}
          onClick={() => {
            onClose();
            a.onSelect();
          }}
        >
          {a.icon}
          <span className="menu-item-label">{a.label}</span>
        </button>
      ))}
    </>
  );
}
