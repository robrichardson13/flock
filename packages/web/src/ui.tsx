import { createContext, useCallback, useContext, useEffect, useLayoutEffect as useLayoutEffectClient, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ActorKind, CardStatus, TeamMember } from "@flock/core/types";
import { actorHref, avatarColor, groupRoster, initialsOf, isActive, presenceOf, rosterCaption, rosterCounts, ROSTER_GROUPS, shortAge } from "./people.ts";
import { autoFocusField } from "./focus.ts";
import { D_BASE, D_FAST, D_SLOW } from "./motion.ts";

/* ---------- viewport ---------- */

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Below this width the app is a stack of full-screen pages; above it, sidebar + kanban. */
export const MOBILE_QUERY = "(max-width: 899px)";
export const useIsMobile = () => useMedia(MOBILE_QUERY);

/** A mouse or trackpad, as opposed to a finger: `useIsMobile` alone is width-based, so a
 *  wide touch device (an iPad in landscape) would otherwise be treated as desktop. */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
export const useHasFinePointer = () => useMedia(FINE_POINTER_QUERY);

/* ---------- edge swipe back ---------- */

const EDGE_ZONE_PX = 24;
const CLOSE_DISTANCE_FRACTION = 0.35;
const CLOSE_VELOCITY_PX_MS = 0.5;
const CLOSE_ANIM_MS = 180;
/** Velocity at release is computed from samples within this trailing window, so a
 * fast flick followed by a pause before lifting the finger doesn't still read as fast. */
const VELOCITY_WINDOW_MS = 100;

/** The motion durations, mirrored from the --d-* tokens in styles.css. A JS timer that
 *  outlives a CSS animation (a sheet closing, a page leaving) is timed off these. Sourced
 *  from `motion.ts`, the one place these are typed out — re-exported here so every
 *  existing `import { D_FAST } from "./ui.tsx"` keeps working. */
export { D_BASE, D_FAST, D_SLOW };

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * iOS-style edge swipe-to-go-back. Attach to a ref on the full-screen page element.
 * Only touch pointers starting within `EDGE_ZONE_PX` of the left edge begin tracking.
 * Dragging translates the element horizontally; releasing past a distance or velocity
 * threshold animates it off-screen and calls `onClose`, otherwise it springs back.
 */
export function useEdgeSwipeBack(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled: boolean, onPeek?: (active: boolean) => void) {
  // CardPage passes a fresh onClose every render; keep the latest in a ref so the
  // effect below doesn't need onClose in its deps (which would tear the gesture down
  // mid-drag on every re-render, e.g. from an SSE-driven board refresh).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // Told when the drag really starts and when it is finally over, for a caller that has to
  // put something behind the screen being dragged (a board reveals Home; a card page has the
  // board under it already).
  const onPeekRef = useRef(onPeek);
  useEffect(() => {
    onPeekRef.current = onPeek;
  }, [onPeek]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let tracking = false;
    let decided = false;
    // True from the moment a close is committed until onClose actually fires (after
    // the exit animation, or immediately under reduced motion). Blocks a second touch
    // during that window so onClose can run at most once.
    let closing = false;
    let startX = 0;
    let startY = 0;
    let pointerId: number | null = null;
    let exitTimer: number | null = null;
    let peekTimer: number | null = null;
    let samples: { t: number; x: number }[] = [];

    /** Whatever is showing behind the drag goes away only once the drag is really over —
     *  after the spring back has played out, or on the commit once the route has changed. */
    const endPeek = (afterMs: number) => {
      if (peekTimer !== null) window.clearTimeout(peekTimer);
      if (afterMs <= 0) {
        peekTimer = null;
        onPeekRef.current?.(false);
        return;
      }
      peekTimer = window.setTimeout(() => {
        peekTimer = null;
        onPeekRef.current?.(false);
      }, afterMs);
    };

    const clearExitTimer = () => {
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer);
        exitTimer = null;
      }
    };

    const releaseCapture = (id: number | null) => {
      if (id === null) return;
      try {
        el.releasePointerCapture(id);
      } catch {
        // Pointer may already be released (e.g. after pointercancel); ignore.
      }
    };

    const reset = () => {
      releaseCapture(pointerId);
      tracking = false;
      decided = false;
      pointerId = null;
      samples = [];
      el.style.transition = "";
      el.style.transform = "";
    };

    const trimSamples = (nowT: number) => {
      const cutoff = nowT - VELOCITY_WINDOW_MS;
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
    };

    const velocityAt = (nowT: number, nowX: number): number => {
      if (samples.length === 0) return 0;
      const first = samples[0];
      const dt = nowT - first.t;
      return dt > 0 ? (nowX - first.x) / dt : 0;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (tracking || closing) return;
      const x = e.clientX;
      if (x > EDGE_ZONE_PX) return;
      tracking = true;
      decided = false;
      pointerId = e.pointerId;
      startX = x;
      startY = e.clientY;
      samples = [{ t: e.timeStamp, x }];
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Some pointer types may not support capture; the drag still works via bubbling.
      }
      el.style.transition = "none";
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!decided) {
        // Not enough movement yet to tell drag direction; keep waiting.
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical scroll intent: abandon the gesture.
          reset();
          return;
        }
        decided = true;
        if (peekTimer !== null) {
          window.clearTimeout(peekTimer);
          peekTimer = null;
        }
        onPeekRef.current?.(true);
      }
      samples.push({ t: e.timeStamp, x: e.clientX });
      trimSamples(e.timeStamp);
      const clamped = Math.max(0, dx);
      el.style.transform = `translateX(${clamped}px)`;
    };

    const finish = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      trimSamples(e.timeStamp);
      const dx = Math.max(0, e.clientX - startX);
      const width = window.innerWidth || 1;
      const velocity = velocityAt(e.timeStamp, e.clientX);
      const shouldClose = decided && (dx / width > CLOSE_DISTANCE_FRACTION || velocity > CLOSE_VELOCITY_PX_MS);
      if (!shouldClose) {
        reset();
        // Clearing the inline transform hands the element back to its own transition, so the
        // spring back takes one full duration and what is behind it has to stay until then.
        endPeek(D_SLOW);
        return;
      }
      releaseCapture(pointerId);
      tracking = false;
      decided = false;
      pointerId = null;
      samples = [];
      closing = true;
      if (prefersReducedMotion()) {
        el.style.transition = "";
        el.style.transform = "";
        closing = false;
        onCloseRef.current();
        endPeek(0);
        return;
      }
      el.style.transition = `transform ${CLOSE_ANIM_MS}ms ease-out`;
      el.style.transform = `translateX(${width}px)`;
      exitTimer = window.setTimeout(() => {
        exitTimer = null;
        el.style.transition = "";
        el.style.transform = "";
        closing = false;
        // The route change and the peek going away land in one commit, so the screen behind
        // is never taken down a frame before the real one arrives.
        onCloseRef.current();
        endPeek(0);
      }, CLOSE_ANIM_MS);
    };

    const onPointerUp = (e: PointerEvent) => finish(e);
    const onPointerCancel = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== pointerId) return;
      reset();
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      // Unmounting (or disabling) mid-exit-animation must not fire onClose afterwards.
      clearExitTimer();
      if (peekTimer !== null) window.clearTimeout(peekTimer);
      onPeekRef.current?.(false);
      reset();
    };
  }, [ref, enabled]);
}

/* ---------- push stack ---------- */

/**
 * Whether an edge-swipe back is currently dragging a screen aside. The shell subscribes so
 * it can put the screen one level up behind the one being dragged: without it the gesture
 * pulls a board off a blank ground, which is the one thing that gives away that this is not
 * a real navigation stack.
 *
 * A module-level signal rather than context: the publisher is a board, several levels down,
 * and the subscriber is the shell above it — routing this through props would thread a
 * callback through everything in between for a value that lives for 300ms.
 */
const peekSubs = new Set<(v: boolean) => void>();
export function setEdgeSwipePeek(active: boolean) {
  for (const f of peekSubs) f(active);
}
export function useEdgeSwipePeek(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    peekSubs.add(setActive);
    return () => {
      peekSubs.delete(setActive);
    };
  }, []);
  return active;
}

/**
 * One route change that must not animate. The edge-swipe gesture has already carried the
 * outgoing screen off the right edge itself by the time it changes the route; replaying the
 * push would snap it back to where it started and slide it out a second time. CardPage
 * solves the same problem with its `instant` close; a screen has no owner to tell, so the
 * gesture leaves this flag and the next PushStack decision consumes it.
 */
let skipNextPush = false;
export function skipNextPushAnimation() {
  skipNextPush = true;
}
function consumeSkipPush(): boolean {
  const skip = skipNextPush;
  skipNextPush = false;
  return skip;
}

/**
 * The phone's screen stack. `children` is whatever the route resolves to; when `routeKey`
 * changes, the screen that was there stays mounted for one animation while the new one
 * slides over it (or, going back, out from under it). `depth` decides which way: a deeper
 * route pushes, a shallower one pops.
 *
 * Both screens are siblings keyed by route, so React keeps the outgoing screen's own
 * instance — its stream, its scroll, its data — for the length of the animation instead of
 * remounting it behind the arriving one and flashing "Loading…" while it leaves.
 *
 * Under reduced motion no previous layer is kept at all: the swap is what it always was.
 */
export function PushStack({ routeKey, depth, children, under }: { routeKey: string; depth: number; children: ReactNode;
  /** Rendered behind everything, parallaxed and dimmed, while an edge-swipe back is dragging
   *  the current screen aside: what the reader is swiping *to*. */
  under?: ReactNode }) {
  type Layer = { key: string; node: ReactNode; dir: "fwd" | "back" };
  const [prev, setPrev] = useState<Layer | null>(null);
  // The route on screen and the element that drew it, advanced after the commit: during the
  // render that notices a new route this still holds the one being left.
  const last = useRef({ key: routeKey, node: children, depth });
  // The layer decided for this route change. The decision is made during render, so the
  // outgoing screen is in place on the same paint the incoming one arrives on — a layer
  // added in an effect would show one frame of the new screen sitting still first — and it
  // is remembered so that re-running the render (StrictMode does, twice) decides the same
  // thing rather than a second, different one.
  const pending = useRef<{ to: string; layer: Layer | null } | null>(null);
  if (last.current.key !== routeKey) {
    if (pending.current?.to !== routeKey) {
      const from = last.current;
      pending.current = {
        to: routeKey,
        // Consumed first, and unconditionally: under reduced motion there is no layer either
        // way, and a flag left set would silence the *next* push instead of this one.
        layer: consumeSkipPush() || prefersReducedMotion() ? null : { key: from.key, node: from.node, dir: depth >= from.depth ? "fwd" : "back" },
      };
    }
    // Asked for on every invocation of this render, not just the first, because React may
    // run the render function more than once and keeps only the last run's updates — and
    // stopped once the state holds it, or the render-phase update would never terminate.
    if (prev !== pending.current.layer) setPrev(pending.current.layer);
  }
  useEffect(() => {
    last.current = { key: routeKey, node: children, depth };
  });

  useEffect(() => {
    if (!prev) return;
    // A timer, not `animationend`: that event bubbles, so every row easing in inside the
    // arriving screen would end the push early.
    const t = window.setTimeout(() => setPrev(null), D_SLOW + 40);
    return () => window.clearTimeout(t);
  }, [prev]);

  const layers: { key: string; node: ReactNode; cls: string; stale?: boolean }[] = [];
  if (under) layers.push({ key: "#peek", node: under, cls: "push-layer push-peek", stale: true });
  if (prev) layers.push({ key: prev.key, node: prev.node, cls: `push-layer push-out-${prev.dir}`, stale: true });
  layers.push({ key: routeKey, node: children, cls: prev ? `push-layer push-in-${prev.dir}` : "push-layer" });
  return (
    <div className="push-root">
      {layers.map((l) => (
        <div key={l.key} className={l.cls} aria-hidden={l.stale || undefined}>
          {l.node}
        </div>
      ))}
    </div>
  );
}

/* ---------- fold ---------- */

/**
 * A section's hidden tail, animating its own height. The rows are mounted only while the
 * fold is open (or closing), so a collapsed Done costs nothing and never leaves a stack of
 * zero-height `[data-flip]` nodes for the FLIP to measure positions from.
 *
 * Opening mounts the rows collapsed and expands them on the next frame, since a grid row
 * cannot transition from a height it was never rendered at.
 */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setMounted(open);
      setExpanded(open);
      return;
    }
    if (open) {
      setMounted(true);
      // Two frames, as in useFlip: one for the browser to take the collapsed row as the
      // start of the transition. With one, the mount and the expansion land in the same
      // style recalculation and the rows simply appear.
      let inner = 0;
      const raf = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(raf);
        cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    const t = window.setTimeout(() => setMounted(false), D_BASE);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={`fold${expanded ? " open" : ""}`}>
      <div className="fold-inner">{children}</div>
    </div>
  );
}

/* ---------- status ---------- */

/**
 * The app's one empty state. Four hand-written sentences ("Nobody is working on anything.",
 * "No open questions.", "Nothing queued.") said the same thing — zero — in three voices and
 * cost half a viewport on a busy board. Most empty sections now render nothing at all; the
 * few that must still say something say exactly this.
 */
export const EMPTY_TEXT = "Nothing here yet.";

export const STATUS_LABEL: Record<CardStatus, string> = {
  todo: "To do",
  doing: "Doing",
  "awaiting-human": "Needs you",
  done: "Done",
  wontfix: "Won't fix",
};

export function StatusIcon({ status, size = 16 }: { status: CardStatus; size?: number }) {
  const common = { className: `status-icon status-${status}`, viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true };
  switch (status) {
    case "todo":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" />
        </svg>
      );
    case "doing":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5 A3.5 3.5 0 0 1 8 11.5 Z" fill="currentColor" />
        </svg>
      );
    case "awaiting-human":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="var(--status-ink)" fontFamily="inherit">?</text>
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path d="M5 8.3l2 2 4-4.4" fill="none" stroke="var(--status-ink)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "wontfix":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--status-ink)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}

/* ---------- people ---------- */

/** Desktop top bar's state pill: the one ambient "is anything running" signal, next to the name. */
export function StatusPill({ state, label }: { state: "warn" | "doing" | "idle"; label: string }) {
  return (
    <div className={`status-pill status-pill--${state}`}>
      <span className="status-pill-dot" />
      {label}
    </div>
  );
}

/**
 * Initials on a colour derived from the name, so the same actor is recognisable at a
 * glance anywhere on the board. Humans are set apart by shape rather than by hue, which
 * is already carrying identity: an agent is a circle, a person a rounded square with a ring.
 */
export function Avatar({
  name,
  kind,
  size = 22,
  live,
  presence,
  title,
  plain,
  quiet,
}: {
  name: string;
  kind: ActorKind;
  size?: number;
  live?: boolean;
  /** Working/idle dot, keyed off the same determination as the roster's "N idle" count.
   * Takes precedence over `live`: pass one or the other, not both. */
  presence?: "working" | "idle";
  title?: string;
  /** Draw the face and nothing else: for the avatar that *is* you (the sidebar's own name
   *  button) and for the actor view's own header, where a tap would go where you already are. */
  plain?: boolean;
  /**
   * Still a click and still an `aria-label`, but not its own tab stop (critique #17 B4).
   *
   * On the phone a face is a rare, deliberate target and earning a `tabindex` is right. On a
   * desktop kanban it multiplies: the team stack cost six stops, every assigned tile cost
   * two, and every message in the channel cost one more beside the author's name — so Tab
   * from the top bar reached the pane's own buttons at stop 29 and its composer at 137, and
   * in practice the right-hand column was keyboard-unreachable. Set on the faces that sit
   * *inside* something already focusable (the tile link, the team-stack button, the identity
   * button) or immediately beside a link to the same place (the bubble's author name): the
   * containing control is the way in, and the pointer keeps every affordance it had.
   */
  quiet?: boolean;
}) {
  // Inside a board, a face is a way in to that actor (#49). The tap lives on the avatar
  // element itself rather than a wrapper, so every layout that positions `.avatar` — the
  // thread's absolute gutter avatar, the card row's trailing disc, the header stack's
  // overlap — is untouched by making it interactive.
  const boardRef = useContext(ActorLinkCtx);
  const tappable = !!boardRef && !plain;
  const dotClass = presence ? ` presence-${presence}` : live ? " live" : "";
  // Initials have a floor: below 9px they are a smudge, not a name. An avatar smaller than
  // 20px cannot hold legible initials at all, so it stays a plain coloured shape.
  const showInitials = size >= 20;
  const go = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    window.location.hash = actorHref(boardRef!, name);
  };
  return (
    <span
      className={`avatar ${kind}${dotClass}${tappable ? " avatar-tap" : ""}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), background: avatarColor(name, kind) }}
      title={title}
      {...(tappable
        ? {
            role: "button",
            tabIndex: quiet ? -1 : 0,
            "aria-label": `About ${name}`,
            onClick: go,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") go(e);
            },
          }
        : { "aria-hidden": true })}
    >
      {showInitials ? initialsOf(name) : null}
    </span>
  );
}

/**
 * Which board's actor view an avatar opens (#49). A provider rather than a prop on every
 * avatar: the same face is drawn by the card rows, the header stack, the roster, the team
 * sheet and every thread bubble, and threading a slug through all of them would be five
 * changes for one fact the board already knows. Null outside a board, where a tap has
 * nowhere to go and the avatar stays a plain mark.
 */
const ActorLinkCtx = createContext<string | null>(null);

export function ActorLinks({ boardRef, children }: { boardRef: string; children: ReactNode }) {
  return <ActorLinkCtx.Provider value={boardRef}>{children}</ActorLinkCtx.Provider>;
}

/**
 * Makes whatever it wraps — an avatar, a name, both — open that actor's view.
 *
 * A span with a button role rather than an anchor, because half these faces sit *inside* a
 * card row that is itself a link, and an anchor inside an anchor is invalid. The click is
 * stopped and defaulted before it navigates, so tapping the avatar on a card row opens the
 * actor instead of the card underneath the finger.
 */
export function ActorTap({ name, className, children }: { name: string; className?: string; children: ReactNode }) {
  const boardRef = useContext(ActorLinkCtx);
  if (!boardRef) return <>{children}</>;
  const go = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    window.location.hash = actorHref(boardRef, name);
  };
  return (
    <span
      className={className ? `actor-tap ${className}` : "actor-tap"}
      role="button"
      tabIndex={0}
      aria-label={`About ${name}`}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") go(e);
      }}
    >
      {children}
    </span>
  );
}

type RosterCard = { num: number; title: string; assignee: string | null; status: CardStatus };

/**
 * Header team stack: a tight overlap of up to 5 avatars (live actors first, then newest
 * write first) plus a "+N" circle for the rest, rather than a flat wall of every
 * actor the board has ever seen. A click opens the roster (#30); the "+N" circle is the only
 * overflow count shown, so there is nothing beside it to keep in sync.
 */
export function TeamStack({ team, cards, cap = 5, size = 26, onOpen }: {
  team: TeamMember[];
  cards: RosterCard[];
  /** How many avatars before the rest collapse into "+N". The phone header shows four. */
  cap?: number;
  size?: number;
  /** What a tap does: open the roster. There is one roster on both platforms now (#31), so
   *  there is nothing else it could do and no fallback to keep. */
  onOpen: () => void;
}) {
  if (team.length === 0) return null;
  const ordered = [...team].sort((a, b) => {
    const al = isActive(a.lastSeen), bl = isActive(b.lastSeen);
    if (al !== bl) return al ? -1 : 1;
    return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
  });
  const shown = ordered.slice(0, cap);
  const overflow = ordered.length - shown.length;
  const title = ordered.map((m) => m.name).join(", ");
  // The stack is itself a button and the only way in: every face inside it is `plain`, so a
  // tap on a face opens the roster same as a tap anywhere else in the cluster, rather than
  // jumping straight to that actor's view (#30). The actor view stays reachable from a
  // roster row and by URL. On desktop this also keeps the stack a single tab stop, since a
  // plain avatar takes no tabIndex of its own (#17 B4).
  return (
    <button className="team-stack" onClick={onOpen} title={title} aria-label={`Team: ${title}`}>
      <span className="team-stack-avatars">
        {shown.map((m, i) => (
          <span key={m.name} className="team-stack-item" style={{ zIndex: shown.length - i }}>
            <Avatar name={m.name} kind={m.kind} size={size} presence={presenceOf(m, cards)} plain />
          </span>
        ))}
        {overflow > 0 && (
          <span className="team-stack-item" style={{ zIndex: 0 }}>
            <span className="avatar avatar-overflow" style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}>+{overflow}</span>
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The roster, behind the header stack: every actor this board has ever seen, and the only
 * way in to one of them since #30.
 *
 * Rebuilt in #31 as the app's own row system rather than a list of its own. It was 29 rows of
 * "agent · sonnet · 5 writes · last 3h" — 5.0 text atoms a row against Home's 4 and the
 * kanban tile's two ranks, with three of the five saying the same words on every row, and the
 * name itself drawn as a coloured link in two hues that only restated the shape of the avatar
 * beside it. The one actor actually working sat third in a flat `lastSeen` order,
 * indistinguishable from the twenty-six the board only remembers.
 *
 * So: grouped by what they are doing, a head that counts them, and one `.list-row` each —
 * name first, then a single caption line (`rosterCaption`). Nothing new is fetched; it is
 * `snap.team` and `snap.cards`, same as the stack.
 */
export function TeamSheet({ open, onClose, team, cards, scrollTop = 0, onEnterActor, swap }: {
  open: boolean;
  onClose: () => void;
  team: TeamMember[];
  cards: RosterCard[];
  /** Where the list was when it was last stepped out of, restored on the way back (#31). */
  scrollTop?: number;
  /** A row was taken: hand back where the list is, so `back` can put it there again. */
  onEnterActor?: (scrollTop: number) => void;
  swap?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const groups = groupRoster(team, cards);
  // Restoring before paint rather than after: an `useEffect` here scrolls the list *while*
  // the panel is sliding in, which reads as the roster scrolling itself on arrival.
  useLayoutEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = scrollTop;
    // Only on the transition into `open`: re-running on every `scrollTop` change would fight
    // the reader's own scrolling, since this is where that number comes from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Capture, not bubble: `ActorTap` stops the click once it has navigated, so a handler on
  // the container would never see it. This runs first and only records where we are.
  const mark = () => onEnterActor?.(bodyRef.current?.scrollTop ?? 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      tall
      className="roster-sheet side-panel"
      title="Team"
      trail={team.length > 0 ? <span className="sheet-count">{rosterCounts(groups)}</span> : undefined}
      bodyRef={bodyRef}
      swap={swap}
    >
      <div
        className="roster"
        onClickCapture={mark}
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" || e.key === " ") mark();
        }}
      >
        {team.length === 0 && <p className="muted">{EMPTY_TEXT}</p>}
        {ROSTER_GROUPS.map(({ key, label }) =>
          groups[key].length === 0 ? null : (
            <section className="section roster-section" key={key}>
              <div className="section-head">
                <h2>{label}</h2>
                <span className="section-count">{groups[key].length}</span>
              </div>
              <div className="list">
                {groups[key].map((m) => <RosterRow key={m.name} m={m} cards={cards} />)}
              </div>
            </section>
          ),
        )}
      </div>
    </Sheet>
  );
}

/**
 * One actor, in the two ranks a Home row and a kanban tile wear since #15 and #12: the name
 * on its own line, then one quiet caption. The face is `plain` — the row is the way in, so a
 * second tap target inside it would only be a `role="button"` inside a `role="button"` (the
 * argument #30 made about the team stack) — and the harness rides in the row's tooltip, where
 * `RuntimeTag` has always kept it.
 */
function RosterRow({ m, cards }: { m: TeamMember; cards: RosterCard[] }) {
  const runtime = [m.model, m.harness, m.effort ? `effort: ${m.effort}` : null].filter(Boolean).join(" · ");
  return (
    <ActorTap name={m.name} className="list-row roster-row">
      <Avatar name={m.name} kind={m.kind} size={22} presence={presenceOf(m, cards)} plain />
      <span className="list-main">
        <span className="list-title">{m.name}</span>
        <span className="roster-cap ellipsis" title={runtime || undefined}>{rosterCaption(m, cards)}</span>
      </span>
      <span className="chev">{Icons.chevron(18)}</span>
    </ActorTap>
  );
}

/**
 * The way back one level, for the `lead` slot of a sheet that is a step in a flow (#31).
 * Reads as iOS's back does — a chevron and the name of the place it returns to — rather than
 * as a second ✕ beside the first.
 */
export function SheetBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="sheet-back" onClick={onClick}>
      {Icons.back(16)}
      <span>{label}</span>
    </button>
  );
}

/**
 * Dim suffix naming what ran: model inline (the field worth reading at a glance), harness and
 * effort folded into the tooltip. Renders nothing when there is no model to show.
 */
export function RuntimeTag({ harness, model, effort }: { harness?: string; model?: string; effort?: string }) {
  if (!model) return null;
  const title = [harness, effort ? `effort: ${effort}` : null].filter(Boolean).join(" · ") || undefined;
  return (
    <span className="runtime" title={title}>
      {model}
    </span>
  );
}

/** `useLayoutEffect` where there is a layout, `useEffect` where there is not: these
 *  components are also rendered to static markup by the test harness, and React warns for
 *  every layout effect run on a server. */
const useLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffectClient;

/* ---------- overlay tracking ---------- */

/**
 * How many Sheets (including ActionSheet and the PromptProvider's sheet) are currently
 * open, anywhere in the tree. A full-screen page (CardPage) checks this before letting
 * Escape close itself, so Escape closes only the top-most overlay instead of both it and
 * the page beneath it.
 */
const OverlayCountCtx = createContext<{ inc: () => void; dec: () => void }>({ inc: () => {}, dec: () => {} });
const OverlayOpenCtx = createContext(0);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const inc = useCallback(() => setCount((c) => c + 1), []);
  const dec = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  const api = useRef({ inc, dec }).current;
  return (
    <OverlayCountCtx.Provider value={api}>
      <OverlayOpenCtx.Provider value={count}>{children}</OverlayOpenCtx.Provider>
    </OverlayCountCtx.Provider>
  );
}

/** True while any Sheet or anchored popover is open — the stack Escape unwinds one at a time. */
export const useAnyOverlayOpen = () => useContext(OverlayOpenCtx) > 0;

/* ---------- anchored menu (desktop popover) ---------- */

/**
 * The controlled half of the desktop's one popover: a `.menu-wrap` holding whatever button
 * opened it and, while open, the `.menu` itself — anchored, no backdrop, closing on an
 * outside pointerdown or Escape.
 *
 * `Menu` below owns its own open state and is the shape most callers want. This one exists
 * for the callers whose open state is already somewhere else and whose trigger is not a
 * plain icon button: the card drawer's status chip, its "⋯", and the two Details rows that
 * lead somewhere (#23). Those were centred modals opening ~950px from the control that
 * summoned them, which is the cohesion break #16 F3 named; they are this now.
 *
 * It counts itself in the overlay stack for as long as it is up. That is what makes Escape
 * close the topmost thing only: the drawer's own Escape handler stands down while any
 * overlay is open, and before #23 a popover was not one, so a single Escape over an open
 * Move-to would have taken the drawer with it.
 *
 * It stays mounted for one `D_FAST` after `open` goes false, wearing a `.closing` class, so
 * `popover-out` (board-desktop.css) has something to animate rather than the menu vanishing
 * on the frame it was told to close (#17 B5) — the same trick `Sheet` and the drawer use.
 */
export function AnchoredMenu({ open, onClose, align = "right", menuClass, trigger, children }: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  menuClass?: string;
  /** The caller's own button. It must live inside the wrap, or an outside click would close
   *  the menu on the same pointerdown the button then toggles back open. */
  trigger: ReactNode;
  children: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const overlay = useContext(OverlayCountCtx);
  // The same "hold mounted while closing" trick `Sheet` and the drawer already use (#17
  // B5): unmounting on `open === false` would cut the exit animation off at frame one, so
  // the popover stays in the DOM for one `D_FAST` while `popover-out` plays, showing
  // whatever it last showed rather than going blank mid-exit.
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(open);
  const shown = useRef<ReactNode>(children);
  if (open) shown.current = children;
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, D_FAST);
    return () => window.clearTimeout(t);
  }, [open, mounted]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("mousedown", onDown);
    // Capture, so the popover answers Escape before anything listening on the bubble phase
    // (the drawer) sees it at all.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    overlay.inc();
    return () => overlay.dec();
  }, [open, overlay]);
  return (
    <div className="menu-wrap" ref={wrap}>
      {trigger}
      {mounted && (
        <div className={`menu menu-${align}${menuClass ? ` ${menuClass}` : ""}${closing ? " closing" : ""}`} role="menu">
          {open ? children : shown.current}
        </div>
      )}
    </div>
  );
}

/**
 * The one small popover the desktop uses for pick-one menus: anchored to its own trigger,
 * no backdrop, closes on an outside pointerdown or Escape. It started as the board's "⋯"
 * menu (P1.1); the boards switcher (P1.3) is the second caller, and the card drawer's four
 * lists are the rest of them (#23) through `AnchoredMenu` above, which this is a
 * self-opening icon button over.
 *
 * `children` is a render prop taking `close`, because every item in a menu dismisses it and
 * the item should not have to remember to.
 */
export function Menu({ label, trigger, triggerClass = "icon-btn", align = "right", menuClass, children }: {
  label: string;
  trigger: ReactNode;
  triggerClass?: string;
  align?: "left" | "right";
  menuClass?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <AnchoredMenu
      open={open}
      onClose={close}
      align={align}
      menuClass={menuClass}
      trigger={(
        <button
          type="button"
          className={`${triggerClass}${open ? " is-open" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
        >
          {trigger}
        </button>
      )}
    >
      {children(close)}
    </AnchoredMenu>
  );
}

/* ---------- sheets ---------- */

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open, onClose]);
}

/**
 * Bottom sheet on phones, centred dialog on desktop.
 *
 * A closed sheet stays mounted for `D_BASE` so `sheet-down` and the backdrop fade can play —
 * the same `closing` state the desktop drawer has always had. What it renders while it
 * leaves is what it was showing when it was told to close: the caller usually clears the
 * state the body was built from in the same tick (the prompt's request, the label being
 * edited), and an empty sheet sliding away reads as a bug.
 */
export function Sheet({ open, onClose, title, lead, trail, children, foot, tall, className, sheetRef, bodyRef, swap, hideClose }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Before the title: the way back one level, when the sheet is a step in a flow (#31). */
  lead?: ReactNode;
  /** After the title, before the ✕ on the phone and at the head's trailing edge on desktop. */
  trail?: ReactNode;
  children: ReactNode;
  /**
   * Rendered as `.sheet-body`'s sibling, inside `.sheet` (which never clips — only
   * `.sheet-body`'s own `overflow: auto` does) but outside the scrolling body. `.sheet-body`
   * clips at its own box, which sits *inside* `.sheet`'s horizontal padding; a full-bleed
   * child that cancels that padding with a negative margin (`.composer-flush`, #13) needs to
   * escape that box to avoid being clipped by the scrollport it would otherwise sit in. Use
   * this for that kind of child rather than `children`.
   */
  foot?: ReactNode;
  tall?: boolean;
  className?: string;
  sheetRef?: RefObject<HTMLDivElement>;
  /** The scrolling element, for a caller that restores where its list had been left (#31). */
  bodyRef?: RefObject<HTMLDivElement>;
  /**
   * This sheet is replacing another one in the same rect rather than arriving over the page
   * (#31: the roster and the actor view are the same panel at two depths). It crossfades in
   * place instead of sliding, so a step forward or back reads as a substitution rather than
   * as one panel leaving and an unrelated one coming.
   */
  swap?: boolean;
  /** #28: a sheet with its own bottom Cancel/Close button does not also need the top-right X
   *  — two ways to do the same thing read as a mistake, and the human said so. Pass this
   *  once the caller has a bottom button; Escape and the backdrop tap still close it either
   *  way. Left false (the X shown) only where a bottom button is not reasonable. */
  hideClose?: boolean;
}) {
  useEscape(open, onClose);
  const overlay = useContext(OverlayCountCtx);
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(open);
  const shown = useRef<{ title?: string; lead?: ReactNode; trail?: ReactNode; children: ReactNode; foot?: ReactNode }>({ title, lead, trail, children, foot });
  if (open) shown.current = { title, lead, trail, children, foot };
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    // Nothing to play out: either it was never up, or motion is off and it goes at once.
    if (!mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, D_BASE);
    return () => window.clearTimeout(t);
  }, [open, mounted]);
  useEffect(() => {
    if (!open) return;
    overlay.inc();
    return () => overlay.dec();
  }, [open, overlay]);
  if (!open && !mounted) return null;
  const body = open ? { title, lead, trail, children, foot } : shown.current;
  return createPortal(
    <div className={`sheet-backdrop${closing ? " closing" : ""}${swap ? " sheet-swap" : ""}`} onClick={onClose}>
      <div ref={sheetRef} className={`sheet ${tall ? "sheet-tall" : ""} ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={body.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden />
        {/* #28: one close affordance per sheet. A tall sheet can fill the backdrop (the
            home-screen app, or any short phone), so the tap-outside-to-dismiss has nothing to
            tap — the X used to be the way out that stayed on screen regardless. Now every
            sheet with a bottom Cancel/Close button passes `hideClose` and relies on that,
            Escape, or the backdrop instead; the X remains only where a bottom button is not
            reasonable (see each caller). */}
        {body.title && (
          <div className="sheet-head">
            {body.lead}
            <div className="sheet-title">{body.title}</div>
            {body.trail}
            {!hideClose && <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="Close">{Icons.close(18)}</button>}
          </div>
        )}
        <div className="sheet-body" ref={bodyRef}>{body.children}</div>
        {body.foot}
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction {
  label: string;
  hint?: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
}

export function ActionSheet({ open, onClose, title, actions }: { open: boolean; onClose: () => void; title?: string; actions: SheetAction[] }) {
  return (
    <Sheet open={open} onClose={onClose} title={title} hideClose>
      <div className="action-list">
        {actions.map((a) => (
          <button
            key={a.label}
            className={`action-item ${a.tone ? `tone-${a.tone}` : ""}`}
            disabled={a.disabled}
            onClick={() => {
              onClose();
              a.onSelect();
            }}
          >
            {a.icon && <span className="action-icon">{a.icon}</span>}
            <span className="action-label">{a.label}</span>
            {a.hint && <span className="action-hint">{a.hint}</span>}
          </button>
        ))}
      </div>
      <button className="btn btn-block btn-ghost sheet-cancel" onClick={onClose}>Cancel</button>
    </Sheet>
  );
}

/* ---------- prompt (replaces window.prompt) ---------- */

export interface PromptSpec {
  title: string;
  placeholder?: string;
  initial?: string;
  submit?: string;
  hint?: string;
  inputMode?: "text" | "numeric";
  /** True for a field the caller treats as genuinely optional (e.g. an optional hold
   *  reason): submitting blank resolves with `""` rather than being blocked. Every other
   *  prompt keeps requiring a non-empty value. */
  allowEmpty?: boolean;
}

type PromptFn = (spec: PromptSpec) => Promise<string | null>;
const PromptCtx = createContext<PromptFn>(() => Promise.resolve(null));
export const usePrompt = () => useContext(PromptCtx);

export function PromptProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ spec: PromptSpec; resolve: (v: string | null) => void } | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A second prompt() while one is pending must resolve the first with null before
  // replacing it, so an `await prompt(...)` never hangs forever.
  const pending = useRef<((v: string | null) => void) | null>(null);

  const prompt = useCallback<PromptFn>((spec) => {
    return new Promise((resolve) => {
      pending.current?.(null);
      pending.current = resolve;
      setValue(spec.initial ?? "");
      setReq({ spec, resolve });
    });
  }, []);

  useEffect(() => {
    if (!req) return;
    // #13: `preventScroll`, and #15: desktop only — see `autoFocusField` in focus.ts.
    const id = setTimeout(() => autoFocusField(inputRef.current), 50);
    return () => clearTimeout(id);
  }, [req]);

  const finish = (v: string | null) => {
    pending.current = null;
    req?.resolve(v);
    setReq(null);
  };
  const submit = () => {
    if (value.trim()) finish(value.trim());
    else if (req?.spec.allowEmpty) finish("");
  };

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      <Sheet open={!!req} onClose={() => finish(null)} title={req?.spec.title} hideClose>
        {req && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input ref={inputRef} className="input" placeholder={req.spec.placeholder} inputMode={req.spec.inputMode} value={value} onChange={(e) => setValue(e.target.value)} />
            {req.spec.hint && <div className="muted small">{req.spec.hint}</div>}
            <div className="row gap end">
              <button type="button" className="btn btn-ghost" onClick={() => finish(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!value.trim() && !req.spec.allowEmpty}>{req.spec.submit ?? "Save"}</button>
            </div>
          </form>
        )}
      </Sheet>
    </PromptCtx.Provider>
  );
}

/* ---------- icons (inline, 20px stroke) ---------- */

const I = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
export const Icons = {
  back: (s?: number) => <I size={s} d="M15 5l-7 7 7 7" />,
  chevron: (s?: number) => <I size={s} d="M9 5l7 7-7 7" />,
  plus: (s?: number) => <I size={s} d="M12 5v14M5 12h14" />,
  more: (s?: number) => <I size={s} d="M5 12h.01M12 12h.01M19 12h.01" />,
  close: (s?: number) => <I size={s} d="M6 6l12 12M18 6L6 18" />,
  send: (s?: number) => <I size={s} d="M4 12l16-8-6 16-2.5-6.5z" />,
  cards: (s?: number) => <I size={s} d="M4 6h16M4 12h16M4 18h10" />,
  chat: (s?: number) => <I size={s} d="M4 5h16v11H9l-5 4z" />,
  pulse: (s?: number) => <I size={s} d="M3 12h4l3-7 4 14 3-7h4" />,
  flag: (s?: number) => <I size={s} d="M5 21V4h12l-2 4 2 4H5" />,
  edit: (s?: number) => <I size={s} d="M4 20h4l11-11-4-4L4 16zM13 7l4 4" />,
  tag: (s?: number) => <I size={s} d="M3 12l9 9 9-9-9-9H3zM8 8h.01" />,
  link: (s?: number) => <I size={s} d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  doc: (s?: number) => <I size={s} d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" />,
  external: (s?: number) => <I size={s} d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  person: (s?: number) => <I size={s} d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0" />,
  check: (s?: number) => <I size={s} d="M5 12l5 5 9-10" />,
  undo: (s?: number) => <I size={s} d="M9 14L4 9l5-5M4 9h9a7 7 0 0 1 0 14h-3" />,
  hand: (s?: number) => <I size={s} d="M7 11V6a1.5 1.5 0 0 1 3 0v5M10 10V4a1.5 1.5 0 0 1 3 0v6M13 10V5a1.5 1.5 0 0 1 3 0v8M16 11a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-14 0v-3a1.5 1.5 0 0 1 3 0" />,
  attach: (s?: number) => <I size={s} d="M8 12l6.5-6.5a3 3 0 0 1 4.24 4.24L9.5 19a5 5 0 0 1-7.07-7.07L13 1.5" />,
  /** Blocked, on a list row: a padlock, small enough to sit inside a line of text. */
  lock: (s?: number) => <I size={s} d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3" />,
  /** On hold, on a list row: a pause bar, sized to sit inside a line of text. */
  pause: (s?: number) => <I size={s} d="M9 6v12M15 6v12" />,
  trash: (s?: number) => <I size={s} d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  /** Straight down, for "jump to the bottom" affordances (the card page's latest-comments button). */
  arrowDown: (s?: number) => <I size={s} d="M12 4v15M5 12l7 7 7-7" />,
  /** Notifications: a bell with its clapper. Same stroke family as `lock` and `flag`. */
  bell: (s?: number) => <I size={s} d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3.4 1 4.9 1.7 5.8H4.8c.7-.9 1.7-2.4 1.7-5.8M9.9 18.6a2.3 2.3 0 0 0 4.2 0" />,
  /** Notifications that cannot ring: the same bell, struck through. */
  bellOff: (s?: number) => <I size={s} d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3.4 1 4.9 1.7 5.8H4.8c.7-.9 1.7-2.4 1.7-5.8M9.9 18.6a2.3 2.3 0 0 0 4.2 0M4 4l16 16" />,
  /** Reply, on the mobile reaction sheet's Reply row: a corner arrow turning back up and
   *  left, the same glyph family (stroke, no fill) as the rest of the set. */
  reply: (s?: number) => <I size={s} d="M9 8L3 13l6 5M3 13h11a6 6 0 0 1 6 6v1" />,
};
