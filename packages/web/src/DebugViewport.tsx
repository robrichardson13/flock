import { useEffect, useRef, useState } from "react";
import { LineComposer } from "./thread.tsx";

/**
 * Card #7: a temporary, throwaway diagnostic for the standalone-PWA composer/tab-bar overlap
 * bug (card #4). Two agents could not reproduce #4 in any headless engine, forced safe-area
 * insets and all — the one thing no emulator can fake is `display-mode: standalone` itself,
 * and the leading hypothesis is that `--below-shell` (a *live* `visualViewport.height` vs
 * `innerHeight` measurement, not a constant) is nonzero at rest on a real installed PWA, which
 * would make `--sab-in` under-reserve the real safe-area inset by exactly that amount.
 *
 * This screen exists to read that off a real device. It is reachable at `#/debug/viewport`,
 * a hash route inside the existing app, precisely so opening it from the home-screen icon
 * never leaves the installed PWA's scope and therefore never drops out of standalone
 * display-mode — the whole point of the card. It needs no devtools: every number here is
 * rendered as large, monospace, one-per-row text, meant to be screenshotted.
 *
 * It replicates the real `.screen` / `.tabbar` / `.pane` / `.pane-foot` markup (the same
 * classes Channel and its `LineComposer` use) with synthetic filler content, so the *real*
 * CSS reservation formulas (`--pillbar-space`, `--composer-space`, `--sab-in`) apply to real
 * elements rather than being described secondhand. Nothing here changes styles.css or the
 * composer-height machinery; it only stands existing production markup up on its own screen
 * to measure it.
 *
 * The installed PWA launches at its start URL and discards any route, and standalone has no
 * address bar to type one into — so the only way in is a tappable entry point rendered on the
 * boards homepage itself (App.tsx's `Home`, the `.debug-entry` link) and the only way back out
 * is the `.debug-back` link below, since standalone has no browser back button either. Both are
 * marked as the card #7 diagnostic and are meant to be deleted, along with this file, its
 * import/branch in App.tsx, and the `.debug-viewport*`/`.debug-entry`/`.debug-back` rules in
 * styles.css, once card #4 is resolved.
 *
 * Card #17 re-added this after a branch reset (see the board decisions) and extended it: every
 * custom property is resolved to a real pixel number via `resolvePx` rather than `parseFloat`
 * on its raw computed-value text, which for a `calc()`/`max()` property is unevaluated token
 * text and parses to `NaN` — a bug the card #7 readout itself shipped with, shown as a
 * confident, wrong `0` in four rows. Also added: `documentElement.clientHeight`, `.app`
 * height (read off an invisible probe wearing the real `.app`/`.app-mobile` classes),
 * `data-standalone`/`data-keyboard` presence on `<html>`, the scroller's `offsetTop`, full
 * bounding boxes for the composer and tab bar, and a "Copy as text" button so the human can
 * paste the whole readout into the board channel instead of retyping a screenshot.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * #13 (board decision on card #7): resolve a custom property to a *number*, not to the text
 * `getComputedStyle` hands back for one. A custom property's computed value is its token
 * stream with `var()`s substituted and nothing else evaluated, so `--sab-in`, `--below-shell`,
 * `--pillbar-space`, `--composer-space`, `--lvh` and `--vvh` all come back as literal
 * `max(...)`/`calc(...)` strings when they are built that way; `parseFloat` on those is `NaN`,
 * and an `|| 0` after it prints a confident, wrong `0`.
 *
 * Making the browser do the arithmetic is the only reliable way: put the expression on a real
 * property that computes to a length (`height` on an off-screen probe) and read that back. The
 * probe is a child of `el`, so a property scoped to a `.pane` resolves in the scope it is
 * actually used in rather than at the root, where it may not exist at all.
 */
function resolvePx(el: HTMLElement | null, name: string): number {
  if (!el) return NaN;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;padding:0;border:0";
  probe.style.height = `var(${name})`;
  el.appendChild(probe);
  const h = parseFloat(getComputedStyle(probe).height);
  probe.remove();
  return h;
}

const rectStr = (r: DOMRect) => `t${round1(r.top)} l${round1(r.left)} w${round1(r.width)} h${round1(r.height)}`;

function readLive(refs: {
  root: HTMLElement | null;
  scroller: HTMLElement | null;
  probeTop: HTMLElement | null;
  probeBottom: HTMLElement | null;
  appProbe: HTMLElement | null;
}) {
  const vv = window.visualViewport;
  const scrollerCs = refs.scroller ? getComputedStyle(refs.scroller) : null;
  const html = document.documentElement;
  // `LineComposer` does not forward a ref (it renders its own `<form className="pane-foot
  // …">`), and the tab bar here is a plain sibling node — both are found by class within this
  // screen's own root instead, the same way `VVReadout.tsx` finds `header.topbar`.
  const composer = refs.root?.querySelector<HTMLElement>(".pane-foot") ?? null;
  const tabbar = refs.root?.querySelector<HTMLElement>(".tabbar") ?? null;
  return {
    innerHeight: window.innerHeight,
    clientHeight: html.clientHeight,
    vvHeight: vv?.height ?? -1,
    vvOffsetTop: vv?.offsetTop ?? -1,
    screenHeight: window.screen?.height ?? -1,
    dpr: window.devicePixelRatio || 1,
    lvh: resolvePx(refs.root, "--lvh"),
    vvh: resolvePx(refs.root, "--vvh"),
    vvt: resolvePx(refs.root, "--vvt"),
    sabIn: resolvePx(refs.root, "--sab-in"),
    belowShell: resolvePx(refs.root, "--below-shell"),
    pillbarSpace: resolvePx(refs.root, "--pillbar-space"),
    // Scoped to the `.pane`, not the root, so it has to be resolved from inside one.
    composerSpace: resolvePx(refs.scroller, "--composer-space"),
    appHeight: refs.appProbe ? round1(refs.appProbe.getBoundingClientRect().height) : -1,
    envTop: refs.probeTop ? getComputedStyle(refs.probeTop).paddingTop : "-",
    envBottom: refs.probeBottom ? getComputedStyle(refs.probeBottom).paddingBottom : "-",
    standaloneMedia: window.matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    dataStandalone: html.hasAttribute("data-standalone"),
    dataKeyboard: html.hasAttribute("data-keyboard"),
    composerRect: composer ? rectStr(composer.getBoundingClientRect()) : "-",
    tabbarRect: tabbar ? rectStr(tabbar.getBoundingClientRect()) : "-",
    scrollClientH: refs.scroller?.clientHeight ?? -1,
    scrollHeight: refs.scroller?.scrollHeight ?? -1,
    scrollOffsetTop: refs.scroller?.offsetTop ?? -1,
    scrollPaddingBottom: scrollerCs?.paddingBottom ?? "-",
    // #18: the reservation is a `::after` spacer now, not trailing padding — iOS WebKit only
    // counts trailing padding once the content has already overflowed the padding box, so the
    // number that says whether the tail of the feed is reachable is where the last *box* ends
    // relative to the scroller's own scrollable height, not what the padding claims.
    scrollContentBottom: refs.scroller
      ? Math.round(
          (refs.scroller.lastElementChild?.getBoundingClientRect().bottom ?? 0) -
            refs.scroller.getBoundingClientRect().top +
            refs.scroller.scrollTop,
        )
      : -1,
    scrollReserve: resolvePx(refs.scroller, "--bottom-reserve"),
  };
}

type Live = ReturnType<typeof readLive>;

/** Whether the current hash asked for this screen. `#/debug/viewport`, with or without a
 *  trailing query/hash-fragment of its own. */
export function debugViewportRequested(hash: string): boolean {
  return hash === "#/debug/viewport" || hash.startsWith("#/debug/viewport?") || hash.startsWith("#/debug/viewport#");
}

const row = (label: string, value: string, warn?: boolean) => (
  <div className="dvp-row" key={label}>
    <span className="dvp-label">{label}</span>
    <b className={warn ? "dvp-warn" : ""}>{value}</b>
  </div>
);

const FILLER_TEXTS = [
  "Short line.",
  "A slightly longer message, still just one line on most phones.",
  "ok",
  "Another short one.",
  "Checking in — nothing new to report.",
  "Reviewed, looks good.",
  "One more line to pad things out.",
  "Last item in this batch.",
];

export function DebugViewport() {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const probeTopRef = useRef<HTMLDivElement>(null);
  const probeBottomRef = useRef<HTMLDivElement>(null);
  const appProbeRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const [fillerCount, setFillerCount] = useState(8);
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    const read = () =>
      setLive(
        readLive({
          root: rootRef.current,
          scroller: scrollerRef.current,
          probeTop: probeTopRef.current,
          probeBottom: probeBottomRef.current,
          appProbe: appProbeRef.current,
        }),
      );
    read();
    const id = setInterval(read, 150);
    const vv = window.visualViewport;
    window.addEventListener("resize", read);
    window.addEventListener("scroll", read, true);
    vv?.addEventListener("resize", read);
    vv?.addEventListener("scroll", read);
    scrollerRef.current?.addEventListener("scroll", read);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", read);
      window.removeEventListener("scroll", read, true);
      vv?.removeEventListener("resize", read);
      vv?.removeEventListener("scroll", read);
      scrollerRef.current?.removeEventListener("scroll", read);
    };
    // Re-runs when the filler count changes only so a resize from the new content is caught
    // right away rather than waiting for the next 150ms tick; the scroller node itself never
    // remounts.
  }, [fillerCount]);

  const l = live;
  const shortfall = l ? round1(l.vvHeight - (l.innerHeight - l.belowShell)) : 0;

  // Single source of truth for both the on-screen rows and the "copy as text" dump, so the
  // two can never drift apart.
  const rows: [string, string][] = l
    ? [
        ["innerHeight", `${l.innerHeight}`],
        ["documentElement.clientHeight", `${l.clientHeight}`],
        ["vv.height", `${round1(l.vvHeight)}`],
        ["vv.offsetTop", `${round1(l.vvOffsetTop)}`],
        ["screen.height", `${l.screenHeight}`],
        ["devicePixelRatio", `${l.dpr}`],
        ["--lvh", `${l.lvh}`],
        ["--vvh", `${l.vvh}`],
        ["--vvt", `${l.vvt}`],
        ["--sab-in", `${l.sabIn}`],
        ["--below-shell", `${l.belowShell}`],
        ["--pillbar-space", `${l.pillbarSpace}`],
        ["--composer-space", `${l.composerSpace}`],
        [".app height", `${l.appHeight}`],
        ["env(sab-top)", l.envTop],
        ["env(sab-bottom)", l.envBottom],
        ["standalone (media)", l.standaloneMedia ? "true" : "false"],
        ["navigator.standalone", l.navigatorStandalone ? "true" : "false"],
        ["html[data-standalone]", l.dataStandalone ? "true" : "false"],
        ["html[data-keyboard]", l.dataKeyboard ? "true" : "false"],
        ["composer rect", l.composerRect],
        ["tabbar rect", l.tabbarRect],
        ["scroll.clientHeight", `${l.scrollClientH}`],
        ["scroll.scrollHeight", `${l.scrollHeight}`],
        ["scroll.offsetTop", `${l.scrollOffsetTop}`],
        ["scroll pad-bottom", l.scrollPaddingBottom],
        ["scroll reserve", `${l.scrollReserve}`],
        ["scroll content-bottom", `${l.scrollContentBottom}`],
        ["vvH − (innerH − below)", `${shortfall}`],
      ]
    : [];

  const copyAsText = async () => {
    const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (or blocked) — fall back to a hidden, selected textarea and
      // the legacy copy command, which works in more restricted contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        setCopied(false);
      }
      ta.remove();
    }
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="screen debug-viewport-screen" ref={rootRef}>
      <div className="tab-pane">
        <div className="pane">
          <div className="pane-body">
            <div className="pane-scroll chan-scroll" ref={scrollerRef}>
              <div className="debug-viewport-note">
                Card #7 diagnostic — temporary, not part of the product. {fillerCount} filler
                rows below; use +/- to hunt the exact boundary where scrolling stops.
              </div>
              {Array.from({ length: fillerCount }, (_, i) => (
                <div className="debug-filler-row" key={i}>
                  {i + 1}. {FILLER_TEXTS[i % FILLER_TEXTS.length]}
                </div>
              ))}
            </div>
          </div>
          <LineComposer
            className="card-composer"
            placeholder="Debug composer — not sent anywhere"
            action="Send"
            address={{ board: "__debug_viewport__", pane: "channel" }}
            onSubmit={async () => {}}
          />
        </div>
      </div>
      <nav className="tabbar" aria-hidden>
        <span className="tabbar-item active" />
        <span className="tabbar-item" />
        <span className="tabbar-item" />
        <span className="tabbar-item" />
      </nav>

      {/* Off-screen probes: the only way to read the raw env() value is to let something
          consume it as a real padding and read that back via getComputedStyle. */}
      <div ref={probeTopRef} className="debug-env-probe" style={{ paddingTop: "env(safe-area-inset-top)" }} />
      <div ref={probeBottomRef} className="debug-env-probe" style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />

      {/* Off-screen probe wearing the real `.app`/`.app-mobile` classes, so `.app height`
          reflects the actual production CSS rule (`height: var(--vvh, 100dvh)`, floored per
          card #13) rather than a description of it. `visibility: hidden` and fixed
          positioning keep it out of this screen's own layout and off screen. */}
      <div ref={appProbeRef} className="app app-mobile debug-app-probe" aria-hidden />

      {/* Standalone has no browser back button, so this is the only way off the page —
          the boards homepage is what a bare hash (no `#/b/<slug>`) already resolves to
          (App.tsx's `parseRoute`). */}
      <a className="debug-back" href="#/">← Boards</a>

      <div className="debug-viewport" data-testid="debug-viewport">
        <div className="debug-viewport-head">
          #7 viewport diagnostic
          <span className="debug-viewport-controls">
            <button type="button" onClick={() => setFillerCount((n) => Math.max(0, n - 1))}>−</button>
            {fillerCount}
            <button type="button" onClick={() => setFillerCount((n) => n + 1)}>+</button>
            <button type="button" onClick={copyAsText} disabled={!l}>{copied ? "Copied" : "Copy as text"}</button>
          </span>
        </div>
        {l ? (
          <>
            {rows.map(([label, value]) =>
              row(
                label,
                value,
                (label === "--below-shell" && l.belowShell > 0) ||
                  (label === "vvH − (innerH − below)" && Math.abs(shortfall) > 0.5),
              ),
            )}
          </>
        ) : (
          <div className="dvp-row">reading…</div>
        )}
        <div className="debug-viewport-hint">
          Confirms the hypothesis: --below-shell reads above 0 at rest (no keyboard up), here
          and in the CSS row above, on a real installed home-screen app. Kills it: --below-shell
          reads 0 here too, same as every emulator.
        </div>
      </div>
    </div>
  );
}
