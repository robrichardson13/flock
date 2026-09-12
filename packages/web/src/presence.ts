import { useEffect, useRef } from "react";
import { clientIsLooking, IDLE_MS, type LookingInputs } from "@flock/core/presence";
import { api, type PresenceReportInfo } from "./api.ts";
import { dismissBeatFields, dismissRecorder } from "./dismissLog.ts";
import { createBeatScheduler, type BeatContext } from "./beat.ts";
import { LIVE_UP_EVENT } from "./live.ts";

/** Three heartbeats; matches `PRESENCE_TTL_MS` in `@flock/core`'s `Presence` (§3.4, D6). */
export const HEARTBEAT_MS = 15_000;

/** The rule itself lives in core (§3.3, D7, ADR 0021 amendment); re-exported for the web's tests. */
export { clientIsLooking, IDLE_MS, type LookingInputs };

/**
 * True on a device that shows one app at a time and has no per-window focus — a phone or tablet.
 * `(hover: none) and (pointer: coarse)` is the touch-primary query; a desktop browser, including
 * one with a touchscreen attached, still reports a fine pointer and hover. Feeds
 * `clientIsLooking`, which drops the focus and idle requirements when it is true.
 */
export function foregroundOnlyDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/** Vite's `define` (see `vite.config.ts`); absent under the test runner and in any bundle built
 *  before card 54, which is itself the signal that matters. */
declare const __FLOCK_BUILD_ID__: string | undefined;

/**
 * Which bundle this page is running, reported on every presence beat. `unknown` when the define
 * is missing — a page served from a bundle that predates this field, which on a phone means the
 * home-screen app is running stale JS.
 */
export function buildId(): string {
  return typeof __FLOCK_BUILD_ID__ === "string" && __FLOCK_BUILD_ID__.length > 0 ? __FLOCK_BUILD_ID__ : "unknown";
}

/** An installed home-screen app, or a browser tab. Diagnostic only — `foregroundOnlyDevice`, not
 *  this, is what decides the looking rule (a desktop PWA is standalone but has real focus). */
export function displayMode(): "standalone" | "browser" {
  if (typeof window === "undefined") return "browser";
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { standalone?: boolean });
  if (nav?.standalone === true) return "standalone";
  if (typeof window.matchMedia !== "function") return "browser";
  return window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser";
}

export interface PresenceState {
  looking: boolean;
  /** The board slug, or null on Home. */
  board: string | null;
  lastSentAt: number;
  /** The last POST failed; the next beat retries instead of waiting for a state change. */
  failed: boolean;
}

export type PresenceAction = "send" | "beat" | "none";

/**
 * Pure. `prev` is the last state we tried to send (or null before the first report); `next` is the
 * freshly computed `(looking, board)`. "send" fires immediately on any change of either; "beat"
 * fires once `HEARTBEAT_MS` has elapsed since the last attempt, while still looking **or** while
 * that attempt failed — a dropped `looking: false` leave beat would otherwise never be retried and
 * the server would hold a stale "looking" for the whole TTL. Otherwise "none".
 *
 * `forced` is the card 91 escape hatch: a resume signal, a detected timer gap or a retry beats
 * even when nothing changed and the cadence has not elapsed. Without it, a client that reported
 * `looking: false` once fell permanently silent — correct on the server's own terms, and the
 * reason a foregrounded phone read as absent for 80s. The scheduler dedupes resume storms before
 * this is ever reached, so "forced" cannot become a tight loop.
 */
export function presenceStep(
  prev: PresenceState | null,
  next: { looking: boolean; board: string | null },
  now: number,
  forced = false,
): PresenceAction {
  if (!prev || prev.looking !== next.looking || prev.board !== next.board) return "send";
  if (forced) return "beat";
  if (now - prev.lastSentAt < HEARTBEAT_MS) return "none";
  return next.looking || prev.failed ? "beat" : "none";
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
 *
 * **Card 91.** The cadence is a `setTimeout` chain in `beat.ts`, not a `setInterval`, and it is
 * not the only thing that can fire a beat. The log that produced this rewrite showed a phone on
 * `mode=standalone` beating every 15.0s while visible, reporting `looking=false` the instant iOS
 * fired `visibilitychange` -> hidden (a notification banner, Control Centre, an app-switcher
 * peek — none of which the person experiences as leaving the app), and then going **completely
 * silent for 80s**: the old code sent nothing more while not looking, and the `setInterval` that
 * would have re-read `document.visibilityState` was frozen with the page. The server's 45s TTL
 * expired, `clients=0`, and the next chatter message buzzed a phone that was being stared at.
 * The banner then fired hidden again, so a buzz begat the state that permitted the next buzz.
 *
 * So every signal that could mean "the app is in front of someone again" — `visibilitychange` to
 * visible, `pageshow`, `focus`, `online`, a reconnected event stream (`LIVE_UP_EVENT`), and any
 * touch, key, scroll or pointer — fires a beat immediately and re-arms the chain, deduped by the
 * scheduler. A late tick is reported with `gapReason`/`gapMs` so the server line carries `gap=`
 * and the next silent stretch is visible rather than inferred.
 *
 * Presence deliberately does *not* drive notification dismissal (it did between PR 48 and card
 * 53). The transition into looking is only as trustworthy as the leave evaluate that preceded
 * it, and an iOS home-screen app can be suspended without one ever running. Presence itself
 * tolerates that — the server's TTL expires the stale "looking" on its own — but an edge-
 * triggered dismissal does not. See `dismiss.ts` for the level-triggered replacement.
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

    /** Resolves when the POST settles, rejects when it fails, so the scheduler can back off. */
    const report = (next: { looking: boolean; board: string | null }, now: number, info: PresenceReportInfo): Promise<void> => {
      const state: PresenceState = { looking: next.looking, board: next.board, lastSentAt: now, failed: false };
      prevRef.current = state;
      return api.presence({ client: CLIENT_ID, board: next.board, looking: next.looking, info }, { keepalive: !next.looking }).catch((err: unknown) => {
        // Never swallowed and never absorbed: the mark keeps `presenceStep` retrying on cadence,
        // and the re-throw is what puts the scheduler on its bounded backoff. Neither can end the
        // loop — a dropped beat is one of the ways a foregrounded phone looks absent.
        state.failed = true;
        throw err;
      });
    };

    const evaluate = (opts: { leaving?: boolean; forced?: boolean; gap?: { reason: string; ms: number } } = {}): Promise<void> | void => {
      if (!actor) return;
      const now = Date.now();
      const inputs = {
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        lastInputAt: lastInputAtRef.current,
        now,
        foregroundOnly: foregroundOnlyDevice(),
      };
      const looking = !opts.leaving && clientIsLooking(inputs);
      const next = { looking, board };
      if (presenceStep(prevRef.current, next, now, opts.forced ?? false) === "none") return;
      return report(next, now, {
        build: buildId(),
        mode: displayMode(),
        visible: inputs.visible,
        focused: inputs.focused,
        lastInputAgeMs: Math.max(0, now - inputs.lastInputAt),
        foregroundOnly: inputs.foregroundOnly,
        // The dismissal read-out rides along (card 70). Presence never reads it; it is here
        // because a beat is the only channel out of a home-screen app that reaches a terminal.
        ...dismissBeatFields(dismissRecorder.read()),
        ...(opts.gap ? { gapReason: opts.gap.reason, gapMs: opts.gap.ms } : {}),
      });
    };

    const scheduler = createBeatScheduler({
      cadenceMs: HEARTBEAT_MS,
      beat: (ctx: BeatContext) =>
        evaluate({
          forced: ctx.forced,
          gap: ctx.gapMs === null ? undefined : { reason: ctx.reason, ms: ctx.gapMs },
        }),
    });

    /** A resume signal: beat now (the scheduler dedupes) and re-arm the chain from here. */
    const resume = (reason: string, bump = true) => {
      if (bump) bumpInput();
      scheduler.resume(reason);
    };

    const onVisibility = () => {
      // The hidden direction must not wait for the dedupe window: a locked phone has to stop
      // being "looking" on this very event, or it stays looking for the whole server TTL.
      if (document.visibilityState !== "visible") {
        void evaluate();
        return;
      }
      resume("visible");
    };
    const onFocus = () => resume("focus");
    const onBlur = () => { void evaluate(); };
    const onPageshow = () => resume("pageshow");
    const onPagehide = () => { void evaluate({ leaving: true }); };
    const onOnline = () => resume("online", false);
    const onLiveUp = () => resume("live-up", false);
    const onInput = () => resume("input");
    const onMove = () => { bumpMove(); scheduler.resume("move"); };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pageshow", onPageshow);
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("online", onOnline);
    window.addEventListener(LIVE_UP_EVENT, onLiveUp);
    window.addEventListener("pointerdown", onInput);
    window.addEventListener("keydown", onInput);
    window.addEventListener("wheel", onInput);
    window.addEventListener("touchstart", onInput);
    document.addEventListener("scroll", onInput, true);
    window.addEventListener("pointermove", onMove);

    scheduler.start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pageshow", onPageshow);
      window.removeEventListener("pagehide", onPagehide);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(LIVE_UP_EVENT, onLiveUp);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("touchstart", onInput);
      document.removeEventListener("scroll", onInput, true);
      window.removeEventListener("pointermove", onMove);
      scheduler.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, board]);
}
