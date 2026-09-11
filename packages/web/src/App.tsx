import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getActorName, setActorName, streamPath, type BoardSummary, type NeedsHuman } from "./api.ts";
import { BoardView, type BoardTab } from "./BoardView.tsx";
import { BoardRow } from "./BoardRow.tsx";
import { groupBoardsByActivity } from "./boardActivity.ts";
import { HomeSkeleton, Line } from "./Skeleton.tsx";
import { readSnapshot, snapKey, writeSnapshot } from "./snapshot.ts";
import { entryRedirect, rememberedTab } from "./viewstate.ts";
import { Brand } from "./Mark.tsx";
import { AppTopBar } from "./shell.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { NewBoard } from "./NewBoard.tsx";
import { focusFromUserGesture } from "./focus.ts";
import { enterDelay, enterOrders, GLOBAL_EVENT_TYPES, STAGGER_SLOW_MS, useAnchorScroll, useCoalescedRefetch, useEntranceIds, useLiveStream, useNewIds } from "./live.ts";
import { TopBar, TopBarProvider } from "./TopBar.tsx";
import { keyboardShrunk, readoutRequested, shellHeight } from "./vv.ts";
import { VVReadout } from "./VVReadout.tsx";
import { ActorLinks, Avatar, Icons, OverlayProvider, PromptProvider, PushStack, useEdgeSwipePeek, useIsMobile, usePrompt } from "./ui.tsx";
import { currentSubscription, disablePush, enablePush, primePushKey, pushKeyNow, pushState, readPushEnv, withServerKey, type PushState } from "./push.ts";

/**
 * Reads the hash and remembers which board was last resolved from it, so that only
 * *entering* a board — the slug differing from the one last rendered — can rewrite the hash
 * to a remembered tab (ADR 0013). Without that gate, an in-board tap on Cards (which writes
 * the bare `#/b/<slug>` route too, `paneHref`) would read as a fresh entry and bounce the
 * reader straight back to whatever tab they just left. `entryRedirect` is the single pure
 * check that decides this; `history.replaceState` — never `location.hash =` — edits the
 * current history entry in place rather than pushing one, so Back still leaves a restored
 * board straight to the boards list, exactly as it does today.
 */
function useHash() {
  // undefined, not the initial hash's own board: the very first render has no "previous
  // board" either, and a cold load straight onto a board is exactly the entry a redirect
  // has to fire for.
  const prevBoard = useRef<string | undefined>(undefined);
  const resolve = (h: string): string => {
    const target = entryRedirect(h, prevBoard.current, rememberedTab);
    const next = target ?? h;
    prevBoard.current = parseRoute(next).board;
    if (target) {
      try { window.history.replaceState(null, "", target); } catch { /* nothing to do */ }
    }
    return next;
  };
  const [hash, setHash] = useState(() => resolve(window.location.hash));
  useEffect(() => {
    const on = () => setHash(resolve(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return hash;
}

const TABS: BoardTab[] = ["cards", "channel", "activity", "decisions"];

export interface Route {
  board?: string;
  card?: number;
  /** An actor's view over the board (#49), from `#/b/<slug>/a/<name>`. */
  actor?: string;
  tab: BoardTab;
}

/** `#/b/<slug>`, `#/b/<slug>/c/<n>`, `#/b/<slug>/a/<actor>`, `#/b/<slug>/<tab>`. */
export function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/b\/([^/]+)(?:\/c\/(\d+)|\/a\/([^/]+)|\/([a-z]+))?/);
  if (!m) return { tab: "cards" };
  const tab = TABS.includes(m[4] as BoardTab) ? (m[4] as BoardTab) : "cards";
  return {
    board: decodeURIComponent(m[1]),
    card: m[2] ? Number(m[2]) : undefined,
    actor: m[3] ? decodeURIComponent(m[3]) : undefined,
    tab,
  };
}

export function App() {
  /* #10: read once, on the first render, and never again — an overlay that could appear or
     vanish mid-session would change the very layout it is there to measure. */
  const [readout] = useState(() => readoutRequested(window.location.href));
  return (
    <OverlayProvider>
      <PromptProvider>
        <TopBarProvider>
          <Shell />
          {readout ? <VVReadout /> : null}
        </TopBarProvider>
      </PromptProvider>
    </OverlayProvider>
  );
}

/**
 * Tracks the visual viewport height (it shrinks when the iOS keyboard opens, unlike
 * `dvh`) as a CSS custom property, so the fixed-position mobile shell, full-screen card
 * page, and bottom sheets can size themselves against what is actually visible instead
 * of being covered by the keyboard.
 */
/**
 * #16: what counts as evidence that a keyboard is up.
 *
 * The status-bar/accessory-pill correction below used to take its evidence from the very
 * quantity it was correcting — `raw < rest - 1` — so any short `visualViewport.height` read as
 * a keyboard. The device's resting reading is exactly that (417 against an `innerHeight` of
 * 793 with nothing focused), and the correction then laid the whole app out into the top 40%
 * of the glass. Focus is the evidence instead: a form field holds it, or lost it within the
 * grace, which spans the keyboard's own exit animation so the shell does not snap to full
 * height underneath a keyboard that is still on its way out.
 */
const KB_GRACE_MS = 500;

const isField = (el: Element | null): boolean =>
  !!el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || (el as HTMLElement).isContentEditable === true);

/**
 * #10: the height the shell settles at while a keyboard is up, remembered per orientation.
 *
 * The reason it is worth remembering is the order iOS does things in. On focus WebKit works
 * out whether the focused field will be under the keyboard, and if it will be, it reveals it
 * — by scrolling the layout viewport, or, on a page that cannot scroll (html and body are
 * `overflow: hidden` on the phone), by sliding the visual viewport down inside the layout
 * one, which is `offsetTop`. Only *then* does the keyboard animate, and only then does the
 * page hear about any of it. So by the time --vvh could shrink the composer out of the
 * keyboard's way, WebKit has already decided to move the viewport, and everything after that
 * is the app chasing a compositor animation through eight events — which is the whole of #7,
 * #9 and this card.
 *
 * The way out is to be shrunk *before* WebKit looks. The keyboard's height is not knowable in
 * advance the first time, but it is the same number every time after that, so it is measured
 * once and kept. On the next focus the shell shrinks to it in the same frame as the focus,
 * the composer is already above where the keyboard is going to be, WebKit has nothing to
 * reveal, and offsetTop should never leave zero. The real events overwrite the prediction the
 * moment they arrive, and a prediction nothing confirms is dropped after ~700ms (a hardware
 * keyboard, where no keyboard ever comes).
 */
const KB_STORE = "flock.kbh";
const orientationKey = () => `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;

function readKbHeights(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KB_STORE);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeKbHeight(h: number) {
  try {
    localStorage.setItem(KB_STORE, JSON.stringify({ ...readKbHeights(), [orientationKey()]: Math.round(h) }));
  } catch {
    // Private mode, or storage full. The prediction is an optimisation, not a requirement.
  }
}

/** How long a prediction nothing has confirmed is allowed to stand. */
const PREDICT_MS = 700;

function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) document.documentElement.dataset.standalone = "";
    // The layout viewport's resting height, per orientation. During the keyboard's own resize
    // event the home-screen app reports `innerHeight` already shrunk (it reads full again a
    // moment later), and a --lvh taken from that thinks the home indicator is inside the
    // keyboard-shortened box and pads the sheet's chin for it. So --lvh never drops below
    // the tallest height seen in this orientation; it resets only when the screen turns.
    let rest = 0;
    let orientation = "";
    // #10: the --vvh we are holding ahead of the keyboard, and when we started holding it.
    let predicted = 0;
    let predictedAt = 0;
    // The prediction's own deadline. The frame loop stops once the numbers hold still, and a
    // standing prediction *is* still, so without this nothing would ever come back to retire
    // one that no keyboard turned up to confirm.
    let predictTimer: ReturnType<typeof setTimeout> | undefined;
    // The last height the viewport actually settled at with a keyboard up, learned and kept.
    // #16: `shrunk` is keyboard-gated now, so this no longer learns a resting height as if it
    // were the keyboard's and then predicts every later focus down to it.
    let measured = 0;
    // #16: when a form field last lost focus, and the timer that re-runs `set` once the
    // keyboard's exit grace has expired (the frame loop settles long before it does).
    let fieldBlurAt = -Infinity;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const set = () => {
      const o = `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;
      if (o !== orientation) { orientation = o; rest = 0; }
      rest = Math.max(rest, window.innerHeight);
      const zoomed = (vv?.scale ?? 1) > 1.01;
      const raw = vv ? vv.height : window.innerHeight;
      // #34: in the home-screen app the layout viewport starts under the status bar (page
      // y=0 is 59pt down the screen), but while a keyboard is up iOS reports the visual
      // viewport as *screen* height minus keyboard, as if the page began at the top of the
      // screen. That puts the reported bottom edge 59pt inside the keyboard. The gap is the
      // screen height minus the resting layout height, and it is taken off only in
      // standalone, only while the viewport is shrunk, and only when it is plausibly a
      // status bar (under 100pt), so nothing at rest or in Safari changes.
      // It also draws the keyboard's accessory pill (arrows and checkmark, 37pt) inside
      // that viewport, where Safari counts it as keyboard. Taking the pill off too puts a
      // sheet on top of the pill with its normal chin, which is the Safari look.
      // #16: `shellHeight` owns both halves of this — the correction under a real keyboard, and
      // the floor that makes the standalone shell fill the glass when there is none. See vv.ts.
      const input = {
        raw,
        innerHeight: window.innerHeight,
        clientHeight: document.documentElement.clientHeight,
        rest,
        screenHeight: window.screen?.height ?? 0,
        standalone,
        keyboard: isField(document.activeElement) || performance.now() - fieldBlurAt < KB_GRACE_MS,
      };
      const shrunk = keyboardShrunk(input);
      const real = shellHeight(input);
      // #10: while a prediction is standing and the viewport has not actually shrunk yet,
      // the prediction *is* the height — that is the point of it. The first real report of a
      // shrunk viewport retires it, and so does its own deadline; from then on this is the
      // plain measurement it always was, and nothing downstream can tell the difference.
      if (predicted && (shrunk || performance.now() - predictedAt > PREDICT_MS)) predicted = 0;
      const h = predicted && !shrunk ? predicted : real;
      if (shrunk && real > 100) measured = real;
      document.documentElement.style.setProperty("--vvh", `${h}px`);
      // And where the visible strip *starts*. The phone shell sets `overflow: hidden` on
      // html and body, so when iOS raises the keyboard it cannot scroll the document to
      // reveal the focused field: it slides the visual viewport down inside the layout
      // viewport instead, and `offsetTop` becomes the distance between the two tops. A
      // `position: fixed` box is laid out against the *layout* viewport, so anything meant
      // to sit on the visual viewport's bottom edge — a sheet against the keyboard — has to
      // be pushed down by exactly this much or it floats that far above the keyboard.
      // Ignored while pinch-zoomed, where offsetTop is the pan position and not a keyboard.
      const vvt = vv && !zoomed ? vv.offsetTop : 0;
      document.documentElement.style.setProperty("--vvt", `${vvt}px`);
      // The layout viewport alongside it: iOS does not shrink this one for the keyboard, so
      // it is the height the shell holds while a compose sheet is up — the pane and the tab
      // bar stay where they are and the keyboard simply covers the chin. Only the sheet,
      // which is anchored to --vvh, moves. `innerHeight` lags a rotation on some builds and
      // `vv.height + offsetTop` is the layout height only while the keyboard is up, so take
      // the larger. Read by the sheet's ground and by --below-shell; nothing at rest uses it.
      const lvh = Math.max(window.innerHeight, h + vvt, rest);
      document.documentElement.style.setProperty("--lvh", `${lvh}px`);
      // #34: whether something (a keyboard) is shrinking the visual viewport. The iOS
      // home-screen app draws the keyboard's accessory bar *inside* the visual viewport it
      // reports, where Safari counts it as keyboard, so a sheet on that edge has to leave
      // room for it there; styles.css keys the extra chin off these two attributes.
      if (h + vvt < lvh - 1) document.documentElement.dataset.keyboard = "";
      else delete document.documentElement.dataset.keyboard;
    };
    set();

    // #9: the wobble the events alone cannot fix.
    //
    // iOS animates the keyboard over ~250ms and moves the visual viewport on the compositor
    // the whole way, but it only *tells* the page about it eight or so times. Between two
    // events the shell still holds the offset the last one carried while the viewport has
    // moved on, so `.app`'s `top: var(--vvt)` is wrong by the whole gap — measured at up to
    // 19px above and 12px below its resting place, a 31px round trip — and the last leg of
    // it is the bar climbing back into position: "the top nav bar slides up from the bottom".
    // Chromium cannot reproduce it, because a scripted stub fires an event per frame and the
    // gap never opens; on the phone it is three browsers' worth of the same behaviour.
    //
    // So stop depending on the event rate. While the viewport is moving, resample it every
    // frame; stop as soon as it has held still for a few frames, so nothing runs at rest.
    //
    // #10, honestly: on iOS this loop cannot close that gap, and the device proved it. WebKit
    // *updates* `visualViewport.height` and `offsetTop` when it dispatches the matching
    // event and not before, so reading them every frame returns the same stale pair between
    // events — eight updates in, eight updates out. What the loop is genuinely for is the
    // `data-vv-moving` window it defines: it starts at `focusin`, before the first resize
    // lands, and ends only once the numbers have held still, and styles.css uses that window
    // to hold the shell's own transitions still. It also picks up browsers that *do* move the
    // viewport continuously, where the per-frame read is the whole fix.
    //
    // #13: this comment used to claim styles.css swaps the shell onto `--vvt-a`/`--vvh-a`
    // while the window is open. #12 grepped for those tokens and found them in no stylesheet
    // in the tree — card #10's second fix was described and never written — and then measured
    // what it would have done: a shell left hanging off layout zero travels 58.7px against
    // the 34px it travels anchored to `--vvt`. It is right that it is absent, and the claim
    // is gone with it. The real fix is not to produce an offset at all (focus.ts).
    const STILL_FRAMES = 10;
    let raf = 0;
    let still = 0;
    let last = "";
    const root = document.documentElement;
    const frame = () => {
      const now = `${vv?.height}:${vv?.offsetTop}:${window.innerHeight}`;
      still = now === last ? still + 1 : 0;
      last = now;
      set();
      if (still >= STILL_FRAMES) {
        raf = 0;
        delete root.dataset.vvMoving;
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    // `data-vv-moving` is on the document for exactly as long as the resampling runs, and
    // styles.css uses it to hold every transition and animation on the shell and the bars
    // still: whatever else moves while a keyboard is arriving, the chrome does not.
    const track = () => {
      still = 0;
      last = "";
      root.dataset.vvMoving = "";
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const on = () => { set(); track(); };
    // #10: shrink to the keyboard we already know about, in the same frame as the focus,
    // before WebKit has decided the field needs revealing. Fields only — a button taking
    // focus opens no keyboard — and never while pinch-zoomed, where offsetTop is a pan.
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        /^(INPUT|TEXTAREA)$/.test(el.tagName) &&
        window.matchMedia("(max-width: 899px)").matches &&
        (vv?.scale ?? 1) <= 1.01 &&
        // #15: and only for a focus the human asked for. Mobile engines raise the keyboard
        // for a scripted focus only inside a user gesture, so a focus outside one predicts
        // a keyboard that never arrives — and holds --vvh at the shrunk height for the
        // whole PREDICT_MS, which threw every autofocusing sheet into the top of the
        // screen and dropped it back 700ms later. See focus.ts.
        focusFromUserGesture()
      ) {
        const known = readKbHeights()[orientationKey()];
        // A remembered height only means anything if it is meaningfully shorter than the
        // screen; anything else is a stale or bogus entry and is ignored.
        if (known && known > 100 && known < window.innerHeight - 100) {
          predicted = known;
          predictedAt = performance.now();
          clearTimeout(predictTimer);
          predictTimer = setTimeout(() => { set(); track(); }, PREDICT_MS + 30);
        }
      }
      set();
      track();
    };
    const onFocusOut = (e: FocusEvent) => {
      predicted = 0;
      clearTimeout(predictTimer);
      if (isField(e.target as Element | null)) {
        fieldBlurAt = performance.now();
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => { set(); track(); }, KB_GRACE_MS + 30);
      }
      // Learn on the way out, when the number has had the whole of the keyboard's life to
      // settle, rather than from some frame in the middle of it.
      if (measured > 100) writeKbHeight(measured);
      set();
      track();
    };
    // Focus is the earliest notice there is — the keyboard starts moving before the first
    // resize event lands, so the frame loop has to be running by then.
    vv?.addEventListener("resize", on);
    vv?.addEventListener("scroll", on);
    window.addEventListener("resize", on);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(predictTimer);
      clearTimeout(graceTimer);
      delete root.dataset.vvMoving;
      vv?.removeEventListener("resize", on);
      vv?.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}

function Shell() {
  useVisualViewportHeight();
  const hash = useHash();
  const route = useMemo(() => parseRoute(hash), [hash]);
  const mobile = useIsMobile();
  const prompt = usePrompt();
  // True while a board is being edge-swiped back to Home, so Home can sit behind it.
  const peek = useEdgeSwipePeek();
  // The last frame Home settled on, read synchronously so it is already in state before the
  // first render — not in an effect, which is the whole point (#43): a refresh of Home then
  // paints the list it painted last time and the fetch swaps the same data under a mounted
  // tree, instead of showing the "No boards yet" onboarding for a round trip.
  const [seed] = useState(() => readSnapshot<HomeSnapshot>(snapKey.home));
  const [boards, setBoards] = useState<BoardSummary[]>(() => seed?.boards ?? []);
  const [needs, setNeeds] = useState<NeedsHuman[]>(() => seed?.needs ?? []);
  const [actor, setActor] = useState(getActorName());
  const [dbPath, setDbPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, n] = await Promise.all([api.boards(), api.needsMe()]);
      setBoards(b);
      setNeeds(n);
      setLoaded(true);
      setError(null);
      writeSnapshot(snapKey.home, { boards: b, needs: n });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Every global event funnels through here, so a burst is one boards + needs-me fetch.
  const refresh = useCoalescedRefetch(load);

  const noop = useCallback(() => {}, []);
  const { down } = useLiveStream({
    path: streamPath.all(),
    types: GLOBAL_EVENT_TYPES,
    onEvent: noop,
    onWake: refresh,
    fetchSince: api.allEvents,
  });

  useEffect(() => {
    api.me().then((m) => {
      setDbPath(m.dbPath);
      if (!getActorName()) {
        setActorName(m.actor.name);
        setActor(m.actor.name);
      }
    }).catch(() => {});
    load();
  }, [load]);

  // Register the service worker up front, not only when the notifications toggle is used: a
  // registration has to exist for `currentSubscription()` to read this device's state, and for
  // the postMessage listener below to have anything to listen to. Only where it could work —
  // a secure context with the Push API — so a Tailscale/LAN http:// tab never even tries.
  useEffect(() => {
    if (!window.isSecureContext || !("serviceWorker" in navigator) || typeof PushManager === "undefined") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    // Prefetch the VAPID key here too, not only when the panel opens: on the phone the key is
    // then in hand long before anyone reaches the row, so the toggle's click handler never has
    // to await a network call before `Notification.requestPermission()`.
    primePushKey().catch(() => {});
  }, []);

  // A tap on a notification asks the page to navigate rather than navigating itself (see
  // sw.js): `client.navigate` needs a controlled client, which an uncontrolled tab a push
  // arrived at is not guaranteed to be. `location.hash =`, not `replaceState`, because a tap is
  // a fresh navigation and belongs in the back stack.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "flock:navigate" && typeof e.data.url === "string") {
        window.location.hash = e.data.url;
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    document.title = needs.length ? `(${needs.length}) flock` : "flock";
  }, [needs.length]);

  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const onNewBoard = () => setNewBoardOpen(true);
  // Rendered once below; `board.created` already funnels through the coalesced refetch above.
  const newBoardDialog = <NewBoard open={newBoardOpen} onClose={() => setNewBoardOpen(false)} />;

  const onRename = async () => {
    const name = await prompt({ title: "Your name", placeholder: "Used to sign your answers and comments", initial: actor, submit: "Save name" });
    if (name) {
      setActorName(name);
      setActor(name);
    }
  };

  const errorBanner = error && (
    <div className="banner banner-error">Can't reach the API. Start it with <code>flock serve</code> or <code>flock up</code>.</div>
  );
  // A dropped stream is not worth a banner: a hairline at the top edge, nothing more.
  const streamHint = down && <div className="stream-hint" role="status" aria-label="Reconnecting" />;

  // What the shared bar calls this board before the snapshot lands: the cached boards list
  // if it has it, otherwise the slug from the route — the same fallback the board skeleton's
  // own bar used, so a cold load still paints a named bar on the first frame (#40/#43).
  const boardLabel = route.board
    ? boards.find((b) => b.slug === route.board || b.id === route.board)?.title ?? route.board
    : undefined;

  if (mobile) {
    // Home and a board are two levels of one stack: the push layer keeps whichever you are
    // leaving on screen, sliding, while the one you asked for comes in over it.
    return (
      <div className="app app-mobile">
        {/* The one top bar, above the push stack and above the banners: it is the same DOM
            node on Home, on a board and on a card, so navigating swaps its contents in place
            instead of sliding a second bar past the first, and its y origin never moves. */}
        <TopBar route={route} actor={actor} boardLabel={boardLabel} onNewBoard={onNewBoard} onRename={onRename} />
        {streamHint}
        {errorBanner}
        <PushStack
          routeKey={route.board ?? "#home"}
          depth={route.board ? 1 : 0}
          under={route.board && peek ? <Home boards={boards} needs={needs} actor={actor} onNewBoard={onNewBoard} onRename={onRename} onAnswered={refresh} loaded={loaded} seeded={!!seed} /> : null}
        >
          {route.board ? (
            // Inside a board, every avatar drawn below opens that actor's view (#49).
            <ActorLinks boardRef={route.board}>
              <BoardView key={route.board} boardRef={route.board} cardNum={route.card} actorName={route.actor} tab={route.tab} onBoardsChanged={refresh} />
            </ActorLinks>
          ) : (
            <Home boards={boards} needs={needs} actor={actor} onNewBoard={onNewBoard} onRename={onRename} onAnswered={refresh} loaded={loaded} seeded={!!seed} />
          )}
        </PushStack>
        {newBoardDialog}
      </div>
    );
  }

  // One desktop shell for both routes (P1.3): no sidebar on either, one top bar, one
  // content box. The index needs no board nav because the table below *is* the boards list;
  // a board reaches its neighbours through the bar's Boards switcher.
  if (!route.board) {
    return (
      <div className="app app-desktop">
        {streamHint}
        <main className="main">
          {errorBanner}
          <Home boards={boards} needs={needs} actor={actor} dbPath={dbPath} onNewBoard={onNewBoard} onRename={onRename} onAnswered={refresh} loaded={loaded} seeded={!!seed} />
        </main>
        {newBoardDialog}
      </div>
    );
  }

  return (
    <div className="app app-desktop">
      {streamHint}
      <main className="main">
        {errorBanner}
        {/* `route.board` is set: the index returned its own shell above. */}
        <ActorLinks boardRef={route.board}>
          <BoardView key={route.board} boardRef={route.board} cardNum={route.card} actorName={route.actor} tab={route.tab} onBoardsChanged={refresh} boards={boards} needs={needs} actor={actor} onNewBoard={onNewBoard} onRename={onRename} />
        </ActorLinks>
      </main>
      {newBoardDialog}
    </div>
  );
}

/** What Home caches between visits: exactly the two payloads its own fetch produces. */
interface HomeSnapshot { boards: BoardSummary[]; needs: NeedsHuman[] }

function Home({ boards, needs, actor, dbPath = "", onNewBoard, onRename, onAnswered, loaded, seeded }: { boards: BoardSummary[]; needs: NeedsHuman[]; actor: string; dbPath?: string; onNewBoard: () => void; onRename: () => void; onAnswered: () => void; loaded: boolean; seeded: boolean }) {
  const mobile = useIsMobile();
  // Ages, live dots and the active/idle split decay with time, not only with events: a tick
  // keeps them honest on a board nobody has touched for a while.
  const now = useNow(30_000);
  // Seeded rows are as good a baseline as fetched ones: with the cache on screen from the
  // first frame, what should animate when the fetch lands is the delta since you last
  // looked, not the whole list.
  const ready = loaded || seeded;
  const newIds = useNewIds([...needs.map((n) => `q:${n.id}`), ...boards.map((b) => b.id)], ready);
  // #5: Home remounts fresh every time the reader lands here — leaving a board and coming
  // back, not just the very first visit — so its rows get the same one-time stagger a
  // genuine arrival gets, keyed on `ready` so it fires the instant the list actually has
  // something to show (cached rows on the first frame, or the fetch that follows a cold one).
  const entranceIds = useEntranceIds([...needs.map((n) => `q:${n.id}`), ...boards.map((b) => b.id)], ready);
  const entrants = new Set([...newIds, ...entranceIds]);
  // A question arriving above the board list must not push what the reader is on.
  const anchorRef = useAnchorScroll([...needs.map((n) => n.id), ...boards.map((b) => b.id)].join(" "));
  // Each list takes its own turn: a burst of boards arrives one row after another, at
  // `STAGGER_SLOW_MS` rather than the default — the human's read of the first pass was "a
  // little quick but nice", so the landing (and only the landing) runs 1.3x slower, the
  // duration half of that being the `.screen-body.home .enter` rule in styles.css.
  const needOrders = enterOrders(needs.map((n) => `q:${n.id}`), entrants);
  const boardOrders = enterOrders(boards.map((b) => b.id), entrants);
  const { active: activeBoards, idle: idleBoards } = groupBoardsByActivity(boards, now);

  // Read this device's own state on arrival — never inside a click handler, so the enable
  // button's onClick can call enablePush()/disablePush() as the very first thing it does, with
  // nothing awaited before Notification.requestPermission() breaks the iOS gesture chain.
  const [pushKind, setPushKind] = useState<PushState["kind"]>("off");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    currentSubscription().then((sub) => {
      if (!cancelled) setPushKind(withServerKey(pushState(readPushEnv(!!sub)), pushKeyNow()).kind);
    }).catch(() => {
      if (!cancelled) setPushKind(withServerKey(pushState(readPushEnv(false)), pushKeyNow()).kind);
    });
    return () => { cancelled = true; };
  }, []);
  const onTogglePush = useCallback(() => {
    setPushBusy(true);
    setPushError(null);
    const run = async (): Promise<PushState> => {
      if (pushKind === "on") return disablePush();
      // Gesture-safe: when the key is already primed this awaits nothing before enablePush.
      // The cold path (key not yet resolved) falls back to awaiting the fetch here, which is
      // no worse than today's unconditional fetch — the prefetch just makes it rare.
      const key = pushKeyNow() ?? (await primePushKey());
      if (!key.enabled || !key.publicKey) return { kind: "server-off" };
      return enablePush(key.publicKey);
    };
    run()
      .then((s) => setPushKind(s.kind))
      .catch((e) => setPushError((e as Error).message))
      .finally(() => setPushBusy(false));
  }, [pushKind]);

  return (
    <div className="screen screen-home">
      {!mobile && (
        <AppTopBar actor={actor} dbPath={dbPath} onNewBoard={onNewBoard} onRename={onRename}
          action={<button className="btn btn-primary" onClick={onNewBoard}>{Icons.plus(16)} New board</button>} />
      )}
      {/* On a phone the bar is the shell's, mounted once above the push stack: see TopBar.tsx. */}
      <div className="screen-body home" ref={anchorRef}>
        {/* Silence is the feature: with nothing waiting, the section is absent entirely
            rather than explaining its own emptiness on every visit. */}
        {needs.length > 0 && (
          <section className="inbox">
            <h2 className="warn">Waiting on you</h2>
            {needs.map((c) => (
              <NeedsYou key={c.id} boardId={c.boardId} card={c} boardTitle={c.boardTitle} boardSlug={c.boardSlug} onDone={onAnswered} isNew={entrants.has(`q:${c.id}`)} style={enterDelay(needOrders.get(`q:${c.id}`), STAGGER_SLOW_MS)} />
            ))}
          </section>
        )}

        {/* The large title is a fact about the screen, not about the data, so it is there in
            the first frame whichever of the three below follows it. Mobile drops the label
            entirely (#4): the phone's own top bar already names the screen, so "Boards" here
            is redundant chrome, not information — and with the section unrendered rather than
            hidden, the flex `gap` on `.screen-body.home` closes the space itself instead of
            leaving an empty slot above the list. */}
        {!mobile && (
          <section>
            <h2>
              Boards
              {boards.length > 0
                ? <span className="muted h2-count"> {boards.length}</span>
                /* #21/C2: on a cold Home the count is absent until the fetch lands, then
                   "Boards" gains a trailing number — the same class of jump the skeleton
                   below exists to prevent. Reserve its slot with a bar the same width as a
                   plausible count while nothing is loaded yet; once `loaded` is true the count
                   is real (possibly zero, which the empty state below covers instead). */
                : !loaded && <span className="muted h2-count" aria-hidden><Line w="14px" className="sk-meta" /></span>}
            </h2>
          </section>
        )}

        {/* "No boards yet" is a claim about the server, and until the fetch has resolved
            nobody has made it (#40/#43). An empty list waits: with a cached frame it shows
            that; with nothing cached, skeleton rows at the real row's height. */}
        {boards.length === 0 ? (
          loaded ? (
            <section>
              <div className="empty">
                <p>No boards yet. Create one here, or run <code>flock init</code> inside a project directory. When an agent asks you something, it appears here with an answer box.</p>
                <button className="btn btn-primary" onClick={onNewBoard}>Create a board</button>
              </div>
            </section>
          ) : (
            <HomeSkeleton mobile={mobile} />
          )
        ) : (
          <>
            {/* Server order is the order within a group: state first, then last activity. Active
                vs idle is the only client-side grouping — a filter, not a resort, so needs-you
                boards stay first inside Active exactly as the server ordered them. */}
            {(["active", "idle"] as const).map((group) => {
              const list = group === "active" ? activeBoards : idleBoards;
              if (list.length === 0) return null;
              return (
                <section key={group}>
                  <div className="section-head">
                    <h2>{group === "active" ? "Active" : "Idle"}</h2>
                    <span className="section-count">{list.length}</span>
                  </div>
                  <div className="list">
                    {list.map((b) => <BoardRow key={b.id} b={b} idle={group === "idle"} isNew={entrants.has(b.id)} questions={needs.filter((n) => n.boardId === b.id)} style={enterDelay(boardOrders.get(b.id), STAGGER_SLOW_MS)} />)}
                  </div>
                </section>
              );
            })}
          </>
        )}

        <section className="settings">
          <PushSettingsRow kind={pushKind} busy={pushBusy} error={pushError} onToggle={onTogglePush} />
        </section>
      </div>
    </div>
  );
}

/**
 * One row at the foot of Home. It says what is actually wrong rather than "unsupported",
 * which is the failure mode that would make this feature look broken to the person it is for.
 * `blocked`/`needs-install`/`insecure`/`unsupported` have no button: `requestPermission`
 * cannot recover from `denied`, and none of the other three is a permission problem to retry.
 */
function PushSettingsRow({ kind, busy, error, onToggle }: { kind: PushState["kind"]; busy: boolean; error: string | null; onToggle: () => void }) {
  // Plain text for now — card B restyles this as `.inline-error` in the row's meta slot.
  const errorLine = error && <p>{error}</p>;
  switch (kind) {
    case "on":
      return (
        <>
          <p>Notifications are on for this device.</p>
          {errorLine}
          <button className="btn" onClick={onToggle} disabled={busy}>Turn off</button>
        </>
      );
    case "off":
      return (
        <>
          <button className="btn btn-primary" onClick={onToggle} disabled={busy}>Turn on notifications</button>
          {errorLine}
          <p className="muted">Get a notification when someone posts in a channel, or when a card needs you.</p>
        </>
      );
    case "blocked":
      return <p className="muted">Notifications are blocked. Turn them back on in your browser or device settings.</p>;
    case "needs-install":
      return <p className="muted">Add flock to your Home Screen — Share → Add to Home Screen — then turn notifications on from there.</p>;
    case "insecure":
      return <p className="muted">Notifications need a secure connection. Open flock over HTTPS, or on localhost.</p>;
    case "unsupported":
      return <p className="muted">This browser doesn't support notifications.</p>;
    case "server-off":
      return <p className="muted">This flock server has no notification key, so it can't send anything yet.</p>;
  }
}

/** A bare clock: re-renders on an interval so `timeAgo` and `isActive` keep up with time. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function shortPath(p: string): string {
  const home = p.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  return home ? "~" + p.slice(home.length) : p;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * `timeAgo` as a sentence fragment. "just now" already reads as a time; "just now ago" does
 * not, so the word is appended only to the numeric forms.
 */
export function agoText(iso: string): string {
  const t = timeAgo(iso);
  return t === "just now" ? t : `${t} ago`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return time;
  const datePart = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(d);
  return `${datePart}, ${time}`;
}
