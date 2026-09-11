import { useEffect, useRef } from "react";
import { api } from "./api.ts";

/** Three heartbeats; matches `PRESENCE_TTL_MS` in `@flock/core`'s `Presence` (§3.4, D6). */
export const HEARTBEAT_MS = 15_000;
/** §3.3, D7: a focused, visible tab with no input in the last three minutes is not "looking". */
export const IDLE_MS = 180_000;

export interface LookingInputs {
  visible: boolean;
  focused: boolean;
  lastInputAt: number;
  now: number;
}

/** Pure. §3.3: `visibilityState === "visible" && document.hasFocus() && now - lastInputAt < IDLE_MS`. */
export function isLooking(inputs: LookingInputs): boolean {
  return inputs.visible && inputs.focused && inputs.now - inputs.lastInputAt < IDLE_MS;
}

export interface PresenceState {
  looking: boolean;
  /** The board slug, or null on Home. */
  board: string | null;
  lastSentAt: number;
}

export type PresenceAction = "send" | "beat" | "none";

/**
 * Pure. `prev` is the last state actually sent (or null before the first report); `next` is the
 * freshly computed `(looking, board)`. "send" fires immediately on any change of either; "beat"
 * fires while still looking once `HEARTBEAT_MS` has elapsed since the last send; otherwise "none".
 */
export function presenceStep(prev: PresenceState | null, next: { looking: boolean; board: string | null }, now: number): PresenceAction {
  if (!prev || prev.looking !== next.looking || prev.board !== next.board) return "send";
  if (next.looking && now - prev.lastSentAt >= HEARTBEAT_MS) return "beat";
  return "none";
}

/** `#/b/<slug>/...` -> the board slug; anything else (Home included) -> null. Mirrors the board
 * capture of `parseRoute` in App.tsx without importing it, so this module has no dependency on
 * the shell (which mounts `usePresence` itself). */
function boardFromHash(hash: string): string | null {
  const m = hash.match(/^#\/b\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * One heartbeat per page load, wired into `Shell` (always mounted). `client` lives in module
 * memory, not `sessionStorage` — Chrome copies `sessionStorage` into a duplicated tab, which
 * would merge two tabs' presence into one (§3.3).
 */
const CLIENT_ID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/**
 * Reports `{ looking, board }` to `POST /api/presence` per §3.3: immediately on any change, every
 * `HEARTBEAT_MS` while looking, and once more with `looking: false` (via `fetch(...,
 * { keepalive: true })`) the moment looking stops — including on `pagehide`. Sends nothing while
 * the actor name is empty (first load, before `/api/me` resolves).
 */
export function usePresence(actor: string, hash: string): void {
  const board = boardFromHash(hash);
  const lastInputAtRef = useRef<number>(Date.now());
  const prevRef = useRef<PresenceState | null>(null);

  useEffect(() => {
    let lastMoveAt = 0;

    const bumpInput = () => { lastInputAtRef.current = Date.now(); };
    const bumpMove = () => {
      const now = Date.now();
      if (now - lastMoveAt < 1000) return;
      lastMoveAt = now;
      bumpInput();
    };

    const evaluate = (leaving = false) => {
      if (!actor) return;
      const now = Date.now();
      const looking = !leaving && isLooking({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        lastInputAt: lastInputAtRef.current,
        now,
      });
      const next = { looking, board };
      const step = presenceStep(prevRef.current, next, now);
      if (step === "none") return;
      const keepalive = !looking;
      api.presence({ client: CLIENT_ID, board: next.board, looking: next.looking }, { keepalive }).catch(() => {});
      prevRef.current = { looking: next.looking, board: next.board, lastSentAt: now };
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") bumpInput();
      evaluate();
    };
    const onFocus = () => { bumpInput(); evaluate(); };
    const onBlur = () => evaluate();
    const onPageshow = () => { bumpInput(); evaluate(); };
    const onPagehide = () => evaluate(true);
    const onInput = () => { bumpInput(); evaluate(); };
    const onMove = () => { bumpMove(); evaluate(); };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pageshow", onPageshow);
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("pointerdown", onInput);
    window.addEventListener("keydown", onInput);
    window.addEventListener("wheel", onInput);
    window.addEventListener("touchstart", onInput);
    document.addEventListener("scroll", onInput, true);
    window.addEventListener("pointermove", onMove);

    // Re-evaluate periodically so the idle transition (no event of its own) and the heartbeat
    // are picked up even during a quiet stretch.
    const interval = window.setInterval(() => evaluate(), 5_000);

    evaluate();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pageshow", onPageshow);
      window.removeEventListener("pagehide", onPagehide);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("touchstart", onInput);
      document.removeEventListener("scroll", onInput, true);
      window.removeEventListener("pointermove", onMove);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, board]);
}
