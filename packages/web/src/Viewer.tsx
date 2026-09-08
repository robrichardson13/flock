/**
 * Full-screen image viewer, in the shape iOS Photos and Messages set: the image grows
 * out of the bubble it was tapped in onto a black scrim, chrome fades away on a tap, and
 * it is dismissed by the close button, the scrim, a swipe down, Escape, or Back.
 *
 * History is the part worth reading twice. Opening pushes exactly one entry (a state
 * marker; the hash is untouched, so routing never sees it) and every in-app dismissal
 * pops it with `history.back()`. So Back closes the viewer, and Back *after* a close
 * goes to the previous screen instead of reopening the image or skipping a level.
 *
 * The gesture thresholds and every transform live in `viewer.ts`, which is pure and
 * tested; this file owns the pointer bookkeeping and writes results straight to element
 * styles, so a drag never goes through React state.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { agoText } from "./App.tsx";
import { D_BASE, D_FAST, D_SLOW, Icons, prefersReducedMotion } from "./ui.tsx";
import {
  clampPan,
  distance,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SCALE,
  DOUBLE_TAP_SLOP_PX,
  dismissScale,
  flipCss,
  flipFrom,
  midpoint,
  MIN_SCALE,
  pageOffset,
  pageTarget,
  pinchScale,
  scrimAlpha,
  shouldDismiss,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  velocityOf,
  zoomAbout,
  type Point,
} from "./viewer.ts";

export interface ViewerImage {
  url: string;
  name: string | null;
  width: number | null;
  height: number | null;
}

/** The one history entry the viewer owns, marked on the pushed state. */
const HISTORY_MARK = "flockImageViewer";

/**
 * Wires a set of images to the viewer. The caller renders `node` (a portal, or null when
 * nothing is open) and calls `open(i)` from the thumbnail's click handler; `thumbAt` hands
 * back the element to grow out of and shrink back into.
 */
export function useImageViewer(opts: {
  images: ViewerImage[];
  author: string;
  createdAt: string;
  thumbAt: (index: number) => HTMLElement | null;
}): { open: (index: number) => void; node: ReactNode } {
  const { images, author, createdAt, thumbAt } = opts;
  const [start, setStart] = useState<number | null>(null);
  // True while our own entry is still on the history stack, i.e. a close still owes a
  // `history.back()`. Cleared by whichever of the two paths gets there first.
  const pushed = useRef(false);

  const open = useCallback((index: number) => {
    try {
      window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_MARK]: true }, "");
      pushed.current = true;
    } catch {
      // A browser that refuses the push still gets a working viewer; only Back differs.
      pushed.current = false;
    }
    setStart(index);
  }, []);

  const node =
    start === null ? null : (
      <ImageViewer
        images={images}
        start={start}
        author={author}
        createdAt={createdAt}
        thumbAt={thumbAt}
        pushed={pushed}
        onFinished={() => setStart(null)}
      />
    );

  return { open, node };
}

type Exit = "flip" | "fall" | "fade";

function ImageViewer({ images, start, author, createdAt, thumbAt, pushed, onFinished }: {
  images: ViewerImage[];
  start: number;
  author: string;
  createdAt: string;
  thumbAt: (index: number) => HTMLElement | null;
  pushed: { current: boolean };
  onFinished: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const imgRefs = useRef<(HTMLImageElement | null)[]>([]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const closing = useRef(false);
  const reduced = prefersReducedMotion();

  /* ---------- closing ---------- */

  const finishRef = useRef(onFinished);
  finishRef.current = onFinished;

  /**
   * `pop` is false only when the browser already popped for us (a real Back press).
   * Everything else — the X, the scrim, a swipe, Escape — closes *and* pops, so the
   * entry we pushed never outlives the viewer.
   */
  const close = useCallback((exit: Exit, pop: boolean, fallenTo = 0) => {
    if (closing.current) return;
    closing.current = true;
    if (pop && pushed.current) {
      pushed.current = false;
      try {
        window.history.back();
      } catch {
        // Nothing to pop: the entry was never pushed.
      }
    }
    const root = rootRef.current;
    const stage = stageRef.current;
    const scrim = scrimRef.current;
    const done = (after: number) => window.setTimeout(() => finishRef.current(), after);
    if (!root || !stage || !scrim || prefersReducedMotion()) {
      if (root) {
        root.style.transition = `opacity ${D_FAST}ms linear`;
        root.style.opacity = "0";
      }
      done(prefersReducedMotion() ? D_FAST : 0);
      return;
    }
    root.classList.add("iv-closing");
    scrim.style.transition = `opacity ${D_BASE}ms var(--ease-out)`;
    scrim.style.opacity = "0";
    if (exit === "fall") {
      const h = window.innerHeight || 1;
      stage.style.transition = `transform ${D_BASE}ms var(--ease-out), opacity ${D_BASE}ms linear`;
      stage.style.transform = `translate3d(0, ${h}px, 0) scale(${dismissScale(fallenTo + h * 0.2, h)})`;
      stage.style.opacity = "0";
      done(D_BASE);
      return;
    }
    const img = imgRefs.current[indexRef.current];
    const thumb = thumbAt(indexRef.current);
    const to = img?.getBoundingClientRect();
    const from = thumb?.getBoundingClientRect();
    if (exit === "flip" && img && to && from && to.width > 0 && from.width > 0) {
      stage.style.transformOrigin = "0 0";
      stage.style.transition = `transform ${D_SLOW}ms var(--ease-out), opacity ${D_SLOW}ms var(--ease-out)`;
      stage.style.transform = flipCss(flipFrom(from, to));
      stage.style.opacity = "0";
      done(D_SLOW);
      return;
    }
    stage.style.transition = `transform ${D_BASE}ms var(--ease-out), opacity ${D_BASE}ms linear`;
    stage.style.transform = "scale(0.92)";
    stage.style.opacity = "0";
    done(D_BASE);
  }, [thumbAt, pushed]);

  /* ---------- history ---------- */

  useEffect(() => {
    const onPop = () => {
      if (!pushed.current) return;
      pushed.current = false;
      close("fade", false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [close, pushed]);

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close("flip", true);
      } else if (e.key === "ArrowRight" && index < images.length - 1) {
        setIndex(index + 1);
      } else if (e.key === "ArrowLeft" && index > 0) {
        setIndex(index - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, index, images.length]);

  /* ---------- body scroll lock ---------- */

  useEffect(() => {
    const html = document.documentElement;
    const prev = document.body.style.overflow;
    html.setAttribute("data-viewing", "");
    document.body.style.overflow = "hidden";
    return () => {
      html.removeAttribute("data-viewing");
      document.body.style.overflow = prev;
    };
  }, []);

  /* ---------- the strip's resting position ---------- */

  const settleStrip = useCallback((animate: boolean) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.style.transition = animate && !prefersReducedMotion() ? `transform ${D_BASE}ms var(--ease-out)` : "none";
    strip.style.transform = `translate3d(${-indexRef.current * (window.innerWidth || 0)}px, 0, 0)`;
  }, []);

  useLayoutEffect(() => {
    settleStrip(false);
  }, [settleStrip]);

  useEffect(() => {
    const on = () => settleStrip(false);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [settleStrip]);

  /* ---------- open animation ---------- */

  useLayoutEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const scrim = scrimRef.current;
    if (!root || !stage || !scrim) return;
    const thumb = thumbAt(start);
    const img = imgRefs.current[start];
    const to = img?.getBoundingClientRect();
    const from = thumb?.getBoundingClientRect();
    if (reduced || !to || !from || to.width < 1 || from.width < 1) {
      root.style.opacity = "0";
      requestAnimationFrame(() => {
        root.style.transition = `opacity ${reduced ? D_FAST : D_BASE}ms var(--ease-out)`;
        root.style.opacity = "1";
      });
      return;
    }
    stage.style.transformOrigin = "0 0";
    stage.style.transition = "none";
    stage.style.transform = flipCss(flipFrom(from, to));
    scrim.style.transition = "none";
    scrim.style.opacity = "0";
    root.classList.add("iv-opening");
    requestAnimationFrame(() => {
      stage.style.transition = `transform ${D_SLOW}ms var(--ease-out)`;
      stage.style.transform = "translate3d(0, 0, 0) scale(1)";
      scrim.style.transition = `opacity ${D_SLOW}ms var(--ease-out)`;
      scrim.style.opacity = "1";
      window.setTimeout(() => {
        root.classList.remove("iv-opening");
        stage.style.transition = "";
        stage.style.transform = "";
      }, D_SLOW);
    });
    // Only ever the first paint: the deps are the ones captured at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- gestures ---------- */

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const strip = stripRef.current;
    const scrim = scrimRef.current;
    if (!root || !stage || !strip || !scrim) return;

    const zoom = { scale: 1, t: { x: 0, y: 0 } as Point };
    const pointers = new Map<number, Point>();
    let mode: "idle" | "undecided" | "dragY" | "dragX" | "pan" | "pinch" = "idle";
    let startPt: Point = { x: 0, y: 0 };
    let startAt = 0;
    let panFrom: Point = { x: 0, y: 0 };
    let samplesY: { t: number; v: number }[] = [];
    let samplesX: { t: number; v: number }[] = [];
    let dx = 0;
    let dy = 0;
    let lastDist = 0;
    let lastMid: Point = { x: 0, y: 0 };
    let lastTap = { t: 0, x: 0, y: 0 };
    let tapTimer: number | null = null;

    const activeImg = () => imgRefs.current[indexRef.current] ?? null;

    const applyZoom = (animate = false) => {
      const img = activeImg();
      if (!img) return;
      img.style.transition = animate && !prefersReducedMotion() ? `transform ${D_BASE}ms var(--ease-out)` : "none";
      img.style.transform = `translate3d(${zoom.t.x}px, ${zoom.t.y}px, 0) scale(${zoom.scale})`;
    };

    const applyDrag = () => {
      const h = window.innerHeight || 1;
      stage.style.transition = "none";
      stage.style.transform = `translate3d(0, ${dy}px, 0) scale(${dismissScale(dy, h)})`;
      scrim.style.transition = "none";
      scrim.style.opacity = `${scrimAlpha(dy, h)}`;
    };

    const springBack = () => {
      dy = 0;
      root.classList.remove("iv-dragging");
      stage.style.transition = prefersReducedMotion() ? "none" : `transform ${D_BASE}ms var(--ease-spring)`;
      stage.style.transform = "translate3d(0, 0, 0) scale(1)";
      scrim.style.transition = `opacity ${D_BASE}ms var(--ease-out)`;
      scrim.style.opacity = "1";
    };

    const setZoom = (scale: number, t: Point, animate = false) => {
      const img = activeImg();
      const box = img?.getBoundingClientRect();
      const w = box ? box.width / zoom.scale : window.innerWidth;
      const h = box ? box.height / zoom.scale : window.innerHeight;
      zoom.scale = scale;
      zoom.t = scale <= MIN_SCALE + 0.001 ? { x: 0, y: 0 } : clampPan(t, scale, w, h);
      applyZoom(animate);
      setZoomed(zoom.scale > MIN_SCALE + 0.001);
    };

    const resetZoom = () => {
      const img = activeImg();
      if (img) {
        img.style.transition = "none";
        img.style.transform = "";
      }
      zoom.scale = 1;
      zoom.t = { x: 0, y: 0 };
      setZoomed(false);
    };

    const onTap = (p: Point) => {
      const img = activeImg();
      const box = img?.getBoundingClientRect();
      const onImage = !!box && p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
      if (!onImage) {
        close("flip", true);
        return;
      }
      const now = performance.now();
      const isDouble = now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_SLOP_PX;
      lastTap = { t: now, x: p.x, y: p.y };
      if (isDouble) {
        if (tapTimer !== null) window.clearTimeout(tapTimer);
        tapTimer = null;
        if (zoom.scale > MIN_SCALE + 0.001) {
          setZoom(MIN_SCALE, { x: 0, y: 0 }, true);
        } else if (box) {
          const anchor = { x: p.x - (box.left + box.width / 2), y: p.y - (box.top + box.height / 2) };
          setZoom(DOUBLE_TAP_SCALE, zoomAbout(anchor, zoom.t, zoom.scale, DOUBLE_TAP_SCALE), true);
        }
        return;
      }
      // A single tap toggles the chrome, but only once it is clear no second tap is coming.
      if (tapTimer !== null) window.clearTimeout(tapTimer);
      tapTimer = window.setTimeout(() => {
        tapTimer = null;
        setChrome((c) => !c);
      }, DOUBLE_TAP_MS);
    };

    const onDown = (e: PointerEvent) => {
      if (closing.current) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        mode = "undecided";
        startPt = { x: e.clientX, y: e.clientY };
        startAt = e.timeStamp;
        panFrom = { ...zoom.t };
        samplesY = [{ t: e.timeStamp, v: e.clientY }];
        samplesX = [{ t: e.timeStamp, v: e.clientX }];
        dx = 0;
        dy = 0;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        mode = "pinch";
        lastDist = distance(a, b);
        lastMid = midpoint(a, b);
        // Whatever the single finger had started (a page or a dismiss) is abandoned.
        if (dy !== 0) springBack();
        if (dx !== 0) {
          dx = 0;
          settleStrip(true);
        }
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = distance(a, b);
        const mid = midpoint(a, b);
        const img = activeImg();
        const box = img?.getBoundingClientRect();
        const next = pinchScale(zoom.scale, lastDist, dist);
        if (box) {
          const anchor = { x: mid.x - (box.left + box.width / 2), y: mid.y - (box.top + box.height / 2) };
          let t = zoomAbout(anchor, zoom.t, zoom.scale, next);
          t = { x: t.x + (mid.x - lastMid.x), y: t.y + (mid.y - lastMid.y) };
          const w = box.width / zoom.scale;
          const h = box.height / zoom.scale;
          zoom.scale = next;
          zoom.t = clampPan(t, next, w, h);
        } else {
          zoom.scale = next;
        }
        lastDist = dist;
        lastMid = mid;
        applyZoom();
        return;
      }
      if (pointers.size !== 1) return;
      const mx = e.clientX - startPt.x;
      const my = e.clientY - startPt.y;
      samplesY.push({ t: e.timeStamp, v: e.clientY });
      samplesX.push({ t: e.timeStamp, v: e.clientX });
      if (mode === "undecided") {
        if (Math.hypot(mx, my) < TAP_SLOP_PX) return;
        if (zoom.scale > MIN_SCALE + 0.001) mode = "pan";
        else if (Math.abs(mx) > Math.abs(my) && images.length > 1) mode = "dragX";
        else if (Math.abs(my) > Math.abs(mx)) mode = "dragY";
        else return;
      }
      if (mode === "pan") {
        const img = activeImg();
        const box = img?.getBoundingClientRect();
        const w = box ? box.width / zoom.scale : window.innerWidth;
        const h = box ? box.height / zoom.scale : window.innerHeight;
        zoom.t = clampPan({ x: panFrom.x + mx, y: panFrom.y + my }, zoom.scale, w, h);
        applyZoom();
      } else if (mode === "dragY") {
        // Upward drags resist: there is nothing above the image to go to.
        dy = my < 0 ? my * 0.3 : my;
        root.classList.add("iv-dragging");
        applyDrag();
      } else if (mode === "dragX") {
        dx = pageOffset(indexRef.current, images.length, mx);
        strip.style.transition = "none";
        strip.style.transform = `translate3d(${-indexRef.current * (window.innerWidth || 0) + dx}px, 0, 0)`;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (mode === "pinch") {
        if (pointers.size === 1) {
          // One finger left after a pinch: carry on as a pan from where we are.
          const [p] = [...pointers.values()];
          mode = zoom.scale > MIN_SCALE + 0.001 ? "pan" : "undecided";
          startPt = { ...p };
          startAt = e.timeStamp;
          panFrom = { ...zoom.t };
          samplesX = [{ t: e.timeStamp, v: p.x }];
          samplesY = [{ t: e.timeStamp, v: p.y }];
          return;
        }
        if (zoom.scale <= MIN_SCALE + 0.001) setZoom(MIN_SCALE, { x: 0, y: 0 }, true);
        else setZoomed(true);
        mode = "idle";
        return;
      }
      if (pointers.size > 0) return;
      const moved = Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y);
      if (mode === "undecided") {
        if (moved < TAP_SLOP_PX && e.timeStamp - startAt < TAP_MAX_MS) onTap({ x: e.clientX, y: e.clientY });
        mode = "idle";
        return;
      }
      if (mode === "dragY") {
        const vy = velocityOf(samplesY, e.timeStamp, e.clientY);
        if (shouldDismiss(dy, vy, window.innerHeight || 1)) close("fall", true, dy);
        else springBack();
      } else if (mode === "dragX") {
        const vx = velocityOf(samplesX, e.timeStamp, e.clientX);
        const target = pageTarget(indexRef.current, images.length, dx, vx, window.innerWidth || 1);
        dx = 0;
        if (target !== indexRef.current) {
          resetZoom();
          indexRef.current = target;
          setIndex(target);
        }
        settleStrip(true);
      } else if (mode === "pan") {
        setZoom(zoom.scale, zoom.t, false);
      }
      mode = "idle";
    };

    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        if (mode === "dragY") springBack();
        if (mode === "dragX") {
          dx = 0;
          settleStrip(true);
        }
        mode = "idle";
      }
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onCancel);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
      if (tapTimer !== null) window.clearTimeout(tapTimer);
    };
  }, [close, images.length, settleStrip]);

  /* ---------- chrome actions ---------- */

  const current = images[index];
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const onShare = async () => {
    if (!current) return;
    const url = new URL(current.url, window.location.href).toString();
    try {
      const res = await fetch(current.url);
      const blob = await res.blob();
      const file = new File([blob], current.name ?? "image", { type: blob.type || "image/*" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch {
      // Falling back to the URL is better than telling the reader the share failed.
    }
    try {
      await navigator.share({ url });
    } catch {
      // The user cancelled the share sheet, or the browser refused it. Nothing to say.
    }
  };

  const onOpen = () => {
    if (current) window.open(current.url, "_blank", "noopener");
  };

  return createPortal(
    <div
      ref={rootRef}
      className={`iv${chrome ? "" : " iv-bare"}${zoomed ? " iv-zoomed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={current?.name ?? "Image"}
    >
      <div className="iv-scrim" ref={scrimRef} aria-hidden />
      <div className="iv-stage" ref={stageRef}>
        <div className="iv-strip" ref={stripRef} style={{ width: `${images.length * 100}%` }}>
          {images.map((im, i) => (
            <div className="iv-slide" key={im.url} style={{ width: `${100 / images.length}%` }}>
              <img
                ref={(el) => {
                  imgRefs.current[i] = el;
                }}
                className="iv-img"
                src={im.url}
                alt={im.name ?? "attachment"}
                draggable={false}
                style={im.width && im.height ? { aspectRatio: `${im.width} / ${im.height}` } : undefined}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="iv-chrome iv-top">
        <button className="iv-btn iv-close" onClick={() => close("flip", true)} aria-label="Close">
          {Icons.close(22)}
        </button>
        <div className="iv-title">
          <span className="iv-who">{author}</span>
          <span className="iv-when">{agoText(createdAt)}</span>
        </div>
        <span className="iv-btn iv-spacer" aria-hidden />
      </div>

      <div className="iv-chrome iv-bottom">
        {/* Three slots, always: Share is hidden where the browser has no share sheet, and
            an empty slot in its place is what keeps the dots on the centre line. */}
        {canShare ? (
          <button className="iv-action" onClick={onShare}>
            {Icons.send(18)} Share
          </button>
        ) : (
          <span className="iv-slot" aria-hidden />
        )}
        <div className="iv-dots" aria-hidden>
          {images.length > 1 && images.map((im, i) => (
            <span key={im.url} className={`iv-dot${i === index ? " on" : ""}`} />
          ))}
        </div>
        <button className="iv-action" onClick={onOpen}>
          {Icons.external(18)} Open
        </button>
      </div>
    </div>,
    document.body,
  );
}
