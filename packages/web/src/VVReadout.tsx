import { useEffect, useRef, useState } from "react";
import { summarizeTrace, traceHead, traceText, type TraceSummary, type VVFrame } from "./vv.ts";

/**
 * #10: a live readout of the viewport, so the keyboard glitch can be measured on the phone
 * instead of theorised about in Chromium. Off unless the URL asked for it (`?vv=1`).
 *
 * It samples every frame — the whole point is to see the frames between the eight or so
 * events iOS sends across the keyboard's animation, which is exactly what an event-driven
 * readout would miss. On `focusin` it starts a 700ms per-frame trace of where the top bar
 * actually paints, and reports the excursion when it ends. `--vv-copy` puts the raw trace
 * on the clipboard for pasting back into the card.
 *
 * It sits top-right under the bar so the bar itself is still visible in a screenshot.
 *
 * #13: it also watches the bar for *animation*, not just position. #12's finding was that
 * the visible symptom was never the bar sliding — it was the bar's contents fading in from
 * opacity 0 twice per focus, which a readout of `bar.top` cannot see at all. `fades` counts
 * `animationstart` on the header since the last focus, and `slotOpacityMin` is the lowest
 * `.topbar-slot` reached during the trace. Both should read 0 and 1 forever.
 */

const TRACE_MS = 700;
const px = (n: number) => `${Math.round(n * 10) / 10}`;

interface Live {
  innerH: number;
  clientH: number;
  vvH: number;
  vvT: number;
  vvPage: number;
  vvScale: number;
  docTop: number;
  scrollY: number;
  vvh: number;
  vvt: number;
  lvh: number;
  below: number;
  barH: string;
  kb: boolean;
  moving: boolean;
  standalone: boolean;
  barTop: number;
  slotOpacity: number;
}

/* #13: what the bar's contents are actually painting at. A restarted `fade-in` shows up
   here and nowhere else in this readout. */
const slotOpacity = (): number => {
  const slot = document.querySelector(".topbar-slot");
  return slot ? parseFloat(getComputedStyle(slot).opacity) || 0 : 1;
};

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "-";
/* A custom property comes back as written, so `--below-shell` reads as its own `max()`
   expression rather than a number. The three it is made of are plain pixel values, so the
   arithmetic is done here instead. */
const cssPx = (name: string) => parseFloat(cssVar(name)) || 0;

function read(): Live {
  const vv = window.visualViewport;
  const bar = document.querySelector("header.topbar");
  const root = document.documentElement;
  return {
    innerH: window.innerHeight,
    clientH: root.clientHeight,
    vvH: vv?.height ?? -1,
    vvT: vv?.offsetTop ?? -1,
    vvPage: vv?.pageTop ?? -1,
    vvScale: vv?.scale ?? -1,
    docTop: document.scrollingElement?.scrollTop ?? -1,
    scrollY: window.scrollY,
    vvh: cssPx("--vvh"),
    vvt: cssPx("--vvt"),
    lvh: cssPx("--lvh"),
    below: Math.max(0, cssPx("--lvh") - cssPx("--vvh") - cssPx("--vvt")),
    barH: cssVar("--bar-h"),
    kb: root.hasAttribute("data-keyboard"),
    moving: root.hasAttribute("data-vv-moving"),
    standalone: window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    barTop: bar ? bar.getBoundingClientRect().top : NaN,
    slotOpacity: slotOpacity(),
  };
}

export function VVReadout() {
  const [live, setLive] = useState<Live>(() => read());
  const [counts, setCounts] = useState({ resize: 0, vvScroll: 0, winScroll: 0, fades: 0 });
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [head, setHead] = useState("");
  const [tracing, setTracing] = useState(false);
  const [copied, setCopied] = useState("");
  const frames = useRef<VVFrame[]>([]);
  const traceStart = useRef(0);
  const c = useRef({ resize: 0, vvScroll: 0, winScroll: 0, fades: 0 });

  useEffect(() => {
    const vv = window.visualViewport;
    let raf = 0;
    /* The trace samples every frame, but it only reads a rect and two numbers off the
       visual viewport — no `getComputedStyle`, no React. Rendering sixty times a second
       while the shell is resizing would make the overlay part of what it is measuring; the
       readable fields update on a timer instead, which is fast enough for an eye. #13 adds
       one `getComputedStyle` per frame for the slot's opacity — the only way to see a fade,
       and cheap enough next to the rect read that was already here. */
    const tick = () => {
      if (traceStart.current) {
        const t = performance.now() - traceStart.current;
        const el = document.querySelector("header.topbar");
        const bar = el ? el.getBoundingClientRect().top : NaN;
        const offsetTop = vv?.offsetTop ?? 0;
        frames.current.push({ t, bar, screen: bar - offsetTop, offsetTop, height: vv?.height ?? -1, scrollY: window.scrollY, slotOpacity: slotOpacity() });
        if (t >= TRACE_MS) {
          traceStart.current = 0;
          setTracing(false);
          setSummary(summarizeTrace(frames.current));
          setHead(traceHead(frames.current));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ui = setInterval(() => setLive(read()), 150);

    const bump = (k: keyof typeof c.current) => () => { c.current[k]++; setCounts({ ...c.current }); };
    const onResize = bump("resize");
    const onVVScroll = bump("vvScroll");
    const onWinScroll = bump("winScroll");
    const onFocus = () => {
      c.current = { resize: 0, vvScroll: 0, winScroll: 0, fades: 0 };
      setCounts({ ...c.current });
      frames.current = [];
      traceStart.current = performance.now();
      setSummary(null);
      setHead("");
      setTracing(true);
    };
    /* #13: any animation starting anywhere in the bar, captured so a slot that is replaced
       mid-trace is still counted. */
    const onAnim = bump("fades");
    document.querySelector("header.topbar")?.addEventListener("animationstart", onAnim, true);
    vv?.addEventListener("resize", onResize);
    vv?.addEventListener("scroll", onVVScroll);
    window.addEventListener("scroll", onWinScroll);
    document.addEventListener("focusin", onFocus);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(ui);
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", onVVScroll);
      window.removeEventListener("scroll", onWinScroll);
      document.querySelector("header.topbar")?.removeEventListener("animationstart", onAnim, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);

  const copy = async () => {
    const text = traceText(frames.current, {
      ua: navigator.userAgent,
      standalone: live.standalone,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      innerH: live.innerH,
      clientH: live.clientH,
      counts: `r${counts.resize}/vs${counts.vvScroll}/ws${counts.winScroll}/fade${counts.fades}`,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      // Clipboard is gated in some standalone contexts; a selectable box is the fallback.
      setCopied(text);
    }
    setTimeout(() => setCopied(""), 4000);
  };

  const row = (k: string, v: string) => (
    <div className="vv-row" key={k}><span>{k}</span><b>{v}</b></div>
  );

  return (
    <div className="vv-readout" data-testid="vv-readout">
      {row("innerH", px(live.innerH))}
      {row("clientH", px(live.clientH))}
      {row("vv.h", px(live.vvH))}
      {row("vv.top", px(live.vvT))}
      {row("vv.page", px(live.vvPage))}
      {row("vv.scale", `${Math.round(live.vvScale * 100) / 100}`)}
      {row("doc.top", px(live.docTop))}
      {row("scrollY", px(live.scrollY))}
      {row("--vvh", px(live.vvh))}
      {row("--vvt", px(live.vvt))}
      {row("--lvh", px(live.lvh))}
      {row("--below", px(live.below))}
      {row("--bar-h", live.barH)}
      {row("bar.top", px(live.barTop))}
      {row("bar.screen", px(live.barTop - live.vvT))}
      {row("kb/mov/sa", `${live.kb ? 1 : 0}/${live.moving ? 1 : 0}/${live.standalone ? 1 : 0}`)}
      {row("ev r/vs/ws", `${counts.resize}/${counts.vvScroll}/${counts.winScroll}`)}
      {/* #13: the two numbers that would have caught the real bug on the first try. */}
      {row("fades", `${counts.fades}`)}
      {row("slot op", `${Math.round(live.slotOpacity * 100) / 100}`)}
      <div className="vv-trace">
        {tracing ? "tracing…" : summary
          ? `screen ${summary.screenMin}..${summary.screenMax} end ${summary.screenFinal} moved ${summary.barChanged}/${summary.frames} · bar ${summary.barMin}..${summary.barMax} · slot min ${summary.slotOpacityMin} · fades ${counts.fades}`
          : "focus a field"}
      </div>
      {head ? <div className="vv-trace vv-head">{head}</div> : null}
      <button className="vv-copy" onClick={copy} type="button">{copied === "copied" ? "copied" : "copy"}</button>
      {copied && copied !== "copied" ? <textarea className="vv-fallback" readOnly value={copied} /> : null}
    </div>
  );
}
