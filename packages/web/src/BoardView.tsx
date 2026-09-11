import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";
import { api, ApiError, getActorName, streamPath, type ActorInfo, type BoardSummary, type Card, type CardStatus, type Decision, type Event, type Message, type NeedsHuman, type Snapshot } from "./api.ts";
import { closedOrder } from "./closedOrder.ts";
import { holdTitle } from "./details.ts";
import { autoFocusField } from "./focus.ts";
import { ROSTER_NAV_INITIAL, rosterNav } from "./rosterNav.ts";
import { CardPage } from "./CardPage.tsx";
import { Brand } from "./Mark.tsx";
import { AppTopBar } from "./shell.tsx";
import { Markdownish, MessageBody } from "./markdown.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { agoText, shortPath } from "./App.tsx";
import { EventLine } from "./EventLine.tsx";
import {
  applyReplayFrame,
  BOARD_EVENT_TYPES,
  enterClass,
  enterDelay,
  enterOrders,
  markReplayBackgrounded,
  peekReplayFrame,
  planReplay,
  REPLAY_HOLD_MS,
  REPLAY_TINT_MS,
  saveReplayFrame,
  useAnchorScroll,
  useCoalescedRefetch,
  useFlip,
  useLiveStream,
  useMovedIds,
  useNewIds,
  usePaneGrowth,
  useScrollCollapse,
  useScrollRestore,
  useStickToBottom,
  type ItemId,
} from "./live.ts";
import { groupMessages, splitByDay } from "./grouping.ts";
import { matchShortcut, SHORTCUT_HINT, type Shortcut } from "./shortcuts.ts";
import { DOUBLE_TAP_EMOJI, failPending, hasReaction, LineComposer, mergeThread, MessageReactions, nextTempId, resolvePending, ThreadGroup, type PendingSend } from "./thread.tsx";
import { AddToChatTip, quoteBlock, useAddToChat } from "./addToChat.tsx";
import { draftKey, requestInsert } from "./compose.ts";
import { ActivitySkeleton, BoardSideSkeleton, CardPageSkeleton, CardsSkeleton, KanbanSkeleton, Line } from "./Skeleton.tsx";
import { ActorSheet } from "./ActorView.tsx";
import { clearSnapshot, readSnapshot, snapKey, writeSnapshot } from "./snapshot.ts";
import { forgetView, readScroll, rememberedTab, rememberScroll, rememberTab } from "./viewstate.ts";
import { useTopBarSlot } from "./TopBar.tsx";
import { Avatar, D_BASE, D_SLOW, EMPTY_TEXT, Icons, prefersReducedMotion, RuntimeTag, Sheet, setEdgeSwipePeek, skipNextPushAnimation, STATUS_LABEL, StatusPill, TeamSheet, TeamStack, useAnyOverlayOpen, useEdgeSwipeBack, useHasFinePointer, useIsMobile, Menu } from "./ui.tsx";

export type BoardTab = "cards" | "channel" | "activity" | "decisions";

/**
 * The kanban edge fade's ramp, in px. Mirrors `--fade-ramp` on `.kanban` (styles.css), which
 * is `--s5`; see `updateKanbanFade` for why the two are stated separately and what a drift
 * between them would and would not cost.
 */
const FADE_RAMP = 24;

/**
 * Where a board tab lives. The plain route for a pane, with no opinion about how the reader
 * got there — what anything navigating *to* a tab should use: closing a card page, restoring
 * the tab a sheet covered. Cards is the board's own route, so it has no segment of its own.
 */
export function paneHref(boardSlug: string, target: BoardTab): string {
  return target === "cards" ? `#/b/${boardSlug}` : `#/b/${boardSlug}/${target}`;
}

/**
 * Where a tap on a tab-bar button should send the phone: normally the button's own tab, but
 * tapping Cards while already on Cards has nowhere further "in" to go, so it steps back out to
 * the boards list instead. That only applies to Cards — it's the tab bar's root, the one a user
 * reaches other tabs from, so a re-tap reads as "leave" rather than "reset"; the other three
 * tabs stay put on a re-tap.
 *
 * This is *the tab bar's* rule, and only the tab bar's: the "leave" reading comes from a finger
 * landing on an already-lit button, not from the route being the cards tab. A card page is on
 * the cards route too (`parseRoute` gives it `tab: "cards"`), so routing its back button through
 * here read "back to the board" as a Cards re-tap and sent it home instead — the card's exit
 * animation, then the boards list pushing in over it (#23). Anything that is not a tab-bar tap
 * wants `paneHref`.
 */
export function tabHref(boardSlug: string, current: BoardTab, target: BoardTab): string {
  if (target === "cards" && current === "cards") return "#/";
  return paneHref(boardSlug, target);
}

const COLUMNS: CardStatus[] = ["todo", "doing", "awaiting-human", "done"];

/**
 * The phone's Cards tab, top to bottom. What is stuck on you comes first, then what is
 * moving, then what is next, then what is finished — reading order matches urgency, so the
 * thing that needs you to act is already on screen before anything you're just tracking.
 * Desktop keeps its own kanban column order (`COLUMNS`, left to right by workflow stage) but
 * already surfaces awaiting-human above that grid in its own "Waiting on you" section, so the
 * two surfaces agree on what comes first without sharing this literal array.
 */
const SECTIONS: CardStatus[] = ["awaiting-human", "doing", "todo", "done"];

/** Left to right along the tab bar, which is the direction a tab switch travels in. */
const TAB_ORDER: BoardTab[] = ["cards", "channel", "activity", "decisions"];

/** How many finished cards Done shows before it folds the rest away: enough to see what just landed. */
const DONE_FOLD_AT = 4;

/** Written labels for the side-pane surfaces (P1.4): the switcher's only generated strings used
 *  to be lowercase ids capitalized by CSS; every other label in the app is typed out, so these are too. */
const PANE_TAB_LABEL: Record<Exclude<BoardTab, "cards">, string> = {
  channel: "Channel",
  activity: "Activity",
  decisions: "Decisions",
};

/** The glyph each surface wears in the phone's tab bar. The desktop pane head reuses them so
 *  the two ways into the same three screens are drawn with the same three marks (#14). */
const PANE_ICON: Record<Exclude<BoardTab, "cards">, (s?: number) => ReactNode> = {
  channel: Icons.chat,
  activity: Icons.pulse,
  decisions: Icons.flag,
};

/** Name -> that actor's cached runtime, for a compact model suffix on assignee chips. */
export type ActorRuntimes = Map<string, ActorInfo>;

/**
 * Which tab the pane under a card page — or an actor sheet — shows.
 *
 * The route's own tab stays "cards" for as long as `#/b/<slug>/c/<n>` is on screen — the URL
 * has no room to carry where the card was opened *from* — so while the card is closing this
 * is what stands in for it: the tab it is about to land on (`lastTab`), shown immediately
 * rather than only once the hash itself changes. That collapses what would otherwise be two
 * transitions — the card's own exit, then a second tab-pane swap once the delayed navigation
 * lands — into the one. Once the card is not closing, the route's tab is authoritative again.
 *
 * `#/b/<slug>/a/<name>` has the identical shape and the identical gap, but for the whole of
 * an actor's visit rather than only its close: the actor sheet is a partial overlay, so
 * whatever is behind it is on screen the entire time it is open, not just while it animates
 * away. `actorOpen` covers that case the same way `cardClosing` covers the card's.
 */
export function displayTabWhileClosing(tab: BoardTab, cardClosing: boolean, lastTab: BoardTab, actorOpen = false): BoardTab {
  return cardClosing || actorOpen ? lastTab : tab;
}

/**
 * The mobile Cards tab's own scroll container, restoring and remembering its position
 * (ADR 0013). A genuine component, not inlined, so `useScrollRestore` mounts and unmounts
 * with the pane itself — the `.tab-pane` it lives under is keyed on the tab, so switching
 * away and back is a real remount, which is what a mount-only restore needs to fire again.
 * `listRef` is the existing anchor/FLIP callback ref this container already wore; merged
 * here rather than replaced, so a card landing above the reader still holds their place.
 */
function CardsScrollBody({ boardSlug, listRef, children }: { boardSlug: string; listRef: (el: HTMLElement | null) => void; children: ReactNode }) {
  // Read once per board, not once per render: only the mount effect inside the hook ever
  // uses it, and a coalesced refetch re-renders this pane freely.
  const restored = useMemo(() => readScroll(boardSlug, "cards"), [boardSlug]);
  const restoreRef = useScrollRestore<HTMLDivElement>(restored, (y) => rememberScroll(boardSlug, "cards", y));
  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      listRef(el);
      (restoreRef as { current: HTMLDivElement | null }).current = el;
    },
    [listRef, restoreRef],
  );
  return <div className="screen-body" ref={combinedRef}>{children}</div>;
}

export function BoardView({ boardRef, cardNum, actorName, tab, onBoardsChanged, boards = [], needs = [], actor = "", onNewBoard = () => {}, onRename = () => {} }: { boardRef: string; cardNum?: number; actorName?: string; tab: BoardTab; onBoardsChanged: () => void;
  /** Desktop shell (P1.3): the top bar carries the boards switcher and who you are, so the
      board page needs what the sidebar used to be handed. Unused by the mobile branch. */
  boards?: BoardSummary[]; needs?: NeedsHuman[]; actor?: string; onNewBoard?: () => void; onRename?: () => void }) {
  const mobile = useIsMobile();
  // #7: the bar publishes its resting height so the keyboard can take it back a strip at a
  // time instead of the whole bar in one frame.
  // Seeded from the last snapshot cached for this route, read synchronously so the settled
  // board is the first paint on a refresh rather than a bare "Loading…" (#43). Null only on
  // a board this browser has never opened, which is the one case the skeleton is for.
  const [snap, setSnap] = useState<Snapshot | null>(() => readSnapshot<Snapshot>(snapKey.board(boardRef)));
  const [actors, setActors] = useState<ActorRuntimes>(new Map());
  // null until the first fetch lands, so a cold list never animates in wholesale.
  const [events, setEvents] = useState<Event[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [showWontfix, setShowWontfix] = useState(false);
  const [newCard, setNewCard] = useState(false);
  // The roster and the actor view are two depths of one thing (#31): whether the list is
  // showing, and where it was scrolled to when it was stepped out of, live in one reducer.
  const [roster, dispatchRoster] = useReducer(rosterNav, ROSTER_NAV_INITIAL);
  // True for one animation while the roster and the actor view trade places in the same
  // rect, so the arriving panel crossfades instead of sliding (see `Sheet`'s `swap`).
  const [swapping, setSwapping] = useState(false);
  const swapTimer = useRef(0);
  const swap = useCallback(() => {
    setSwapping(true);
    window.clearTimeout(swapTimer.current);
    swapTimer.current = window.setTimeout(() => setSwapping(false), D_BASE);
  }, []);
  useEffect(() => () => window.clearTimeout(swapTimer.current), []);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Only the very first load may show a placeholder. Every later fetch swaps the data
  // under a mounted tree, so nothing unmounts and nothing flashes.
  const boardId = snap?.board.id ?? null;
  const seenSeq = useRef<((n: number) => void) | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.snapshot(boardRef);
      setSnap(s);
      writeSnapshot(snapKey.board(boardRef), s);
      seenSeq.current?.(s.lastSeq);
      setErr(null);
      // Assignee chips and comment authors want each actor's last-known runtime. Fetched
      // alongside the snapshot so a newly recorded model shows up on the next refetch too.
      api.actors().then((list) => setActors(new Map(list.map((a) => [a.name, a])))).catch(() => {});
      return s;
    } catch (e) {
      // A cached frame outliving the board it came from would show a deleted board for
      // ever, since the error branch below only speaks when there is nothing to show. A
      // 404 is the server saying the cache is wrong: drop it and let the error through.
      if (e instanceof ApiError && e.status === 404) {
        clearSnapshot(snapKey.board(boardRef));
        // Same reasoning for the remembered tab and offsets: ADR 0013 assumed a dead board's
        // record was inert, but `entryRedirect` reads it, so `#/b/<gone>` would keep
        // redirecting and a slug reused later would inherit the dead board's positions.
        forgetView(boardRef);
        setSnap(null);
      }
      setErr((e as Error).message);
      return null;
    }
  }, [boardRef]);

  const refresh = useCoalescedRefetch(load);

  const onEvent = useCallback((e: Event) => {
    setEvents((prev) => (prev?.some((p) => p.seq === e.seq) ? prev : [...(prev ?? []), e].slice(-200)));
    if (e.type === "board.updated" || e.type === "card.asked" || e.type === "card.answered") onBoardsChanged();
  }, [onBoardsChanged]);

  const fetchSince = useCallback((since: number) => (boardId ? api.events(boardId, since) : Promise.resolve([])), [boardId]);

  const { noteSeq } = useLiveStream({
    path: boardId ? streamPath.board(boardId) : null,
    types: BOARD_EVENT_TYPES,
    onEvent,
    onWake: refresh,
    fetchSince,
  });
  seenSeq.current = noteSeq;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await load();
      if (!s || cancelled) return;
      const initial = await api.eventsTail(s.board.id, 50).catch(() => []);
      if (!cancelled) setEvents(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Hooks below the early returns would break the hook order, so they run on an
  // empty list until the first snapshot lands.
  // The phone Cards pane is keyed on `tab` and unmounts on a tab switch (BoardView itself
  // does not); the desktop kanban never unmounts at all. `newCards`/`movedCards`/`useFlip`
  // below key their remount-reset (#9) off this rather than off `tab` directly, so that
  // switching *which desktop pane* is showing (Channel/Activity/Decisions) — which changes
  // `tab` too, but never touches the always-mounted kanban — does not spuriously wipe a
  // live diff there. See the design note at scratchpad/flock/8.md §1.
  const cardsMountKey = mobile ? (tab === "cards" ? "cards" : "away") : "desktop";
  const isCardsTab = mobile && tab === "cards";

  // #10: the minimal "while you were away" replay (scratchpad/flock/8.md §8). `replayFrame`
  // is the pre-absence placement frame while a beat is holding it (null the rest of the
  // time — desktop and every ordinary render); `replayTintIds` are the cards getting the
  // over-budget compressed tint instead of a flight. Both live in component state, but the
  // frame that seeds a beat comes from live.ts's module-level store, which is what actually
  // survives the phone Cards pane unmounting on a tab switch — see `saveReplayFrame`.
  const [replayFrame, setReplayFrame] = useState<Map<ItemId, CardStatus> | null>(null);
  const [replayTintIds, setReplayTintIds] = useState<ReadonlySet<ItemId>>(new Set());
  const replayTimer = useRef(0);
  const replayWatermark = useRef(0);

  // Whether the pane was on Cards as of the *last* render, tracked as state (not a ref) so the
  // transition can be detected and acted on synchronously in the render that makes it —
  // `useState`'s "adjusting state in response to a prop change" pattern — rather than an
  // effect, which would commit and paint the live frame for one frame before a `useEffect`
  // could swap in the pre-absence one. `peekReplayFrame`/`planReplay` are pure reads, so
  // calling this block twice (StrictMode's double render) is harmless; only an effect below
  // ever mutates the module store.
  const [wasCardsTab, setWasCardsTab] = useState(isCardsTab);
  if (isCardsTab !== wasCardsTab) {
    setWasCardsTab(isCardsTab);
    window.clearTimeout(replayTimer.current);
    if (isCardsTab) {
      const saved = peekReplayFrame(boardRef);
      const after = new Map((snap?.cards ?? []).map((c) => [c.id, c.status] as const));
      const plan = planReplay({
        before: saved,
        after,
        now: Date.now(),
        reduced: prefersReducedMotion(),
        events: events ?? [],
        actorName: getActorName(),
      });
      replayWatermark.current = snap?.lastSeq ?? 0;
      if (plan.kind === "beat") {
        setReplayFrame(new Map(plan.before));
        setReplayTintIds(new Set());
      } else if (plan.kind === "tint") {
        setReplayFrame(null);
        setReplayTintIds(plan.ids);
      } else {
        setReplayFrame(null);
        setReplayTintIds(new Set());
      }
    } else {
      // Left the pane: nothing further to hold. Any beat in flight ends where it is; the
      // live frame is what the pane shows if the reader flips straight back.
      setReplayFrame(null);
      setReplayTintIds(new Set());
    }
  }

  // Arm the hold-then-swap / tint-then-clear timer once, from an effect, so it only fires
  // for the commit that actually started it — not the render-phase block above, which (like
  // any render-phase code) can run more than once for the same commit.
  useEffect(() => {
    if (replayFrame) {
      replayTimer.current = window.setTimeout(() => setReplayFrame(null), REPLAY_HOLD_MS);
    } else if (replayTintIds.size > 0) {
      replayTimer.current = window.setTimeout(() => setReplayTintIds(new Set()), REPLAY_TINT_MS);
    }
    return () => window.clearTimeout(replayTimer.current);
    // Deliberately keyed on identity, not contents: a beat's frame/tint set is set once by
    // the render-phase block above and only ever cleared from here or by an abort, never
    // replaced with a different one while active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayFrame, replayTintIds]);

  // Abort on a live change: any event that landed after the snapshot the plan was computed
  // against means the reader has already seen (or is about to see) something newer than what
  // the beat was going to show — jump straight to it instead of finishing the choreography.
  // The refetch itself is never throttled or delayed for this; only the replay's own overlay
  // ends early.
  useEffect(() => {
    if (!replayFrame && replayTintIds.size === 0) return;
    if ((snap?.lastSeq ?? 0) > replayWatermark.current) {
      window.clearTimeout(replayTimer.current);
      setReplayFrame(null);
      setReplayTintIds(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.lastSeq]);

  // Abort on user input: a tap, a scroll, a keypress. If the reader is doing something, the
  // recap is over.
  useEffect(() => {
    if (!replayFrame && replayTintIds.size === 0) return;
    const abort = () => {
      window.clearTimeout(replayTimer.current);
      setReplayFrame(null);
      setReplayTintIds(new Set());
    };
    document.addEventListener("pointerdown", abort, { passive: true });
    document.addEventListener("keydown", abort);
    document.addEventListener("wheel", abort, { passive: true });
    document.addEventListener("touchmove", abort, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", abort);
      document.removeEventListener("keydown", abort);
      document.removeEventListener("wheel", abort);
      document.removeEventListener("touchmove", abort);
    };
  }, [replayFrame, replayTintIds]);

  // The frame to save as "what the pane last painted": only while it is actually mounted and
  // visible on Cards, so an absence is measured from the last real paint, not from whatever
  // the background kept fetching while the reader was on another tab. A hidden document
  // invalidates whatever is saved instead — see the design note §5 on backgrounding vs a tab
  // switch — regardless of which tab is showing, so a background-then-return through any tab
  // never replays once it reaches Cards.
  const cardsSnapshotForSave = (snap?.cards ?? []).map((c) => [c.id, c.status] as const);
  const cardsSnapshotKey = cardsSnapshotForSave.map(([id, st]) => `${id}:${st}`).join(" ");
  useEffect(() => {
    if (isCardsTab && document.visibilityState === "visible") {
      saveReplayFrame(boardRef, snap?.lastSeq ?? 0, new Map(cardsSnapshotForSave));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCardsTab, cardsSnapshotKey, snap?.lastSeq, boardRef]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") markReplayBackgrounded(boardRef);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [boardRef]);

  // Every card the phone Cards pane derives from below — ids, placements, section
  // membership — goes through this substitution. `replayFrame` is only ever non-null while
  // `isCardsTab` (desktop never sets it), so the desktop kanban further down sees `snap.cards`
  // completely unchanged.
  const displayCards = applyReplayFrame(snap?.cards ?? [], replayFrame);
  const cardIds = displayCards.map((c) => c.id);
  const newCards = useNewIds(cardIds, !!snap, cardsMountKey);
  // The Cards tab used to stagger every card in on arrival (#5's first pass). It is gone:
  // the pane's own crossfade is the whole entrance now, and the stagger under it is what the
  // human read as jank — see the note on `.tab-in-*` in styles.css. `newCards` below still
  // animates genuine SSE arrivals, and #9's remount rule means a switch back to this tab
  // baselines rather than replaying them.
  const decisionIds = (snap?.decisions ?? []).map((d) => d.id);
  const newDecisions = useNewIds(decisionIds, !!snap);
  // The quiet live signal (#17 B11/candidate 8): Channel and Activity light the desktop
  // pane head's own dot when their surface grows while a different one is showing, cleared
  // the moment the reader arrives on it. Both always have *something* in them once a board
  // exists, which is exactly why Decisions' own "has any at all" dot (below, in the desktop
  // JSX) never fit them — this is "grew", not "is non-empty". `tab === "cards"` maps to
  // Channel same as the desktop pane derivation below; Decisions clears neither, so both
  // can be lit while it or Cards is showing.
  const growingPane: "channel" | "activity" | null = tab === "channel" || tab === "cards" ? "channel" : tab === "activity" ? "activity" : null;
  const paneGrew = usePaneGrowth({ channel: snap?.messages.length ?? 0, activity: events?.length ?? 0 }, growingPane, !!snap);
  // The kanban column that just emptied out gets the same arrival its rows get, rather than
  // "Nothing here yet." appearing with no transition (#17 B11). `useNewIds` already is this
  // rule — "present now, absent before" — pointed at a set of one label per empty status
  // instead of a set of card ids. Only "todo" (and "done" while its won't-fix list is
  // empty) ever actually render the empty line; the other statuses' columns disappear
  // entirely when they have nothing in them, so this is inert for them by construction.
  const emptyNow = COLUMNS.filter((status) => {
    const count = (snap?.cards ?? []).filter((c) => c.status === status).length;
    const hasWontfixHere = status === "done" && (snap?.cards ?? []).some((c) => c.status === "wontfix");
    return count === 0 && !hasWontfixHere;
  });
  const justEmptied = useNewIds(emptyNow, !!snap);
  // Which cards changed section on this snapshot, and the signature that says a section
  // changed at all — the FLIP only measures when one did, never on an unrelated refetch.
  const placements = displayCards.map((c) => [c.id, c.status] as const);
  const movedCards = useMovedIds(placements, !!snap, cardsMountKey);
  const layoutKey = placements.map(([id, st]) => `${id}:${st}`).join(" ");
  // A card landing above what the reader is looking at must not shove it down.
  const anchorRef = useAnchorScroll(cardIds.join(" "));
  const flipRef = useFlip(layoutKey);
  const listRef = useCallback((el: HTMLElement | null) => {
    anchorRef(el);
    flipRef(el);
  }, [anchorRef, flipRef]);
  const deskFlipRef = useFlip(layoutKey);

  // Kanban scroll-edge fade (#9): `--fade-l`/`--fade-r` feed the mask-image in styles.css.
  // A pure-CSS mask cannot tell "at the edge with more to scroll" from "at the edge because
  // there is nothing left" the way the old overlay's `background-attachment: local` trick
  // could, so this measures it directly and keeps the two custom properties in sync —
  // written straight to the node (not React state) so a scroll handler never triggers a
  // re-render.
  //
  // #12/2: these are no longer flags. Each is the distance scrolled on that side as a
  // fraction of the ramp, clamped to 1, and the mask reads it as the ramp's depth, its width
  // and its origin at once (see `.kanban` in styles.css). Sending a fraction rather than a
  // 0/1 is what makes the fade come up smoothly: a custom property inside a mask cannot be
  // transitioned without `@property`, so the smoothness has to come from the value tracking
  // scrollLeft continuously — which it does, since a scroll event fires for every frame the
  // board moves. At 3px of a 24px ramp the fade is 3px wide and 12% deep instead of 32px wide
  // and fully opaque, so it can never hide more than has actually gone past.
  //
  // FADE_RAMP is the pixel value of `--fade-ramp` on `.kanban` (--s5). The two only have to
  // agree for the geometry to be exact; a drift would soften or sharpen the ramp, not break
  // it, since both ends still reach 0 and 1.
  const kanbanRef = useRef<HTMLDivElement | null>(null);
  const updateKanbanFade = useCallback((el: HTMLDivElement) => {
    const max = el.scrollWidth - el.clientWidth;
    // A whole pixel of slop, so a sub-pixel scroll position at rest does not read as "more
    // to scroll" and a board that fits gets no fade on either side.
    const scrollable = max > 1;
    const left = scrollable ? Math.max(0, el.scrollLeft) : 0;
    const right = scrollable ? Math.max(0, max - el.scrollLeft) : 0;
    const ramp = (d: number) => (d <= 1 ? "0" : String(Math.min(1, d / FADE_RAMP)));
    el.style.setProperty("--fade-l", ramp(left));
    el.style.setProperty("--fade-r", ramp(right));
  }, []);
  const onKanbanScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    updateKanbanFade(e.currentTarget);
  }, [updateKanbanFade]);
  const kanbanScrollRef = useCallback((el: HTMLDivElement | null) => {
    deskFlipRef(el);
    kanbanRef.current = el;
    if (el) updateKanbanFade(el);
  }, [deskFlipRef, updateKanbanFade]);
  // The column set changes shape (a column appearing/emptying, a fold opening) without a
  // scroll event firing, and that is exactly when the fade can go stale — re-measure on the
  // same signal the FLIP animation already uses, plus a window resize.
  useEffect(() => {
    if (kanbanRef.current) updateKanbanFade(kanbanRef.current);
  }, [layoutKey, updateKanbanFade]);
  useEffect(() => {
    const onResize = () => { if (kanbanRef.current) updateKanbanFade(kanbanRef.current); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateKanbanFade]);

  // The desktop board's single-key verbs (#17 B4, P2.1). The listener is installed once and
  // reads the current handler from a ref, because everything it needs — `goTab`, the New
  // card sheet, the composer — is only defined below the snapshot's early returns, and a
  // hook cannot live down there. `matchShortcut` owns the whole decision, including the two
  // guards (a modifier, or a field with the caret in it) that keep a bare letter safe.
  const shortcutRef = useRef<((s: Shortcut) => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = shortcutRef.current;
      if (!run) return;
      const s = matchShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        target: e.target as HTMLElement | null,
      });
      if (!s) return;
      // Only once something is actually going to happen: "/" would otherwise open Firefox's
      // quick-find over a board the reader is only reading.
      e.preventDefault();
      run(s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Closing a card should return to whichever tab it was opened from, not always Cards:
  // the route has no room to carry that, so remember the last non-card tab seen. The actor
  // route has the same shape (`#/b/<slug>/a/<name>` carries no tab either), so it is guarded
  // the same way — otherwise the forced "cards" the route reports while an actor is open
  // would overwrite the tab it needs to be restored to underneath.
  // A cold mount straight onto a card or actor route carries no tab of its own (the URL has
  // no room for it) and the route reports "cards" only as a placeholder, so there is no real
  // last tab to fall back to yet — seed it from what was remembered instead (ADR 0013). A
  // board already mounted and merely navigating to a card keeps whatever this ref already
  // holds; the expression below only ever matters on the very first render.
  const lastTab = useRef<BoardTab>((cardNum !== undefined || actorName) ? (rememberedTab(boardRef) ?? tab) : tab);
  useEffect(() => {
    if (!cardNum && !actorName) {
      lastTab.current = tab;
      rememberTab(boardRef, tab);
    }
  }, [tab, cardNum, actorName, boardRef]);

  // The actor view is a route of its own (#49), so it replaces whatever was on screen rather
  // than stacking on it. Closing it must therefore put back what it covered — the card page
  // you tapped a comment's face on, or the tab you were reading — which is the last route
  // that was not an actor.
  const backFromActor = useRef<string>(window.location.hash);
  // Whether "back to team" belongs on the sheet at all (#49 follow-up): a roster row is a real
  // "I came from the list" and a deep link has no other list-free place the reader could have
  // come from, so both earn the control. An avatar tapped from a card, the header stack's own
  // faces, a thread bubble or any other in-app view is a request to see *that one actor*, not
  // the roster, and offering a way to a list they never opened just reads as a stray button.
  // `isDeepLinkActor` is decided once, at mount, from whichever route the page actually
  // loaded on, then expires the first time an actor session ends — closing the sheet and
  // returning to real navigation is what makes "no prior route" stop being true. Same idea for
  // `actorFromRoster`, set by the roster row's own tap (`onEnterActor` below).
  const isDeepLinkActor = useRef(!!actorName);
  const actorFromRoster = useRef(false);
  useEffect(() => {
    if (!actorName) {
      backFromActor.current = window.location.hash || "#/";
      isDeepLinkActor.current = false;
      actorFromRoster.current = false;
    }
  }, [actorName, tab, cardNum]);
  // No effect ties the roster to the actor route any more, and it matters that there is not
  // one: the roster is modal, so a roster row is the only way to reach an actor from it, and
  // that row already records where the list was and closes it (`onEnterActor`). An effect
  // that closed the roster whenever an actor was on screen would also fire on the way *back*
  // — `back` reopens the list one tick before the route drops the actor — and shut it again.

  // The card page is a push, so the board underneath has to know it is being covered (it
  // parallaxes and dims) and, crucially, when it stops being covered — which is the moment
  // the page starts leaving, not the moment the route changes. So the board owns the exit:
  // it holds the route for one animation with the page marked `closing`, and the board
  // slides back in the same 320ms rather than snapping once the page has gone.
  const [cardClosing, setCardClosing] = useState(false);
  const closeTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // A card the route already named when this board first rendered — a reload straight onto
  // `#/b/<slug>/c/<n>` — is not arriving from anywhere: the skeleton (or the seeded snapshot)
  // has already drawn it, at rest, covering the screen. Letting it play `page-in` when the
  // real page mounts slides it off the right edge and back over 320ms, and what that uncovers
  // at the top of the viewport is the board — pushed and under its dimming scrim. iOS samples
  // that strip for the status bar, so a card reload stepped the bar to a colour the rest of
  // the app never wears (#8). Captured on the first render and dropped as soon as the route
  // moves off that card, so a card opened *from* the board still pushes.
  const coldCard = useRef(cardNum);
  if (coldCard.current !== undefined && coldCard.current !== cardNum) coldCard.current = undefined;

  // Home is one level up from a board, and the push that brought this screen in invites the
  // same edge swipe back that a card page has. Same hook, same thresholds; the difference is
  // that nothing owns the exit here, so the gesture tells PushStack to skip its animation —
  // the screen has already been carried off the right edge by the finger.
  const screenRef = useRef<HTMLDivElement>(null);
  const overlayOpen = useAnyOverlayOpen();
  const goHome = useCallback(() => {
    skipNextPushAnimation();
    window.location.hash = "#/";
  }, []);
  // `!!snap` is part of `enabled` and not just a guard: the screen this ref points at does
  // not exist until the snapshot lands, and the hook only re-reads the ref when `enabled`
  // changes.
  useEdgeSwipeBack(screenRef, goHome, mobile && !!snap && !cardNum && !overlayOpen, setEdgeSwipePeek);

  // The phone's bar is the shell's, mounted once above the push stack (TopBar.tsx). This
  // screen lends it only what the route cannot know: the board's real title, its team (the
  // avatar stack every tab shows now, #32), and the actions that act on this board. Registered
  // above the early returns, so the skeleton path lends the same actions and the bar's
  // contents never depend on whether the snapshot has landed — `team`/`teamCards` are simply
  // undefined until it does, and the bar falls back to an empty trailing slot for that one
  // frame. Desktop lends nothing — it keeps its own `board-topbar`.
  useTopBarSlot("board", mobile ? {
    title: snap?.board.title,
    onOpenBrief: () => setBriefOpen(true),
    team: snap?.team,
    teamCards: snap?.cards,
    onOpenTeam: () => dispatchRoster({ type: "open" }),
  } : null);

  // Which way the tab bar moved, kept in a ref: derived fresh each render it would flip
  // back to the default on the next re-render and restart the animation mid-flight.
  const shownTab = useRef<BoardTab>(tab);
  // null until the reader actually switches tabs, so arriving on a board plays the push
  // and nothing else.
  const tabDir = useRef<"right" | "left" | null>(null);
  if (shownTab.current !== tab) {
    tabDir.current = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(shownTab.current) ? "right" : "left";
    shownTab.current = tab;
  }

  // Re-armed below, on the desktop board and only while nothing modal is over it: the phone
  // has a tab bar and a "+" within reach of a thumb and no use for these.
  shortcutRef.current = null;

  if (err && !snap) return <div className="screen"><div className="pad muted">{err}</div></div>;
  // Nothing cached for this board: the shell is still known — it comes from the route, not
  // from the server — so the top bar, the tab bar and the chrome colour paint now and only
  // the pane waits. The bare full-screen "Loading…" this replaces had neither bar, so the
  // iOS status bar sampled --bg and stepped to --bg-chrome when the board arrived (#40).
  if (!snap) return <BoardSkeleton boardRef={boardRef} tab={tab} card={cardNum} mobile={mobile} boards={boards} needs={needs} actor={actor} onNewBoard={onNewBoard} onRename={onRename} />;

  const b = snap.board;
  // `displayCards` only ever differs from `snap.cards` for the mobile Cards pane mid-beat
  // (see above); `openCard` deliberately reads `snap.cards` regardless, so a card opened
  // during a replay always shows its real, current status rather than the pre-absence one.
  const waiting = displayCards.filter((c) => c.status === "awaiting-human");
  const wontfix = displayCards.filter((c) => c.status === "wontfix");
  const openCard = cardNum ? snap.cards.find((c) => c.num === cardNum) ?? null : null;
  const goTab = (t: BoardTab) => (window.location.hash = tabHref(b.slug, tab, t));
  /** Leaving the card page goes *to* a tab, so it takes the plain route and not the tab bar's
   *  re-tap rule — see `tabHref` (#23). */
  const backToTab = () => (window.location.hash = paneHref(b.slug, lastTab.current));
  /** `instant` comes from the edge-swipe gesture, which has already animated the page off
   *  the screen itself; anything else (the back button, Escape) gets the exit animation. */
  const closeCard = (instant?: boolean) => {
    if (!mobile || instant || prefersReducedMotion()) {
      backToTab();
      return;
    }
    setCardClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setCardClosing(false);
      backToTab();
    }, D_SLOW);
  };

  const saveBody = async (body: string) => {
    await api.updateBoard(b.id, { body });
    setEditingBody(false);
    refresh();
  };

  const saveTitle = async (title: string) => {
    await api.updateBoard(b.id, { title });
    refresh();
  };

  // Delete is the one action here that leaves the board behind: on success there is nothing
  // left to refresh on this screen, so it goes straight to Home instead. Home's own list is
  // told to refetch so the deleted board doesn't linger there stale.
  const deleteBoard = async () => {
    setDeleteErr(null);
    setDeleting(true);
    try {
      await api.deleteBoard(b.id);
      onBoardsChanged();
      window.location.hash = "#/";
    } catch (e) {
      // The server's own message can name the board by its internal id, which has no
      // business on screen, so this path speaks for itself rather than passing that through.
      setDeleteErr(e instanceof ApiError && e.status === 404 ? "This board no longer exists." : "Couldn't delete the board. Try again.");
      setDeleting(false);
    }
  };

  const cardPage = openCard && (
    <CardPage key={openCard.num} boardId={b.id} boardSlug={b.slug} card={openCard} allCards={snap.cards} actors={actors} onChange={refresh} onClose={closeCard} closing={cardClosing} atRest={coldCard.current === openCard.num} />
  );
  // Seeded from the snapshot already on screen (#43): the header's facts and the cards this
  // actor holds are in `snap`, so the sheet opens on real rows and the fetch fills in the
  // history behind them.
  const actorSheet = actorName ? (
    <ActorSheet
      key={actorName}
      open
      boardRef={b.slug}
      name={actorName}
      seed={{ member: snap.team.find((m) => m.name === actorName), holding: snap.cards.filter((c) => c.assignee === actorName) }}
      onClose={() => { dispatchRoster({ type: "leaveActor" }); window.location.hash = backFromActor.current; }}
      // Back is the same navigation as close — the actor view is a route, so leaving it means
      // going back to the one it covered — and then the roster comes with it (#31).
      onBack={() => { dispatchRoster({ type: "back" }); swap(); window.location.hash = backFromActor.current; }}
      showBack={isDeepLinkActor.current || actorFromRoster.current}
      swap={swapping}
      renderCard={(c) => <CardRow card={c} boardSlug={b.slug} actors={actors} />}
    />
  ) : null;
  const newCardSheet = <NewCardSheet open={newCard} boardId={b.id} cards={snap.cards} onClose={() => setNewCard(false)} onCreated={refresh} />;
  const deleteBoardSheet = (
    <DeleteBoardSheet
      open={deleteOpen}
      title={b.title}
      cardCount={snap.cards.length}
      deleting={deleting}
      error={deleteErr}
      onCancel={() => { if (!deleting) { setDeleteOpen(false); setDeleteErr(null); } }}
      onConfirm={deleteBoard}
    />
  );

  const sectionCards = (status: CardStatus) => displayCards.filter((c) => c.status === status);

  if (mobile) {
    // A card open over the board pushes the board back: the same parallax and scrim a
    // screen gets when another is pushed over it, released the moment the page starts out.
    const pushed = !!openCard && !cardClosing;
    // The route's own tab stays "cards" for as long as the card page is on screen (that is
    // what `#/b/<slug>/c/<n>` names), so the pane underneath would otherwise show Cards for
    // the length of the close animation and only jump to the tab the card was opened from
    // once it finishes — the exit plus a second, separate tab-pane transition. While the
    // card is closing, show the destination tab underneath from the first frame instead, so
    // there is only the one transition: the card sliding away over the pane it is about to
    // land on.
    const displayTab: BoardTab = displayTabWhileClosing(tab, cardClosing, lastTab.current, !!actorName);
    const paneClass = tabDir.current ? `tab-pane tab-in-${tabDir.current}` : "tab-pane";
    return (
      <div className={`screen${pushed ? " screen--pushed" : ""}`} ref={screenRef}>
        <div className={paneClass} key={tab}>
          {displayTab === "cards" && (
            <>
              {/* The title and the team stack both moved into the shared top bar (#2): every
                  tab now names the board there, Cards included, and the bar's own team stack
                  replaces the trailing "+" on this one tab (`useTopBarSlot` above, TopBar.tsx).
                  Nothing left to draw here — the body starts straight at the sections. */}
              <CardsScrollBody boardSlug={b.slug} listRef={listRef}>
                {SECTIONS.map((status) => {
                  // Won't-fix lives inside Done, interleaved by close time: it is finished work either way.
                  // Done (and the wontfix cards folded into it) is ordered newest-closed-first.
                  const all =
                    status === "awaiting-human" ? waiting : status === "done" ? closedOrder([...sectionCards(status), ...wontfix]) : sectionCards(status);
                  // Mobile Done is a vertical list already, so there is nothing a fold buys the
                  // reader here that scrolling doesn't (#32): every finished card renders, no
                  // "N more" control, unlike the desktop kanban column beside it.
                  // Only genuine arrivals: a card that was already here when the tab opened
                  // is carried in by the pane's crossfade, not by an entrance of its own.
                  const entrants = new Set([...newCards].filter((id) => all.some((c) => c.id === id)));
                  const orders = enterOrders(all.map((c) => c.id), entrants);
                  const row = (c: Card) => (
                    <CardRow key={c.id} card={c} boardSlug={b.slug} actors={actors} isNew={entrants.has(c.id)} moved={movedCards.has(c.id)} tint={replayTintIds.has(c.id)} style={enterDelay(orders.get(c.id))} />
                  );
                  return (
                    <Section
                      key={status}
                      status={status}
                      count={all.length}
                      onNew={() => setNewCard(true)}
                      nudge={status === "awaiting-human" && all.some((c) => newCards.has(c.id) || movedCards.has(c.id))}
                    >
                      {status === "awaiting-human" ? (
                        <div className="inbox">
                          {all.map((c) => <NeedsYou key={c.id} boardId={b.id} card={c} boardSlug={b.slug} onDone={refresh} isNew={entrants.has(c.id)} moved={movedCards.has(c.id)} tint={replayTintIds.has(c.id)} style={enterDelay(orders.get(c.id))} />)}
                        </div>
                      ) : (
                        <div className="list">
                          {all.map(row)}
                        </div>
                      )}
                    </Section>
                  );
                })}
              </CardsScrollBody>
            </>
          )}
          {displayTab === "channel" && <Channel boardId={b.id} snap={snap} onSent={refresh} />}
          {displayTab === "activity" && <Activity events={events} boardSlug={b.slug} cards={snap.cards} />}
          {displayTab === "decisions" && <Decisions boardId={b.id} snap={snap} onChange={refresh} newIds={newDecisions} />}
        </div>

        {/* --tab-i is which of the four tabs the highlight pill sits over (#38); the CSS
            slides it there. */}
        <nav className="tabbar" style={{ "--tab-i": TAB_ORDER.indexOf(displayTab) } as CSSProperties}>
          {(
            [
              ["cards", "Cards", Icons.cards(26), snap.counts["awaiting-human"]],
              ["channel", "Channel", Icons.chat(26), 0],
              ["activity", "Activity", Icons.pulse(26), 0],
              ["decisions", "Decisions", Icons.flag(26), 0],
            ] as const
          ).map(([key, label, icon, badge]) => (
            <button key={key} className={`tabbar-item ${displayTab === key ? "active" : ""}`} onClick={() => goTab(key)} aria-label={label} aria-current={displayTab === key ? "page" : undefined}>
              <span className="tabbar-icon">
                {icon}
                {badge > 0 && <span className="tabbar-badge">{badge}</span>}
              </span>
            </button>
          ))}
        </nav>

        <Sheet
          open={briefOpen}
          onClose={() => { setBriefOpen(false); setEditingBody(false); }}
          title={b.title}
          lead={<BoardTitle title={b.title} onSave={saveTitle} className="sheet-title" tappable />}
          className="brief-sheet"
          tall
          hideClose
        >
          <div className="muted small">{b.project ? shortPath(b.project) : b.slug}</div>
          {snap.frontier.length > 0 && (
            <div className="stat-row"><span>frontier {snap.frontier.map((n) => `#${n}`).join(" ")}</span></div>
          )}
          {editingBody ? (
            <BodyEditor initial={b.body} onSave={saveBody} onCancel={() => setEditingBody(false)} />
          ) : (
            <>
              {b.body.trim() ? <div className="brief"><Markdownish text={b.body} /></div> : <p className="muted">No brief yet. The brief tells agents the destination, notes, and what's out of scope.</p>}
              <div className="row gap">
                <button className="btn" onClick={() => setEditingBody(true)}>{b.body.trim() ? "Edit brief" : "Write the brief"}</button>
                <a className="btn btn-ghost" href={`/api/boards/${b.id}/export`} target="_blank" rel="noreferrer">Markdown {Icons.external(14)}</a>
              </div>
            </>
          )}
          {/* #28: the sheet's only close affordance now that the top-right X is gone. */}
          <button className="btn btn-block btn-ghost" onClick={() => { setBriefOpen(false); setEditingBody(false); }}>Close</button>
          <div className="sheet-divider" />
          <button className="btn btn-ghost btn-block tone-danger" onClick={() => { setBriefOpen(false); setDeleteOpen(true); }}>{Icons.trash(16)} Delete board</button>
        </Sheet>
        <TeamSheet
        open={roster.open}
        onClose={() => dispatchRoster({ type: "dismiss" })}
        team={snap.team}
        cards={snap.cards}
        scrollTop={roster.scrollTop}
        onEnterActor={(scrollTop) => { dispatchRoster({ type: "enterActor", scrollTop }); actorFromRoster.current = true; swap(); }}
        swap={swapping}
      />
        {newCardSheet}
        {deleteBoardSheet}
        {cardPage}
        {actorSheet}
      </div>
    );
  }

  const effectiveTab = displayTabWhileClosing(tab, false, lastTab.current, !!actorName);
  const pane: Exclude<BoardTab, "cards"> = effectiveTab === "cards" ? "channel" : effectiveTab;
  const { state: boardStateValue, label: boardStateLabel } = boardState(snap.counts);

  /**
   * Put the caret in the right column's composer without walking the board to get there.
   *
   * This is the half of #17 B4 that `tabindex` cannot fix: even with every redundant face
   * demoted, the composer sits after the whole channel in reading order, so Tab reaches it
   * at stop 89 on this board. Both the skip link (the first stop on the page) and `/` come
   * here. Activity is the one pane with nothing to say into, so asking for the composer
   * from there means the channel — and the pane remounts on the swap, hence the retry.
   */
  const focusSideComposer = () => {
    const find = () => document.querySelector<HTMLTextAreaElement>(".board-side .line-composer-input");
    const now = find();
    if (now) { now.focus(); return; }
    goTab("channel");
    let tries = 0;
    const tick = () => {
      const el = find();
      if (el) el.focus();
      else if (tries++ < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Nothing while a card drawer or any popover is up: the drawer traps focus and has a
  // composer of its own, and `n` opening a second surface over a modal is a trap.
  shortcutRef.current = openCard || overlayOpen ? null : (s) => {
    if (s.kind === "new-card") setNewCard(true);
    else if (s.kind === "focus-composer") focusSideComposer();
    else goTab(s.pane);
  };

  return (
    <div className="board-view">
      {/* The first stop on the page, visible only once it has focus: the standard skip link,
          aimed at the one place Tab cannot reach in a reasonable number of presses (#17 B4).
          `/` does the same thing for someone who knows it; this is how they find out there
          is a way, and it is what a screen reader announces first. */}
      <button type="button" className="skip-link" onClick={focusSideComposer}>
        Skip to the message composer
      </button>
      {/* One shell with Home (P1.3): the same bar, the same content box. Navigation left —
          the brand home and a Boards switcher where the sidebar's list used to be — and on
          the right the one action that grows the board, who you are, and the "⋯" menu for
          everything that is not permanent chrome. */}
      <AppTopBar
        boards={boards}
        activeBoard={b.slug}
        needs={needs}
        actor={actor}
        onNewBoard={onNewBoard}
        onRename={onRename}
        action={<button className="btn btn-primary" onClick={() => setNewCard(true)}>{Icons.plus(16)} New card</button>}
        trailing={(
          <Menu label="Board menu" trigger={Icons.more()}>
            {(close) => (
              <>
                {/* The roster's guaranteed way in (#12). The team stack in the title opens it
                    too, but each face in that stack is its own way to that actor (#49), so
                    the list as a list only gets the click when the stack has a "+N" circle.
                    This item always does. */}
                <button role="menuitem" className="menu-item" onClick={() => { close(); dispatchRoster({ type: "open" }); }}>
                  {Icons.person(16)}
                  <span>Team</span>
                </button>
                <button role="menuitem" className="menu-item" onClick={() => { close(); setEditingBody((v) => !v); }}>
                  {Icons.edit(16)}
                  <span>{editingBody ? "Cancel edit" : "Edit brief"}</span>
                </button>
                <a role="menuitem" className="menu-item" href={`/api/boards/${b.id}/export`} target="_blank" rel="noreferrer" onClick={close}>
                  {Icons.external(16)}
                  <span>Markdown</span>
                </a>
                <button role="menuitem" className="menu-item tone-danger" onClick={() => { close(); setDeleteOpen(true); }}>
                  {Icons.trash(16)}
                  <span>Delete board</span>
                </button>
                {/* Web-only, so `flock help` is the wrong place for it (that text is the
                    CLI's). One line at the foot of the menu the reader already opens for
                    everything that is not permanent chrome — not a stop, just a legend. */}
                <div className="menu-divider" />
                <div className="menu-hint">{SHORTCUT_HINT}</div>
              </>
            )}
          </Menu>
        )}
      />

      <div className="board-body">
        <div className="board-main">
          {/* The state and the team are one group, so they sit beside a short title and
              drop to their own line together under a long one. Loose, they wrapped one at a
              time and the pill's dot ended up floating beside the title's second line. */}
          <div className="board-title-block">
            <BoardTitle title={b.title} onSave={saveTitle} className="board-title-h" />
            <div className="board-title-meta">
              <StatusPill state={boardStateValue} label={boardStateLabel} />
              {/* The stack is the roster now (#12, F8/P3.1): the standalone TeamPanel box
                  under the pane repeated these same faces inside a second bordered surface
                  and read "N idle" at rest. A click here opens the same list the phone gets,
                  and who is working on what is already on the Doing tile they hold. */}
              <TeamStack team={snap.team} cards={snap.cards} onOpen={() => dispatchRoster({ type: "open" })} />
            </div>
          </div>

          {waiting.length > 0 && (
            <section className="inbox">
              <h2 className="warn">Waiting on you</h2>
              {waiting.map((c) => <NeedsYou key={c.id} boardId={b.id} card={c} boardSlug={b.slug} onDone={refresh} isNew={newCards.has(c.id)} />)}
            </section>
          )}

          {/* Always present: it is the brief's disclosure row that now carries the repo
              path too (F2), so there is nowhere else on the page that fact lives. */}
          <section className="brief-block">
            {editingBody ? (
              <BodyEditor initial={b.body} onSave={saveBody} onCancel={() => setEditingBody(false)} />
            ) : (
              <Brief text={b.body} slug={b.slug} path={b.project ? shortPath(b.project) : b.slug} />
            )}
          </section>

          <section className="board-block">
            {/* Mirrors the phone's Section: an empty column is not drawn at all, except To
                do, which keeps its head and gains the same "+" the phone section head has —
                there is always somewhere to add a card. Columns render as flexible tracks
                (grid-auto-columns), so however many are left decide the width, not a fixed
                four-up template. */}
            <div className="kanban" ref={kanbanScrollRef} onScroll={onKanbanScroll}>
              {COLUMNS.map((status) => {
                // Done is ordered newest-closed-first, same as the phone, so its fold below
                // and the wontfix list beside it both surface the most recent work first.
                const all = status === "done" ? closedOrder(sectionCards(status)) : sectionCards(status);
                const hasWontfix = status === "done" && wontfix.length > 0;
                if (all.length === 0 && !hasWontfix && status !== "todo") return null;
                // Columns are as tall as their contents now, so an unfolded Done sets the
                // height of the whole board. The kanban keeps its fold (a column is read by
                // scanning across, not scrolling down): the most recent few stay visible, the
                // rest are one click away. The phone's Done is a plain scroll now and shows
                // everything (#32).
                const foldable = status === "done" && all.length > DONE_FOLD_AT;
                const folded = foldable && !doneOpen;
                const cards = folded ? all.slice(0, DONE_FOLD_AT) : all;
                const orders = enterOrders(cards.map((c) => c.id), newCards);
                return (
                  <div key={status} className={`column column-${status}`}>
                    {/* One job: name the column (#12). The status icon is gone — it repeated
                        the word beside it, and the head's own underline already carries the
                        colour for Doing and Waiting. The "+" stays in the DOM (and in the tab
                        order) but only paints once the column is hovered or something inside
                        it is focused; New card in the top bar is the always-visible way in. */}
                    <div className="column-head">
                      <span className="column-head-label">{STATUS_LABEL[status]}</span>
                      <ColumnCount n={all.length} />
                      {status === "todo" && (
                        <button className="section-add icon-btn" onClick={() => setNewCard(true)} aria-label="New card" title="New card">{Icons.plus(16)}</button>
                      )}
                    </div>
                    <div className="column-cards">
                      {all.length === 0 && !hasWontfix && (
                        <p className={`section-empty muted${enterClass(justEmptied.has(status))}`}>{EMPTY_TEXT}</p>
                      )}
                      {cards.map((c) => <CardTile key={c.id} card={c} boardSlug={b.slug} actors={actors} isNew={newCards.has(c.id)} moved={movedCards.has(c.id)} style={enterDelay(orders.get(c.id))} />)}
                      {foldable && (
                        <button className="linkish small" onClick={() => setDoneOpen((v) => !v)}>
                          {folded ? `${all.length - cards.length} more` : "Less"}
                        </button>
                      )}
                      {status === "done" && wontfix.length > 0 && (
                        <>
                          <button className="linkish small" onClick={() => setShowWontfix((v) => !v)}>
                            {showWontfix ? "Hide" : "Show"} {wontfix.length} won't fix
                          </button>
                          {showWontfix && closedOrder(wontfix).map((c) => <CardTile key={c.id} card={c} boardSlug={b.slug} actors={actors} isNew={newCards.has(c.id)} moved={movedCards.has(c.id)} />)}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="board-side">
          {/* The conversation is the only thing on the right now (#12): it takes the whole
              column and scrolls inside itself. The roster moved behind the team stack in the
              title, which is where the phone has always kept it. */}
          <section className="pane-block">
            {/* The head a column wears, on the conversation (#14). What sat here was a
                three-item underlined tab strip — a second navigation system, on the only
                page that had one, drawing its rule at the same height as the board's own
                22px title so the page read as having two headers. It is now the surface's
                name at exactly the rank "To do", "Done" and "Brief" wear, and the other two
                surfaces are the phone tab bar's own glyphs at the head's trailing edge,
                where a column head keeps its count and its "+". One navigation system on
                the page, and the right column reads as the board's fourth column rather
                than as a panel parked beside it. */}
            <div className="pane-head">
              {/* #25/C5: Channel and Activity never carried a count (there is always a
                  message or an event; the pane is never "N of something"), so Decisions'
                  own count was the odd fact out on an otherwise-matching head. One rule
                  across all three now: no count at all. */}
              <span className="pane-head-label">{PANE_TAB_LABEL[pane]}</span>
              <span className="pane-head-switch">
                {(["channel", "activity", "decisions"] as const).map((t, i) => (
                  <button
                    key={t}
                    className={`pane-head-btn icon-btn${pane === t ? " active" : ""}`}
                    onClick={() => goTab(t)}
                    /* The glyph is where the 1/2/3 shortcut is discoverable: a hover on the
                       control the key operates, rather than a legend nobody opens (#17 B4). */
                    title={`${PANE_TAB_LABEL[t]} (${i + 1})`}
                    aria-label={PANE_TAB_LABEL[t]}
                    aria-current={pane === t ? "page" : undefined}
                  >
                    {PANE_ICON[t](16)}
                    {/* The one fact the glyphs drop is the decisions count the old strip
                        carried. A dot, not a number: from the channel, whether this board
                        has decisions at all is the only part worth a glance, and the head's
                        label carries the count once you are on it — so the dot stands down
                        when its own surface is showing. */}
                    {t === "decisions" && pane !== "decisions" && snap.decisions.length > 0 && <span className="pane-head-dot" />}
                    {/* #17 B11/candidate 8: the same dot, lit instead for "this surface grew
                        while you were looking at another one" — Channel and Activity always
                        have *something* in them, so "has any at all" (Decisions' own rule,
                        above) would never stand down. Clears the instant the reader arrives
                        (`usePaneGrowth`, live.ts). */}
                    {(t === "channel" || t === "activity") && paneGrew.has(t) && <span className="pane-head-dot" />}
                  </button>
                ))}
              </span>
            </div>
            {/* The pane's body crossfades on a swap (critique #17 B1): the head above stays
                put, so this is a substitution inside a stable frame, not a navigation — the
                same `tab-in-{dir}` class the phone's tab body already plays, keyed on
                `pane` so each switch remounts and replays it. `tabDir` is the same ref the
                mobile branch uses, computed from `TAB_ORDER`; that order agrees with
                `["channel","activity","decisions"]` for these three, so no second
                direction calculation is needed. */}
            <div className={tabDir.current ? `tab-pane tab-in-${tabDir.current}` : "tab-pane"} key={pane}>
              {pane === "channel" && <Channel boardId={b.id} snap={snap} onSent={refresh} />}
              {pane === "activity" && <Activity events={events} boardSlug={b.slug} cards={snap.cards} desktop />}
              {pane === "decisions" && <Decisions boardId={b.id} snap={snap} onChange={refresh} newIds={newDecisions} />}
            </div>
          </section>
        </aside>
      </div>

      <TeamSheet
        open={roster.open}
        onClose={() => dispatchRoster({ type: "dismiss" })}
        team={snap.team}
        cards={snap.cards}
        scrollTop={roster.scrollTop}
        onEnterActor={(scrollTop) => { dispatchRoster({ type: "enterActor", scrollTop }); actorFromRoster.current = true; swap(); }}
        swap={swapping}
      />
      {newCardSheet}
      {deleteBoardSheet}
      {cardPage}
      {actorSheet}
    </div>
  );
}

/**
 * The brief on desktop: a single disclosure row by default — "Brief", the first line of
 * text, and a chevron — that expands in place. A four-line masked clamp used to push the
 * kanban below the fold on every visit and could not be dismissed; this can. The open/closed
 * choice is remembered per board in localStorage, because it is a property of that brief's
 * length, not of the session.
 */
/**
 * A board this browser has no cached frame for (#43). Everything the route already knows is
 * drawn for real — the way back, the new-card button, the board's name from the slug, the
 * tab bar and both chrome surfaces — and only the part that genuinely needs the server is a
 * placeholder, at the row heights the Cards tab uses (#48) so the swap moves nothing.
 */
function BoardSkeleton({ boardRef, tab, card, mobile, boards = [], needs = [], actor = "", onNewBoard = () => {}, onRename = () => {} }: { boardRef: string; tab: BoardTab; card?: number; mobile: boolean;
  /** Everything the route already knows before the board's own snapshot lands (#21/C2): the
      boards list, who is waiting, and who you are all come from Home's fetch, not this
      board's, so the top bar's switcher and identity are real and functional here, not
      placeholders. Only the pieces that depend on *this* board (its menu, its "New card")
      are drawn as inert shapes. */
  boards?: BoardSummary[]; needs?: NeedsHuman[]; actor?: string; onNewBoard?: () => void; onRename?: () => void }) {
  if (!mobile) {
    return (
      <div className="board-view">
        {/* The bar is real from the first frame — same shell, same component, as the settled
            board (#21/C2): the switcher and identity slots already have their data, so they
            are the live `AppTopBar`, not a redrawn copy of it. Only the board-specific action
            and menu — which need a board this route has not fetched yet — are inert shapes,
            so no control appears or disappears once the snapshot lands. */}
        <AppTopBar
          boards={boards}
          activeBoard={boardRef}
          needs={needs}
          actor={actor}
          onNewBoard={onNewBoard}
          onRename={onRename}
          action={<span className="btn btn-primary sk-btn" aria-hidden>{Icons.plus(16)} New card</span>}
          trailing={<span className="icon-btn" aria-hidden>{Icons.more()}</span>}
        />
        <div className="board-body">
          <div className="board-main">
            {/* Never the slug where the real title will go (F2/B3): the slug and the title
                are different words ("flock-desktop" vs "Flock Desktop"), so printing one and
                swapping to the other is its own small content jump. An empty, growing title
                block is the quieter placeholder. */}
            <div className="board-title-block sk" aria-hidden>
              <h1 className="board-title-h ellipsis"><Line w="34%" /></h1>
            </div>
            <section className="brief-block">
              <div className="brief-disclosure-block sk" aria-hidden>
                <div className="brief-disclosure">
                  <span className="brief-disclosure-label">Brief</span>
                  <Line w="30%" className="sk-meta" />
                </div>
              </div>
            </section>
            <section className="board-block">
              <KanbanSkeleton />
            </section>
          </div>
          <BoardSideSkeleton />
        </div>
        {/* A card route with no board behind it yet: the drawer opens over the board just as
            it will for real, so a card link opened cold does not wait for the snapshot to
            even show its own chrome. */}
        {card !== undefined && (
          <div className="drawer-backdrop">
            <div className="drawer card-page">
              <header className="topbar card-topbar">
                <span className="icon-btn" aria-hidden>{Icons.close()}</span>
                <div className="topbar-center row gap">
                  <span className="status-chip sk-btn" aria-hidden />
                </div>
                <span className="icon-btn" aria-hidden>{Icons.more()}</span>
              </header>
              <CardPageSkeleton mobile={false} />
            </div>
          </div>
        )}
      </div>
    );
  }
  const go = (t: BoardTab) => (window.location.hash = tabHref(boardRef, tab, t));
  return (
    <div className="screen">
      {/* No bar here: the shell's own is already on screen above the push stack, drawn from
          the route — title, avatars and all, since Cards moved its title row into the bar
          (#2) — so a cold load paints a named bar on the first frame either way. */}
      <div className="tab-pane">
        <div className="screen-body">{tab === "cards" && <CardsSkeleton />}</div>
      </div>
      <nav className="tabbar" style={{ "--tab-i": TAB_ORDER.indexOf(tab) } as CSSProperties}>
        {(
          [
            ["cards", "Cards", Icons.cards(26)],
            ["channel", "Channel", Icons.chat(26)],
            ["activity", "Activity", Icons.pulse(26)],
            ["decisions", "Decisions", Icons.flag(26)],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} className={`tabbar-item ${tab === key ? "active" : ""}`} onClick={() => go(key)} aria-label={label} aria-current={tab === key ? "page" : undefined}>
            <span className="tabbar-icon">{icon}</span>
          </button>
        ))}
      </nav>
      {/* A card route with no board behind it yet: the page is a portal over the board on a
          phone, so its skeleton is too, or the board's own placeholder would show through. */}
      {card !== undefined && createPortal(
        <div className="page card-page">
          <CardPageSkeleton mobile />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** A kanban column's count, easing in rather than swapping when it changes (#17 B11): a
 *  new `key` remounts the digit — the same trick the pane body plays on a tab switch — and
 *  `count-fade` (styles.css) is what plays on that remount. Skips its own first mount (a
 *  column's starting count is not a change, and #14's cold-load skeleton already covers
 *  the very first paint), which is why the fade flag lives in a ref the remounted `<span>`
 *  itself cannot keep: `ColumnCount` never remounts, only the span inside it does. */
function ColumnCount({ n }: { n: number }) {
  const settled = useRef(false);
  const fade = settled.current;
  useEffect(() => {
    settled.current = true;
  }, []);
  return <span className={`muted${fade ? " count-fade" : ""}`} key={n}>{n}</span>;
}

function Brief({ text, slug, path }: { text: string; slug: string; path: string }) {
  const key = `flock.brief.${slug}`;
  const read = () => {
    try {
      return localStorage.getItem(key) === "open";
    } catch {
      return false;
    }
  };
  const [open, setOpen] = useState(read);

  useEffect(() => {
    setOpen(read());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(key, next ? "open" : "closed");
      } catch {
        /* private mode: the disclosure still works, it just forgets. */
      }
      return next;
    });
  };

  const firstLine = text
    .split("\n")
    .map((l) => l.replace(/^#{1,4}\s*/, "").replace(/^[-*+]\s+/, "").trim())
    .find((l) => l.length > 0) ?? "";

  return (
    <div className="brief-disclosure-block">
      {/* One quiet line, not three (#12). The brief's own disclosure and the repo path used
          to be two stacked lines between the title and the column heads, each with its own
          rhythm; they are the same kind of fact — where this board is and what it is for —
          so they share a line, the path riding the trailing edge where it stays out of the
          way of the preview beside it. */}
      <button className="brief-disclosure" onClick={toggle} aria-expanded={open}>
        <span className="brief-disclosure-label">Brief</span>
        {!open && <span className="brief-disclosure-preview ellipsis">{firstLine || "No brief yet"}</span>}
        <span className="brief-path ellipsis" title={path}>{path}</span>
        <span className={`brief-chevron${open ? " brief-chevron-open" : ""}`}>{Icons.chevron(14)}</span>
      </button>
      {open && (
        <div className="brief brief-open">
          {text.trim() ? <Markdownish text={text} /> : <p className="muted">No brief yet. The brief tells agents the destination, notes, and what's out of scope.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One status, as a titled group with its muted count. An empty section renders nothing at
 * all — on a board with real history that was half a viewport of sentences explaining zero
 * before the first card. To do is the exception: it keeps its heading and its "+" so there
 * is always somewhere to add a card, and it is the section a card most often arrives in.
 */
export function Section({
  status,
  count,
  hidden = 0,
  onToggleFold,
  onNew,
  nudge,
  children,
}: {
  status: CardStatus;
  count: number;
  /** How many of `count` the fold is currently withholding; 0 when nothing is folded away. */
  hidden?: number;
  onToggleFold?: () => void;
  onNew: () => void;
  /** Something just landed in this section: the heading gives one spring nudge to say so. */
  nudge?: boolean;
  children: ReactNode;
}) {
  if (count === 0 && status !== "todo") return null;
  const headClass = [status === "awaiting-human" && count > 0 ? "warn" : "", nudge ? "nudge" : ""].filter(Boolean).join(" ");
  return (
    <section className={`section section-${status}`}>
      <div className="section-head">
        <h2 className={headClass || undefined}>{STATUS_LABEL[status]}</h2>
        {count > 0 && <span className="section-count">{count}</span>}
        {onToggleFold && (
          <button className="section-fold" onClick={onToggleFold}>{hidden > 0 ? `${hidden} more` : "Less"}</button>
        )}
        {status === "todo" && (
          <button className="section-add icon-btn" onClick={onNew} aria-label="New card">{Icons.plus(18)}</button>
        )}
      </div>
      {count === 0 ? <p className="section-empty muted">{EMPTY_TEXT}</p> : children}
    </section>
  );
}

/**
 * A finished card says so with a tick before its number, the way a blocked one says so with
 * a padlock — a mark plus the row's own dimming, rather than a strike-through through the
 * title, which is the part of the row most likely to be re-read after the fact.
 */
function ClosedGlyph({ status }: { status: CardStatus }) {
  if (status === "done") return <span className="card-check" aria-label="Done" title="Done">{Icons.check(13)}</span>;
  if (status === "wontfix") return <span className="card-check" aria-label="Won't fix" title="Won't fix">{Icons.close(13)}</span>;
  return null;
}

/**
 * Phone list row: the title, the number, and whoever holds it. Nothing else. The model tag
 * and the label chips are operator detail that belongs on the card page, and six identical
 * amber "blocked by #n" pills down a to-do list were noise, not information — a blocked row
 * says so by dimming behind a padlock and spends its width on the title instead.
 */
function CardRow({ card, boardSlug, actors, isNew, moved, tint, style }: { card: Card; boardSlug: string; actors: ActorRuntimes; isNew?: boolean; moved?: boolean; tint?: boolean; style?: CSSProperties }) {
  const runtime = card.assignee ? actors.get(card.assignee) : undefined;
  const kind = runtime?.kind === "human" ? "human" : "agent";
  return (
    <a
      data-anchor
      data-flip={card.id}
      href={`#/b/${boardSlug}/c/${card.num}`}
      className={`list-row card-row status-${card.status} ${card.blocked ? "blocked" : ""}${card.held ? " on-hold" : ""}${enterClass(!!isNew)}${moved ? " moved" : ""}${tint ? " replay-tint" : ""}`}
      style={style}
    >
      <div className="list-main">
        <div className="card-row-line">
          <span className="list-title">{card.title}</span>
          {card.held && (
            <span className="card-hold" title={holdTitle(card)} aria-label={holdTitle(card)}>{Icons.pause(13)}</span>
          )}
          {card.blocked && (
            <span className="card-lock" title={`Blocked by #${card.blockedBy.join(" #")}`} aria-label={`Blocked by #${card.blockedBy.join(" #")}`}>{Icons.lock(13)}</span>
          )}
          <ClosedGlyph status={card.status} />
          <span className="card-num">#{card.num}</span>
        </div>
        {/* The question is the payload of an awaiting-human row, not metadata: it stays. */}
        {card.question && <div className="card-question">{card.question}</div>}
      </div>
      {/* 22px, the title's own line box and Home's row avatars (#48): the disc sits on the
          line rather than over it, so only the row's padding decides its height. */}
      {card.assignee ? <Avatar name={card.assignee} kind={kind} size={22} title={`${card.assignee} has #${card.num}`} /> : <span className="chev">{Icons.chevron(18)}</span>}
    </a>
  );
}

/**
 * Desktop kanban tile — the phone row, laid out for a column (#12).
 *
 * It used to open with five competing atoms before the title: a check glyph, `#n`, an
 * avatar, a name and a model tag, then the title, then an amber `blocked by #n` chip. On a
 * Done column eight tiles deep that is forty pieces of chrome around eight sentences, and it
 * is most of what "the kanban items feel busy" was pointing at. `CardRow`, the phone row, had
 * already made this call and written down why: the model tag and the label chips are
 * operator detail that belongs on the card page, and repeated amber blocked pills are noise,
 * not information. So the tile now says what the row says, in a column's shape:
 *
 *   - the **title** first, loudest, and on a line of its own at the tile's full width. It gets
 *     the whole measure back: sharing the line with `#n` and an avatar the way the phone row
 *     does costs ~55px, and at a 320px column that puts a desktop tile's title *below* the
 *     267px a 390pt phone row gives it — which is finding F1, the one this whole board
 *     started from. A column is not a row; the second line is free here and it is not there;
 *   - one **quiet meta line** under it carrying everything else at caption size: the padlock
 *     if it is blocked, the glyph if it was won't-fixed, `#n`, and who holds it;
 *   - the **model** revealed on hover at the end of that line, so it stays one pointer away
 *     rather than repeating the same four letters down a settled column;
 *   - the **question** kept below, because on an awaiting-human card it is the payload, not
 *     metadata.
 *
 * Gone: the label chips, for the reason `CardRow` gives — operator detail that belongs on the
 * card page — and the amber `blocked by #n` pill, which the padlock and the dim say quieter.
 * Gone too: the tick on a done tile. A column headed "Done" does not need each of its nine
 * tiles to repeat its word; won't fix keeps a glyph, since it is the one closed state the
 * column does not name.
 */
function CardTile({ card, boardSlug, actors, isNew, moved, style }: { card: Card; boardSlug: string; actors: ActorRuntimes; isNew?: boolean; moved?: boolean; style?: CSSProperties }) {
  // The tile is a link, so the face inside it is a second tab stop for a card the reader
  // has already reached — on a 17-card board that was ten extra presses before the pane's
  // own controls (#17 B4). Desktop-only: the tile is the way in, the face keeps its click.
  const runtime = card.assignee ? actors.get(card.assignee) : undefined;
  const kind = runtime?.kind === "human" ? "human" : "agent";
  return (
    <a data-anchor data-flip={card.id} href={`#/b/${boardSlug}/c/${card.num}`} className={`card-tile ${card.blocked ? "blocked" : ""}${card.held ? " on-hold" : ""} status-${card.status}${enterClass(!!isNew)}${moved ? " moved" : ""}`} style={style}>
      <div className="card-title">{card.title}</div>
      <div className="card-tile-meta">
        {card.held && (
          <span className="card-hold" title={holdTitle(card)} aria-label={holdTitle(card)}>{Icons.pause(12)}</span>
        )}
        {card.blocked && (
          <span className="card-lock" title={`Blocked by #${card.blockedBy.join(" #")}`} aria-label={`Blocked by #${card.blockedBy.join(" #")}`}>{Icons.lock(12)}</span>
        )}
        {card.status === "wontfix" && <ClosedGlyph status={card.status} />}
        <span className="card-num">#{card.num}</span>
        {card.assignee && (
          <>
            <Avatar name={card.assignee} kind={kind} size={16} title={`${card.assignee} has #${card.num}`} quiet />
            <span className="assignee-name">{card.assignee}</span>
            <RuntimeTag harness={runtime?.harness} model={runtime?.model} effort={runtime?.effort} />
          </>
        )}
      </div>
      {card.question && <div className="card-question">{card.question}</div>}
    </a>
  );
}

/**
 * The board's title, editable in place: tap it to open a text field, save on blur or Enter,
 * Escape reverts to the title before, and an empty save is rejected — same shape as the card
 * title's own edit (`saveEdit` in CardPage.tsx: `title.trim() || card.title`), just without a
 * description alongside it. Shared by the phone's brief sheet and the desktop header.
 */
function BoardTitle({ title, onSave, className, tappable }: { title: string; onSave: (next: string) => void; className?: string; tappable?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape reverts and blurs the field in the same tick, which would otherwise also fire
  // onBlur's commit; this flag tells that handler to stand down for the blur it caused.
  const skipBlur = useRef(false);

  useEffect(() => { if (!editing) setValue(title); }, [title, editing]);
  useEffect(() => {
    if (!editing) return;
    skipBlur.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const next = value.trim();
    setEditing(false);
    if (next && next !== title) onSave(next);
    else setValue(title);
  };
  const cancel = () => {
    skipBlur.current = true;
    setValue(title);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input input-lg"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (!skipBlur.current) commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        }}
      />
    );
  }
  return (
    <h1
      className={tappable ? `${className ?? ""} title-tappable`.trim() : className}
      title={title}
      role="button"
      tabIndex={0}
      style={{ cursor: "pointer" }}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
    >
      {title}
    </h1>
  );
}

function BodyEditor({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="stack">
      <textarea className="textarea" rows={10} value={v} onChange={(e) => setV(e.target.value)} placeholder={"## Destination\n\n## Notes\n\n## Not yet specified\n\n## Out of scope"} />
      <div className="row gap">
        <button className="btn btn-primary" onClick={() => onSave(v)}>Save brief</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** A quiet way back to the bottom for a reader who has scrolled up. */
function NewPill({ count, onClick }: { count: number; onClick: () => void }) {
  if (count <= 0) return null;
  return (
    <button className="new-pill" onClick={onClick}>
      {count} new {Icons.chevron(14)}
    </button>
  );
}

/**
 * The channel as a conversation rather than a log: consecutive messages from one actor
 * inside five minutes share a single header (avatar, name, time) and stack as bubbles under
 * it, and your own writes go right on a tinted ground with no avatar and no name — in an
 * app about watching agents, "which of these did I write" is the first question the screen
 * has to answer. Scrolling and attachments are untouched.
 *
 * Own sends are optimistic (#31): a submit lands in `pending` and renders immediately —
 * `mergeThread` appends it after `snap.messages` — rather than waiting on `onSent`'s
 * coalesced refetch to bring it back over SSE. `stick()` claims the bottom before that row
 * ever reaches `useStickToBottom`'s id list, so the reader is jumped down for their own
 * write regardless of where they were scrolled, instead of only getting the "N new" pill a
 * plain refetch would show them. The pending entry drops out of the overlay on its own,
 * once the confirmed row it stands in for shows up in `snap.messages`.
 */
function Channel({ boardId, snap, onSent }: { boardId: string; snap: Snapshot; onSent: () => void }) {
  const [pendingSends, setPendingSends] = useState<PendingSend<Message>[]>([]);
  const messages = mergeThread(snap.messages, pendingSends);
  // A remembered position that left the reader pinned to the bottom restores nothing — the
  // hook's own bottom-pin already gives the same "where I left off" for a live log — so only
  // a `bottom: false` position is ever handed in as `restoreTop` (ADR 0013).
  const restored = useMemo(() => readScroll(snap.board.slug, "channel"), [snap.board.slug]);
  const { ref, onScroll, pending, toBottom, stick } = useStickToBottom<HTMLDivElement>(messages.map((m) => m.id), {
    restoreTop: restored && !restored.bottom ? restored.y : null,
    onExit: (pos) => rememberScroll(snap.board.slug, "channel", pos),
  });
  const mobile = useIsMobile();
  const hasFinePointer = useHasFinePointer();
  // The `.pane` ancestor `--composer-h` is already published onto (thread.tsx's
  // LineComposer) — `useScrollCollapse` writes its own continuous `--composer-collapse`
  // custom property on the same element, so styles.css can read both off one ancestor.
  const paneRef = useRef<HTMLDivElement>(null);
  // Desktop only (ADR 0014): "Add to chat" watches the selection inside `ref` (the same
  // scroller `useStickToBottom` already owns) and offers a tip that quotes it into this
  // pane's own composer.
  const addToChat = useAddToChat(ref, !mobile && hasFinePointer);
  // Phone only (#2, continuous per #4): scrolling up toward older messages continuously
  // shrinks the chin toward the card detail composer's resting footprint; scrolling back
  // down, or being pinned to the bottom (`atBottom`, reusing `useStickToBottom`'s own notion
  // rather than a second one), always grows it back to full size.
  const scrollCollapse = useScrollCollapse(ref, mobile, paneRef);
  const newIds = useNewIds(messages.map((m) => m.id));
  // No mount entrance here (#5, reworked): this pane is pinned to the bottom, so the
  // messages on screen are the tail of the list — exactly the ones a top-down stagger holds
  // back longest, which is why arriving on Channel felt worst of the four tabs. The pane
  // crossfade carries them all in together; only real new messages animate.
  const entrants = new Set(newIds);
  const orders = enterOrders(messages.map((m) => m.id), entrants);
  const me = getActorName();
  const groups = groupMessages(messages);
  const sendingIds = new Set(pendingSends.filter((p) => p.sending).map((p) => p.entry.id));
  // Toggle a reaction, then refresh right away rather than waiting on the next SSE-triggered
  // coalesced refetch (#4): the actor's own click is the one case where "up to 600ms later"
  // reads as janky, everyone else's still lands over `useCoalescedRefetch`. A failed toggle
  // just leaves the chip as it was — no rollback to track, since nothing was applied locally.
  const toggleReaction = async (num: number, emoji: string, mine: boolean) => {
    try {
      if (mine) await api.unreact(boardId, num, emoji);
      else await api.react(boardId, num, emoji);
      onSent();
    } catch {
      // best-effort; the chip reconciles on the next refetch either way
    }
  };
  return (
    <div className="pane" ref={paneRef}>
      <div className="pane-body">
        <div
          className="pane-scroll chan-scroll"
          ref={ref}
          onScroll={() => {
            onScroll();
            scrollCollapse.onScroll();
          }}
        >
          {messages.length === 0 && <div className="muted pad">{EMPTY_TEXT}</div>}
          {groups.map((group) => (
            <ThreadGroup
              key={group[0].id}
              group={group}
              mine={!!me && group[0].author === me}
              boardId={boardId}
              entryClass={(m) => enterClass(entrants.has(m.id)) + (sendingIds.has(m.id) ? " pending" : "")}
              entryStyle={(m) => enterDelay(orders.get(m.id))}
              // Double-tap-to-react (#6): the same toggle path and 👍 default the reaction
              // chip's own click already uses; num 0 is the unconfirmed optimistic placeholder,
              // nothing to react to yet.
              onDoubleTapReact={(m) => {
                if (m.num <= 0) return;
                toggleReaction(m.num, DOUBLE_TAP_EMOJI, hasReaction(m.reactions, me, DOUBLE_TAP_EMOJI));
              }}
              entryFooter={(m) =>
                // num 0 is the not-yet-confirmed optimistic placeholder (see onSubmit below);
                // there is nothing to react to until the server has assigned a real one.
                m.num > 0 ? (
                  <MessageReactions
                    reactions={m.reactions}
                    viewer={me}
                    onToggle={(emoji, mine) => toggleReaction(m.num, emoji, mine)}
                  />
                ) : null
              }
            />
          ))}
        </div>
        <NewPill count={pending} onClick={toBottom} />
      </div>
      <AddToChatTip
        info={addToChat}
        onPick={(info) => {
          const quote = quoteBlock(info.text, info.author);
          if (quote) requestInsert(draftKey({ board: boardId, pane: "channel" }), quote);
        }}
      />
      <LineComposer
        className="card-composer"
        compact={mobile && scrollCollapse.collapsed}
        onFocusChange={scrollCollapse.setFocusOverride}
        placeholder="Message the team"
        action="Send"
        boardId={boardId}
        address={{ board: boardId, pane: "channel" }}
        attachable
        onSubmit={async (t, ids, attachments) => {
          const tempId = nextTempId();
          // num 0 is the "not numbered yet" placeholder: the server assigns the real one, and the
          // optimistic row is replaced by `real` the moment it comes back.
          const optimistic: Message = { id: tempId, boardId, num: 0, author: me, authorKind: "human", body: t, createdAt: new Date().toISOString(), attachments, reactions: [] };
          setPendingSends((prev) => [...prev, { tempId, entry: optimistic, sending: true, draftText: t, draftAttachmentIds: ids }]);
          stick();
          try {
            const real = await api.say(boardId, t, ids);
            setPendingSends((prev) => resolvePending(prev, tempId, real));
            onSent();
          } catch (err) {
            setPendingSends((prev) => failPending(prev, tempId));
            throw err;
          }
        }}
      />
    </div>
  );
}

/** Activity's own empty state (#2 design review gap #8): the shared {@link EMPTY_TEXT} says
 *  only "zero"; a feed with nothing in it yet is the one empty state that benefits from
 *  saying what will land here once the team gets moving. */
const ACTIVITY_EMPTY_TEXT = "No activity yet. Claims, comments and closes land here as the team works.";

/**
 * One row shape at both breakpoints (#2 design review): what used to be a footnote-rank,
 * one-line-per-event log on the phone and a separate two-rank tile on desktop (#25/C5) is now
 * the same `EventLine` row everywhere, grouped the same way the channel already is — a day
 * separator, then consecutive events from one actor sharing a single avatar and name
 * (`groupMessages`, its five-minute window unchanged) — so a multi-day feed stays navigable
 * instead of repeating the same face down the screen. `cards` is `snap.cards`, turned into a
 * number-to-title map so a row can name its card instead of leaving a bare `#3`.
 */
function Activity({ events: loaded, boardSlug, cards, desktop }: { events: Event[] | null; boardSlug: string; cards: Card[]; desktop?: boolean }) {
  const events = loaded ?? [];
  const restored = useMemo(() => readScroll(boardSlug, "activity"), [boardSlug]);
  const { ref, onScroll, pending, toBottom } = useStickToBottom<HTMLDivElement>(events.map((e) => e.seq), {
    restoreTop: restored && !restored.bottom ? restored.y : null,
    onExit: (pos) => rememberScroll(boardSlug, "activity", pos),
  });
  const newIds = useNewIds(events.map((e) => e.seq), loaded !== null);
  // No mount entrance, same as Channel above (#5, reworked): bottom-pinned, so a stagger
  // delayed exactly the rows the reader was looking at.
  const entrants = new Set(newIds);
  const orders = enterOrders(events.map((e) => e.seq), entrants);
  const cardTitles = useMemo(() => new Map(cards.map((c) => [c.num, c.title])), [cards]);
  const days = useMemo(() => splitByDay(events), [events]);
  const mobile = !desktop;
  return (
    <div className="pane">
      <div className="pane-body">
        <div className="pane-scroll" ref={ref} onScroll={onScroll}>
          {loaded === null && <ActivitySkeleton mobile={mobile} />}
          {loaded !== null && events.length === 0 && <div className="muted pad">{ACTIVITY_EMPTY_TEXT}</div>}
          {days.map((day) => (
            <div className="evt-day" key={day.label}>
              <div className="evt-day-label">{day.label}</div>
              {groupMessages(day.items.map((e) => ({ ...e, author: e.actor }))).map((run) => (
                <div className="evt-run" key={run[0].seq}>
                  {run.map((e, i) => (
                    <EventLine
                      key={e.seq}
                      e={e}
                      boardSlug={boardSlug}
                      cardTitle={e.cardNum ? cardTitles.get(e.cardNum) : undefined}
                      mobile={mobile}
                      continued={i > 0}
                      isNew={entrants.has(e.seq)}
                      style={enterDelay(orders.get(e.seq))}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
        <NewPill count={pending} onClick={toBottom} />
      </div>
    </div>
  );
}

/** Board state, derived from `snap.counts`: awaiting-human outranks doing, which outranks idle. */
function boardState(counts: Snapshot["counts"]): { state: "warn" | "doing" | "idle"; label: string } {
  const state: "warn" | "doing" | "idle" = counts["awaiting-human"] > 0 ? "warn" : counts.doing > 0 ? "doing" : "idle";
  const label = state === "warn" ? "Awaiting human" : state === "doing" ? "Working" : "Idle";
  return { state, label };
}

/** `d7 #12 <gist>` — the shared head of a decision entry, standing or archived. */
function DecisionGist({ d, boardSlug }: { d: Decision; boardSlug: string }) {
  return (
    <div className="decision-gist">
      <span className="muted tiny">d{d.num}</span> {d.cardNum && <a href={`#/b/${boardSlug}/c/${d.cardNum}`}>#{d.cardNum}</a>} <MessageBody text={d.gist} />
    </div>
  );
}

/** Why an archived decision is archived, as a suffix on its meta line. */
function archivedNote(d: Decision): string {
  if (d.supersededBy) return ` · superseded by d${d.supersededBy}`;
  if (d.archiveReason) return ` · ${d.archiveReason}`;
  return " · archived";
}

function Decisions({ boardId, snap, onChange, newIds }: { boardId: string; snap: Snapshot; onChange: () => void; newIds: ReadonlySet<string | number> }) {
  const mobile = useIsMobile();
  // #8: the same scroll-linked collapse the channel uses, on the same hook and the same CSS.
  // This pane opens at the top, so the shared distance-from-bottom mapping rests it collapsed
  // and expands it as the reader reaches the newest decisions — no second mode.
  const paneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollCollapse = useScrollCollapse(scrollRef, mobile, paneRef);
  // Top-anchored, same as Cards: restored and remembered directly, no bottom pin to defer to.
  const restored = useMemo(() => readScroll(snap.board.slug, "decisions"), [snap.board.slug]);
  const restoreRef = useScrollRestore<HTMLDivElement>(restored, (y) => rememberScroll(snap.board.slug, "decisions", y));
  const combinedScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      (scrollRef as { current: HTMLDivElement | null }).current = el;
      (restoreRef as { current: HTMLDivElement | null }).current = el;
    },
    [scrollRef, restoreRef],
  );
  // `newIds` comes from BoardView's own top-level baseline (arrivals over SSE), and that is
  // now the only thing that animates here: the mount entrance went with Channel's and
  // Activity's (#5, reworked), leaving the pane crossfade to carry the list in.
  const entrants = new Set(newIds);
  const orders = enterOrders(snap.decisions.map((d) => d.id), entrants);
  // #4: standing decisions default; archived ones (and what superseded them) sit behind a
  // disclosure, fetched only once someone opens it rather than padding every snapshot.
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Decision[] | null>(null);
  const [archivedBusy, setArchivedBusy] = useState(false);
  useEffect(() => {
    if (!showArchived || archived !== null) return;
    let live = true;
    setArchivedBusy(true);
    api.decisions(boardId, { archived: "1" })
      .then((rows) => live && setArchived(rows))
      .catch(() => {})
      .finally(() => live && setArchivedBusy(false));
    return () => {
      live = false;
    };
  }, [showArchived, archived, boardId]);
  const archive = (num: number) =>
    api.archiveDecisions(boardId, { nums: [num] }).then(() => {
      onChange();
      // If the archived list is already loaded, it's stale now — drop it so the next look
      // (it's still open) or the next open re-fetches rather than showing a gap.
      if (showArchived) setArchived(null);
    }).catch(() => {});
  const restore = (num: number) =>
    api.restoreDecisions(boardId, { nums: [num] }).then(() => {
      onChange();
      setArchived((prev) => (prev ? prev.filter((d) => d.num !== num) : prev));
    }).catch(() => {});
  return (
    <div className="pane" ref={paneRef}>
      <div className="pane-scroll" ref={combinedScrollRef} onScroll={scrollCollapse.onScroll}>
        {snap.decisions.length === 0 && <div className="muted pad">{EMPTY_TEXT}</div>}
        {snap.decisions.map((d) => (
          <div key={d.id} className={`decision${enterClass(entrants.has(d.id))}`} style={enterDelay(orders.get(d.id))}>
            <div className="decision-row">
              <DecisionGist d={d} boardSlug={snap.board.slug} />
              <button type="button" className="icon-btn decision-action" aria-label={`Archive d${d.num}`} title="Archive" onClick={() => archive(d.num)}>
                {Icons.trash(16)}
              </button>
            </div>
            <div className="muted tiny">{d.author}, {agoText(d.createdAt)}</div>
          </div>
        ))}
        {snap.archivedDecisionCount > 0 && (
          <button type="button" className="disclosure decision-archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
            {showArchived ? "Hide archived" : `Show archived (${snap.archivedDecisionCount})`}
            <span className={`disclosure-chev${showArchived ? " open" : ""}`}>{Icons.chevron(14)}</span>
          </button>
        )}
        {showArchived && snap.archivedDecisionCount > 0 && (
          <div className="decision-archived-list">
            {archivedBusy && <div className="muted pad">Loading…</div>}
            {archived?.length === 0 && <div className="muted pad">No archived decisions.</div>}
            {archived?.map((d) => (
              <div key={d.id} className="decision decision-archived">
                <div className="decision-row">
                  <DecisionGist d={d} boardSlug={snap.board.slug} />
                  <button type="button" className="icon-btn decision-action" aria-label={`Restore d${d.num}`} title="Restore" onClick={() => restore(d.num)}>
                    {Icons.undo(16)}
                  </button>
                </div>
                <div className="muted tiny">{d.author}, {agoText(d.createdAt)}{archivedNote(d)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <LineComposer
        className="card-composer"
        compact={mobile && scrollCollapse.collapsed}
        onFocusChange={scrollCollapse.setFocusOverride}
        placeholder="Record a decision"
        action="Record"
        address={{ board: boardId, pane: "decisions" }}
        onSubmit={(t) => api.decide(boardId, t).then(onChange)}
      />
    </div>
  );
}

function NewCardSheet({ open, boardId, cards, onClose, onCreated }: { open: boolean; boardId: string; cards: Card[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [blockedBy, setBlockedBy] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // #13: React's `autoFocus` calls a plain `focus()`, and on iOS that is the scroll-to-reveal
  // that takes the whole fixed shell with it. Focus after mount with `preventScroll` instead.
  // #15: and on the phone, do not focus at all — see `autoFocusField` in focus.ts.
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => autoFocusField(titleRef.current), 50);
    return () => clearTimeout(id);
  }, [open]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createCard(boardId, {
        title: title.trim(),
        body,
        labels: labels.split(",").map((s) => s.trim()).filter(Boolean),
        blockedBy: blockedBy.split(/[,\s]+/).map((s) => Number(s.replace("#", "").trim())).filter((n) => Number.isInteger(n) && n > 0),
      });
      setTitle(""); setBody(""); setLabels(""); setBlockedBy(""); setMore(false);
      onCreated();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const max = cards.length ? Math.max(...cards.map((c) => c.num)) : 0;
  return (
    <Sheet open={open} onClose={onClose} title="New card" tall hideClose>
      <form className="stack" onSubmit={submit}>
        <input ref={titleRef} className="input input-lg" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="textarea" rows={5} placeholder="Details" value={body} onChange={(e) => setBody(e.target.value)} />
        {/* Only the title is required. Labels and blockers are for the minority of cards
            that have them, so they wait behind a disclosure instead of doubling the sheet. */}
        <button type="button" className="disclosure" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          More options
          <span className={`disclosure-chev${more ? " open" : ""}`}>{Icons.chevron(14)}</span>
        </button>
        {more && (
          <div className="field-row">
            <input className="input grow" placeholder="Labels" value={labels} onChange={(e) => setLabels(e.target.value)} />
            <input className="input grow" placeholder="Blocked by" title={max ? `Card numbers, 1 to ${max}` : "Card numbers"} value={blockedBy} onChange={(e) => setBlockedBy(e.target.value)} inputMode="numeric" />
          </div>
        )}
        {err && <div className="inline-error">{err}</div>}
        <div className="row gap end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>Create card</button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * The one irreversible action on a board, so it gets its own sheet rather than a row in an
 * ActionSheet: a named target, the blast radius spelled out, and a confirm that stays put
 * (and says why) if the request fails, instead of navigating on a guess.
 */
function DeleteBoardSheet({
  open,
  title,
  cardCount,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  cardCount: number;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onClose={onCancel} title={`Delete ${title}?`} hideClose>
      <p>This removes the board, its {cardCount} card{cardCount === 1 ? "" : "s"}, channel and decisions. It can't be undone.</p>
      {error && <div className="inline-error">{error}</div>}
      <div className="row gap end">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={deleting}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleting}>{deleting ? "Deleting…" : "Delete board"}</button>
      </div>
    </Sheet>
  );
}
