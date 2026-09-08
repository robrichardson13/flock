/**
 * Pure geometry and gesture math for the full-screen image viewer, kept out of
 * `Viewer.tsx` so the thresholds and the transforms can be tested without a DOM.
 * Every function here is a pure function of numbers; the component owns the
 * pointer bookkeeping and writes the results straight to element styles.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* ---------- thresholds ---------- */

/** Swipe-down dismiss: past this fraction of the viewport height, or this fast, it goes.
 *  Mirrors the shape of `useEdgeSwipeBack`'s distance-or-velocity rule. */
export const DISMISS_DISTANCE_FRACTION = 0.22;
export const DISMISS_VELOCITY_PX_MS = 0.6;
/** Horizontal paging between the images of one message. */
export const PAGE_DISTANCE_FRACTION = 0.28;
export const PAGE_VELOCITY_PX_MS = 0.4;
/** A tap is a press that neither moved far nor lasted long. */
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 400;
/** Two taps this close in time and space are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;
/** Zoom range. Double tap toggles between the two ends of `DOUBLE_TAP_SCALE`. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
export const DOUBLE_TAP_SCALE = 2.5;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ---------- dismiss ---------- */

/** Release decision for the swipe-down: distance past a fraction of the viewport, or
 *  a fast enough downward flick. An upward drag never dismisses. */
export function shouldDismiss(dy: number, velocityY: number, height: number): boolean {
  if (dy <= 0) return false;
  const h = height || 1;
  return dy / h > DISMISS_DISTANCE_FRACTION || velocityY > DISMISS_VELOCITY_PX_MS;
}

/** Scrim opacity while dragging down: full black at rest, thinning towards the photo
 *  behind as the image is carried away, never quite transparent. */
export function scrimAlpha(dy: number, height: number): number {
  const h = height || 1;
  return clamp(1 - (Math.max(0, dy) / h) * 1.6, 0.25, 1);
}

/** The image shrinks a little as it falls, the way iOS Photos does. */
export function dismissScale(dy: number, height: number): number {
  const h = height || 1;
  return clamp(1 - (Math.max(0, dy) / h) * 0.5, 0.6, 1);
}

/* ---------- paging ---------- */

/**
 * Which image a horizontal release lands on. `dx` is positive dragging right (towards
 * the previous image). Never pages past either end.
 */
export function pageTarget(index: number, count: number, dx: number, velocityX: number, width: number): number {
  const w = width || 1;
  const far = Math.abs(dx) / w > PAGE_DISTANCE_FRACTION;
  const fast = Math.abs(velocityX) > PAGE_VELOCITY_PX_MS && Math.sign(velocityX) === Math.sign(dx);
  if (!far && !fast) return index;
  const next = dx < 0 ? index + 1 : index - 1;
  return clamp(next, 0, Math.max(0, count - 1));
}

/** Rubber-banding at the two ends, so a swipe past the last image resists instead of
 *  sliding onto nothing. */
export function pageOffset(index: number, count: number, dx: number): number {
  const atStart = index === 0 && dx > 0;
  const atEnd = index >= count - 1 && dx < 0;
  return atStart || atEnd ? dx * 0.35 : dx;
}

/* ---------- zoom and pan ---------- */

/**
 * A new translate that keeps the content under `anchor` (relative to the element's
 * centre, which is its transform-origin) in place while the scale goes `s` -> `s2`.
 */
export function zoomAbout(anchor: Point, translate: Point, s: number, s2: number): Point {
  const px = (anchor.x - translate.x) / s;
  const py = (anchor.y - translate.y) / s;
  return { x: anchor.x - s2 * px, y: anchor.y - s2 * py };
}

/** Pinch scale from the ratio of the two finger distances, clamped to the zoom range. */
export function pinchScale(startScale: number, startDistance: number, distance: number): number {
  if (startDistance <= 0) return startScale;
  return clamp((startScale * distance) / startDistance, MIN_SCALE, MAX_SCALE);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Keep a zoomed image's edges inside the viewport: the image can be panned by at most
 * half of the overflow in each axis. At 1x there is nothing to pan, so it snaps back
 * to centre.
 */
export function clampPan(translate: Point, scale: number, width: number, height: number): Point {
  const maxX = Math.max(0, (width * scale - width) / 2);
  const maxY = Math.max(0, (height * scale - height) / 2);
  return { x: clamp(translate.x, -maxX, maxX), y: clamp(translate.y, -maxY, maxY) };
}

/* ---------- FLIP ---------- */

export interface Flip {
  x: number;
  y: number;
  scale: number;
}

/**
 * The transform (origin `0 0`) that puts `to` — the image's laid-out box — back over
 * `from`, the thumbnail it was opened from. Scale is uniform on width so the image
 * keeps its aspect ratio even when the thumbnail was a cropped square; the two centres
 * are matched, which is what the eye follows.
 */
export function flipFrom(from: Box, to: Box): Flip {
  const scale = to.width > 0 ? from.width / to.width : 1;
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;
  const toCx = to.left + to.width / 2;
  const toCy = to.top + to.height / 2;
  return { x: fromCx - scale * toCx, y: fromCy - scale * toCy, scale };
}

export function flipCss(f: Flip): string {
  return `translate3d(${f.x}px, ${f.y}px, 0) scale(${f.scale})`;
}

/** Velocity over the trailing samples, in px/ms; same window as the edge-swipe. */
export const VELOCITY_WINDOW_MS = 100;

export function velocityOf(samples: { t: number; v: number }[], now: number, value: number): number {
  const cutoff = now - VELOCITY_WINDOW_MS;
  const recent = samples.filter((s) => s.t >= cutoff);
  const first = recent[0] ?? samples[0];
  if (!first) return 0;
  const dt = now - first.t;
  return dt > 0 ? (value - first.v) / dt : 0;
}
