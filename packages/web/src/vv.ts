/**
 * #10: the on-device viewport readout.
 *
 * Cards #7 and #9 both fixed the keyboard glitch in a stubbed Chromium and both left the
 * phone unchanged, because a scripted `visualViewport` cannot reproduce what iOS does: it
 * fires an event per frame, so no gap ever opens between what the page has been told and
 * where the compositor has already moved the viewport. Rather than guess a third time,
 * this reads the numbers off the device.
 *
 * Everything here is pure so `bun test` can cover it; the overlay that renders it is
 * `VVReadout.tsx`.
 */

/** One sample, taken once per animation frame while a focus is being traced. */
export interface VVFrame {
  /** ms since the `focusin` that started the trace. */
  t: number;
  /** `header.topbar`'s `getBoundingClientRect().top`. Rects are in *layout* viewport
   *  coordinates, so this is where the bar sits in the document, not on the glass. */
  bar: number;
  /** Where the bar is on the glass: `bar - offsetTop`. This is the number the human sees,
   *  and the one that must not move. A bar that tracks a rising `offsetTop` exactly has a
   *  travelling `bar` and a still `screen`; a stale anchor moves `screen` and nothing else
   *  in the readout would show it. */
  screen: number;
  /** `visualViewport.offsetTop`: how far the visual viewport has slid down the layout one. */
  offsetTop: number;
  /** `visualViewport.height`. */
  height: number;
  /** `window.scrollY`: whether WebKit is scrolling the layout viewport under us. */
  scrollY: number;
  /** #13: the computed opacity of `.topbar-slot`. The bug #12 found was not the bar moving
   *  at all — it was the bar's whole contents fading in from 0 on every focus and every
   *  blur, which a position-only readout cannot see. Anything below 1 here means something
   *  is animating the bar again. */
  slotOpacity: number;
}

export interface TraceSummary {
  frames: number;
  barMin: number;
  barMax: number;
  barFinal: number;
  /** Frames where the bar's on-screen top differs from the previous frame's — the "slide". */
  barChanged: number;
  screenMin: number;
  screenMax: number;
  screenFinal: number;
  offsetMax: number;
  scrollMax: number;
  heightMin: number;
  heightMax: number;
  /** The lowest the bar's contents faded to. 1 is the only healthy value. */
  slotOpacityMin: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function summarizeTrace(frames: VVFrame[]): TraceSummary | null {
  if (!frames.length) return null;
  const bars = frames.map((f) => f.bar);
  const screens = frames.map((f) => f.screen);
  let changed = 0;
  for (let i = 1; i < frames.length; i++) if (Math.abs(screens[i] - screens[i - 1]) > 0.5) changed++;
  return {
    frames: frames.length,
    barMin: round(Math.min(...bars)),
    barMax: round(Math.max(...bars)),
    barFinal: round(bars[bars.length - 1]),
    barChanged: changed,
    screenMin: round(Math.min(...screens)),
    screenMax: round(Math.max(...screens)),
    screenFinal: round(screens[screens.length - 1]),
    offsetMax: round(Math.max(...frames.map((f) => f.offsetTop))),
    scrollMax: round(Math.max(...frames.map((f) => f.scrollY))),
    heightMin: round(Math.min(...frames.map((f) => f.height))),
    heightMax: round(Math.max(...frames.map((f) => f.height))),
    slotOpacityMin: Math.round(Math.min(...frames.map((f) => f.slotOpacity)) * 100) / 100,
  };
}

/** The compact head of a trace, for the one line that fits on the overlay. */
export function traceHead(frames: VVFrame[], n = 4): string {
  return frames
    .slice(0, n)
    .map((f) => `${Math.round(f.t)}:${round(f.screen)}/${round(f.offsetTop)}`)
    .join(" ");
}

/** The whole trace as text, for the clipboard. */
export function traceText(frames: VVFrame[], head: Record<string, unknown>): string {
  const s = summarizeTrace(frames);
  const meta = Object.entries(head).map(([k, v]) => `${k}=${v}`).join(" ");
  const rows = frames.map((f) => `${Math.round(f.t)}\t${round(f.screen)}\t${round(f.bar)}\t${round(f.offsetTop)}\t${round(f.height)}\t${round(f.scrollY)}\t${round(f.slotOpacity)}`);
  return [meta, `summary ${s ? JSON.stringify(s) : "none"}`, "t\tscreen\tbar\toffsetTop\tvvHeight\tscrollY\tslotOpacity", ...rows].join("\n");
}

/**
 * Whether this load asked for the readout. Read once at startup and never again, so the
 * overlay cannot appear or vanish mid-session and change what is being measured.
 * `?vv=1` on the URL (before the hash, which the app's own router owns) or a `vv` in the
 * hash's own query — `#/b/slug?vv=1` — both count, and so does the bare `#vv`.
 */
export function readoutRequested(href: string): boolean {
  const [beforeHash, ...rest] = href.split("#");
  const hash = rest.join("#");
  const search = beforeHash.includes("?") ? beforeHash.slice(beforeHash.indexOf("?") + 1) : "";
  const on = (q: string) => new URLSearchParams(q).get("vv") === "1";
  if (on(search)) return true;
  if (hash === "vv" || hash.startsWith("vv&")) return true;
  const hq = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return on(hq);
}

/**
 * #16: how tall the phone shell (`.app`, `height: var(--vvh)`) should be.
 *
 * Two facts about the iOS home-screen app, neither of which any emulator produces on its own:
 *
 * 1. With `viewport-fit=cover` the page is laid out over the whole display, but
 *    `window.innerHeight` comes back with the *top* safe-area inset already taken off.
 *    `document.documentElement.clientHeight` — and the containing block every
 *    `position: fixed` box is laid out against — stay the full display. On the human's
 *    device that is 793 against 852, so a shell sized from `innerHeight` ends 59pt above the
 *    bottom of the glass: a band of dark under the tab bar, every scroller 59pt short, and
 *    content sized to the real glass left a few tens of pixels under the composer with a
 *    rubber-band instead of a scroll. One geometry, all three symptoms.
 * 2. While a keyboard *is* up iOS reports the visual viewport as screen height minus
 *    keyboard, as if the page began at the top of the screen, and draws the keyboard's
 *    accessory pill inside it. That is what the status-bar/pill correction below is for.
 *
 * The correction must never be applied without a keyboard, and it cannot be allowed to infer
 * one from the very shortfall it is correcting: `visualViewport.height` 417 against
 * `innerHeight` 793 with nothing focused is the device's resting reading, and treating it as
 * a keyboard put the whole app in the top 40% of the glass. So `keyboard` here is evidence
 * from focus, supplied by the caller, and never derived from these numbers.
 *
 * Safari-in-a-tab and desktop are deliberately untouched: a short visual viewport there is
 * Safari's own toolbar, `--below-shell` already exists for it, and `innerHeight` there is
 * not under-reported.
 */
export interface ShellHeightInput {
  /** `visualViewport.height`, or `innerHeight` where there is no visual viewport. */
  raw: number;
  /** `window.innerHeight`. */
  innerHeight: number;
  /** `document.documentElement.clientHeight`: the layout viewport `position: fixed` uses. */
  clientHeight: number;
  /** The tallest `innerHeight` seen in this orientation. */
  rest: number;
  /** `window.screen.height`. */
  screenHeight: number;
  /** Home-screen app (`navigator.standalone`, or `display-mode: standalone`). */
  standalone: boolean;
  /** Whether a keyboard is plausibly up — a form field holds focus, or lost it moments ago.
   *  Evidence from focus, never from the viewport numbers this function is correcting. */
  keyboard: boolean;
}

/** The iOS keyboard's accessory pill, which the home-screen app reports as visible page. */
export const ACCESSORY_PILL = 37;

/** Whether the visual viewport is short *because of a keyboard*. */
export function keyboardShrunk(i: Pick<ShellHeightInput, "raw" | "rest" | "keyboard">): boolean {
  return i.keyboard && i.raw < i.rest - 1;
}

export function shellHeight(i: ShellHeightInput): number {
  const shrunk = keyboardShrunk(i);
  // Standalone with no keyboard: the shell fills the glass. `clientHeight` is the only one of
  // the three readings that is the layout viewport the fixed shell is actually placed in.
  if (i.standalone && !shrunk) return Math.max(i.raw, i.innerHeight, i.clientHeight);
  // Everything else is exactly what it was: the status-bar + accessory-pill correction under a
  // real keyboard in standalone, and the plain reading in a Safari tab or on desktop.
  const gap = i.standalone && shrunk ? Math.max(0, i.screenHeight - i.rest) : 0;
  return gap > 0 && gap < 100 ? i.raw - gap - ACCESSORY_PILL : i.raw;
}
