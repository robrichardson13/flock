import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { Route } from "./App.tsx";
import type { Card, TeamMember } from "./api.ts";
import { Brand, Mark } from "./Mark.tsx";
import { ActionSheet, Avatar, Icons, TeamStack } from "./ui.tsx";

/**
 * The phone's top bar, mounted once above the push stack.
 *
 * It used to be five copies of the same markup, one inside each screen, so every navigation
 * unmounted one bar and mounted another and the bar rode whatever motion the *screen* was
 * running — a parallax push between Home and a board, a portal keyframe into a card, nothing
 * at all between tabs. Three edges, three different ways for the same chrome to move.
 *
 * Now there is one `<header className="topbar">` in the document and it never unmounts. Its
 * *contents* change: the shape of the bar (Home, a board, a card) is derived from the route,
 * so it is right on the first frame of a cold load with no snapshot in hand, and the parts
 * that only a screen can supply — the board's real title and the three callbacks behind the
 * buttons — are registered by that screen while it is mounted. The screens keep their push;
 * only the bar stepped out of it.
 */

/** What a screen lends the shared bar while it is on screen. */
export interface TopBarSlot {
  /** The board's title, once the snapshot has it. The bar falls back to the route's slug. */
  title?: string;
  /** Board: tapping the title opens the brief sheet. */
  onOpenBrief?: () => void;
  /** Board: who is on the board, on every tab — the same team stack the title row used to
   *  carry in the body. Undefined until the snapshot lands. */
  team?: TeamMember[];
  /** Board: the board's cards, so the stack can derive live presence. */
  teamCards?: Card[];
  /** Board: tapping the stack opens the roster. */
  onOpenTeam?: () => void;
  /** Card: the overflow menu. */
  onCardMenu?: () => void;
  /** Card: the way back, which the board owns so the exit push and the route stay in step. */
  onCardBack?: () => void;
}

/** Two independent registrations, because a card page is mounted *over* its board. */
export type TopBarSlotName = "board" | "card";

type Slots = Record<TopBarSlotName, TopBarSlot>;
type Titles = { board?: string; card?: string };
/** The board's avatar stack, which the bar also renders and so also needs as state (see
 *  `Titles`) rather than read from the ref alone. `undefined` until the snapshot lands. */
type BoardTeam = { team: TeamMember[]; cards: Card[] } | undefined;
type SetSlot = (name: TopBarSlotName, token: object, value: TopBarSlot | null) => void;

/** Stable for the life of the provider, so registering never re-runs a cleanup. */
const SetCtx = createContext<SetSlot>(() => {});
/** Changes only when something the bar actually *renders* changes — i.e. a title, or the
 *  board's own team stack. */
const ViewCtx = createContext<{ titles: Titles; boardTeam: BoardTeam; slots: MutableRefObject<Slots> }>({
  titles: {},
  boardTeam: undefined,
  slots: { current: { board: {}, card: {} } },
});

export function TopBarProvider({ children }: { children: ReactNode }) {
  // Callbacks live in a ref and are read at click time, never during render: they get a new
  // identity on every render of the screen that owns them, and a state write per render would
  // be a loop. Only what the bar actually renders — the title, and the board's team stack —
  // is state.
  const slots = useRef<Slots>({ board: {}, card: {} });
  // Which instance currently holds each slot. `PushStack` keeps the screen you are leaving
  // mounted for the length of the animation, and `key={route.board}` remounts on a
  // board-to-board move, so an unmounting screen's cleanup routinely runs *after* its
  // replacement has already registered. Without an owner check it would clear the live one.
  const owners = useRef<Record<TopBarSlotName, object | null>>({ board: null, card: null });
  const [titles, setTitles] = useState<Titles>({});
  const [boardTeam, setBoardTeam] = useState<BoardTeam>(undefined);

  const set = useCallback<SetSlot>((name, token, value) => {
    if (value === null) {
      if (owners.current[name] !== token) return;
      owners.current[name] = null;
      slots.current[name] = {};
      setTitles((t) => (t[name] === undefined ? t : { ...t, [name]: undefined }));
      if (name === "board") setBoardTeam(undefined);
      return;
    }
    owners.current[name] = token;
    slots.current[name] = value;
    setTitles((t) => (t[name] === value.title ? t : { ...t, [name]: value.title }));
    // `team`/`teamCards` only ever come from the board slot, and only carry a stable
    // reference across re-renders that don't touch `snap` — same trick as `title` above, so
    // this skips a state write (and a bar re-render) on the common no-op commit.
    if (name === "board") {
      setBoardTeam((prev) =>
        prev?.team === value.team && prev?.cards === value.teamCards
          ? prev
          : value.team ? { team: value.team, cards: value.teamCards ?? [] } : undefined,
      );
    }
  }, []);

  const view = useMemo(() => ({ titles, boardTeam, slots }), [titles, boardTeam]);
  return (
    <SetCtx.Provider value={set}>
      <ViewCtx.Provider value={view}>{children}</ViewCtx.Provider>
    </SetCtx.Provider>
  );
}

/**
 * A screen hands the bar its title and its actions for as long as it is mounted. Pass `null`
 * to hold no slot at all (desktop, where each view keeps its own bar).
 */
export function useTopBarSlot(name: TopBarSlotName, value: TopBarSlot | null): void {
  const set = useContext(SetCtx);
  const token = useRef({}).current;
  const latest = useRef(value);
  latest.current = value;
  // After every commit, so the callbacks the bar calls are this render's. `set` only
  // re-renders anything when the title changed, so this is a ref write in the common case.
  useEffect(() => {
    set(name, token, latest.current);
  });
  useEffect(() => () => set(name, token, null), [set, name, token]);
}

/**
 * The bar's *measured* height, published to the document as `--topbar-real-h`, and
 * `data-topbar` while the bar is on screen at all (i.e. on the phone).
 *
 * Everything that has to stop exactly where the bar stops — the card page below it, and every
 * modal backdrop, which must leave the bar undimmed so iOS never samples a dimmed strip for
 * the status bar (#34) — reads that one number instead of re-deriving it from
 * `--topbar-h + --sat`. Re-deriving is what broke: the token is only the bar's *minimum*, so
 * anything that makes the real bar taller (a safe-area inset the backdrop's copy of the
 * expression resolves differently, a wrapped or scaled title, a border) moved the two edges
 * apart and the backdrop cut into the bar. A `ResizeObserver` cannot disagree with the bar.
 */
function useTopBarHeight() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    root.dataset.topbar = "";
    const measure = () => root.style.setProperty("--topbar-real-h", `${el.getBoundingClientRect().height}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The safe-area inset is part of the bar's height and changes on rotation, which does not
    // always resize the element the observer is watching.
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      delete root.dataset.topbar;
      root.style.removeProperty("--topbar-real-h");
    };
  }, []);
  return ref;
}


/**
 * Which of the bar's three shapes to draw.
 *
 * The route alone would say "card" for the whole length of the close animation: it only drops
 * the card segment once the animation finishes and the board's own delayed navigation lands
 * (`closeCard` in BoardView.tsx holds the route on purpose, so the board can slide back in
 * step with the page leaving — see `cardClosing`). `CardPage` yields the card slot the moment
 * it starts closing, so `cardSlotHeld` — driven off `titles.card`, which is only defined while
 * something actually holds the slot — goes false at that same instant. Falling back to
 * "board" then, instead of waiting on the route, is what makes the bar swap to the board's
 * title and team stack (always registered, and identical regardless of which tab is
 * underneath) the moment the close starts rather than only once the card page unmounts.
 */
export function topBarShape(hasBoard: boolean, hasCard: boolean, cardSlotHeld: boolean): "home" | "board" | "card" {
  if (!hasBoard) return "home";
  return hasCard && cardSlotHeld ? "card" : "board";
}

/**
 * The bar itself. `boardLabel` is what the route alone knows the board is called — the slug,
 * or the title from the cached boards list — so a board opened cold names itself before the
 * snapshot lands, exactly as the skeleton's own bar used to.
 */
export function TopBar({ route, actor, boardLabel, onNewBoard, onRename, onOpenNotifications }: {
  route: Route;
  actor: string;
  boardLabel?: string;
  onNewBoard: () => void;
  onRename: () => void;
  /** Identity action sheet's second entry: opens the push notifications panel (#5, card C). */
  onOpenNotifications: () => void;
}) {
  const { titles, boardTeam, slots } = useContext(ViewCtx);
  const shape = topBarShape(!!route.board, route.card !== undefined, titles.card !== undefined);
  const ref = useTopBarHeight();
  // The phone avatar used to fire `onRename` directly; it is now the second door to
  // notifications (§1.3), so it opens an action sheet with both entries instead.
  const [identityOpen, setIdentityOpen] = useState(false);

  let content: ReactNode;
  if (shape === "home") {
    content = (
      <>
        <span className="topbar-title brand-name"><Brand size={22} /></span>
        <button className="icon-btn" onClick={onNewBoard} aria-label="New board">{Icons.plus()}</button>
        <button className="icon-btn" onClick={() => setIdentityOpen(true)} aria-label={`Signed in as ${actor}. Account menu`}>
          <Avatar name={actor || "?"} kind="human" size={28} />
        </button>
        <ActionSheet
          open={identityOpen}
          onClose={() => setIdentityOpen(false)}
          title={actor || "Account"}
          actions={[
            { label: "Change your name", icon: Icons.person(20), onSelect: onRename },
            { label: "Notifications", icon: Icons.bell(20), onSelect: onOpenNotifications },
          ]}
        />
      </>
    );
  } else if (shape === "card") {
    // An `<a>`, not a button: on a cold load straight onto a card URL nothing has registered
    // yet and the href is still the right way back. Once the board is there it owns the exit
    // — it slides back in as the page leaves — so the handler wins.
    content = (
      <>
        <a
          className="icon-btn"
          href={`#/b/${route.board}`}
          aria-label="Back to board"
          onClick={(e) => {
            const back = slots.current.card.onCardBack;
            if (!back) return;
            e.preventDefault();
            back();
          }}
        >
          {Icons.back()}
        </a>
        {/* The number used to sit alone above the heading in the body — the "stray card
            number" — with nothing to say it belonged to the chrome rather than the content.
            It reads as chrome here, the same slot the board's own title occupies. Only the
            number: the full title already lives once, in the body's own heading, and this
            slot used to repeat it — duplicated text, and unbounded it could push the bar
            wider than the screen on a long title. `titles.card` is just "#n" now (see
            CardPage), but the ellipsis and max-width stay on as a safety net regardless. */}
        <div className="topbar-center row gap">
          {titles.card && <span className="topbar-title topbar-title-muted ellipsis">{titles.card}</span>}
        </div>
        <button className="icon-btn" onClick={() => slots.current.card.onCardMenu?.()} aria-label="More actions">{Icons.more()}</button>
      </>
    );
  } else {
    content = (
      <>
        {/* Home is the app, so the way out of a board is the app's own mark behind the
            chevron iOS puts there — the same 44px target, wearing the brand. */}
        <a className="icon-btn brand-back" href="#/" aria-label="All boards">{Icons.back(18)}<Mark size={28} /></a>
        {/* Every tab now names the board here, Cards included: it used to keep its own large
            title in the body, iOS-style, but that meant a board opened three ways (title in
            the bar, title in the body, no title at all on a cold Cards load) — one look now,
            same as Channel, Activity and Decisions already had. */}
        <button className="topbar-title-btn" onClick={() => slots.current.board.onOpenBrief?.()}>
          <span className="topbar-title ellipsis">{titles.board ?? boardLabel ?? route.board}</span>
        </button>
        {/* Every tab trades the trailing "+" for who is on the board — the team stack the
            title row used to carry beside its own name. New card keeps a way in on Cards: the
            To do section grows its own "+" (`Section`), same as it always has for a column
            with nothing folded above it. The other tabs have no equivalent "New card" affordance,
            which is fine — Cards is the one place a card gets created. */}
        {boardTeam ? (
          <TeamStack team={boardTeam.team} cards={boardTeam.cards} cap={3} size={22} onOpen={() => slots.current.board.onOpenTeam?.()} />
        ) : (
          <span className="grow" />
        )}
      </>
    );
  }

  // The header never unmounts; the slot inside it is keyed by shape, so moving between the
  // three fades the contents in place over the same bar instead of sliding a second bar past
  // the first. A tab switch keeps the same key, so the title swaps with no animation at all,
  // which is what it did before.
  return (
    <header className="topbar" ref={ref}>
      <TopBarSlot key={shape}>{content}</TopBarSlot>
    </header>
  );
}

/**
 * #13: the fade is a one-shot, not a standing declaration.
 *
 * The slot used to carry `animation: fade-in ... both` permanently and rely on the remount to
 * replay it. #12 measured what that costs: card #9's `html[data-vv-moving] .topbar-slot
 * { animation: none !important }` guard goes on at every `focusin` and off ten frames later,
 * and toggling `animation: none` off *restarts* a standing animation from its first keyframe
 * — two full fades of the whole bar's contents from opacity 0, one as the keyboard finishes
 * rising and one as it finishes falling. That was the "second bar arriving over the first".
 *
 * Carrying the animation on a class the slot drops on `animationend` means the declaration is
 * only present for the 220ms it is actually running, so nothing that toggles `animation`
 * afterwards has anything to restart.
 */
function TopBarSlot({ children }: { children: ReactNode }) {
  const [entering, setEntering] = useState(true);
  return (
    <div
      className={`topbar-slot${entering ? " topbar-slot-enter" : ""}`}
      onAnimationEnd={() => setEntering(false)}
    >
      {children}
    </div>
  );
}
