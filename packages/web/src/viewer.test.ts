import { describe, expect, it } from "bun:test";
import {
  clampPan,
  DISMISS_DISTANCE_FRACTION,
  DOUBLE_TAP_SCALE,
  dismissScale,
  distance,
  flipCss,
  flipFrom,
  midpoint,
  pageOffset,
  pageTarget,
  pinchScale,
  scrimAlpha,
  shouldDismiss,
  velocityOf,
  zoomAbout,
} from "./viewer.ts";

describe("shouldDismiss", () => {
  it("keeps the viewer for a short, slow drag", () => {
    expect(shouldDismiss(60, 0.1, 800)).toBe(false);
  });

  it("dismisses past the distance threshold", () => {
    expect(shouldDismiss(800 * DISMISS_DISTANCE_FRACTION + 1, 0, 800)).toBe(true);
  });

  it("dismisses a short but fast flick", () => {
    expect(shouldDismiss(40, 1.2, 800)).toBe(true);
  });

  it("never dismisses upwards, however fast", () => {
    expect(shouldDismiss(-200, -3, 800)).toBe(false);
  });
});

describe("scrimAlpha and dismissScale", () => {
  it("are at rest with no drag", () => {
    expect(scrimAlpha(0, 800)).toBe(1);
    expect(dismissScale(0, 800)).toBe(1);
  });

  it("thin and shrink as the image falls, within bounds", () => {
    expect(scrimAlpha(200, 800)).toBeLessThan(1);
    expect(scrimAlpha(10_000, 800)).toBe(0.25);
    expect(dismissScale(200, 800)).toBeLessThan(1);
    expect(dismissScale(10_000, 800)).toBe(0.6);
  });

  it("ignores an upward drag", () => {
    expect(scrimAlpha(-200, 800)).toBe(1);
  });
});

describe("pageTarget", () => {
  it("stays put for a small, slow drag", () => {
    expect(pageTarget(1, 3, -40, 0.05, 390)).toBe(1);
  });

  it("advances on a long drag left and retreats on one right", () => {
    expect(pageTarget(1, 3, -200, 0, 390)).toBe(2);
    expect(pageTarget(1, 3, 200, 0, 390)).toBe(0);
  });

  it("advances on a fast flick in the same direction only", () => {
    expect(pageTarget(0, 3, -30, -0.9, 390)).toBe(1);
    expect(pageTarget(0, 3, -30, 0.9, 390)).toBe(0);
  });

  it("never pages past either end", () => {
    expect(pageTarget(0, 3, 300, 0, 390)).toBe(0);
    expect(pageTarget(2, 3, -300, 0, 390)).toBe(2);
    expect(pageTarget(0, 1, -300, 0, 390)).toBe(0);
  });
});

describe("pageOffset", () => {
  it("follows the finger in the middle of the strip", () => {
    expect(pageOffset(1, 3, -100)).toBe(-100);
  });

  it("rubber-bands at both ends", () => {
    expect(pageOffset(0, 3, 100)).toBeCloseTo(35);
    expect(pageOffset(2, 3, -100)).toBeCloseTo(-35);
  });
});

describe("pinchScale", () => {
  it("scales with the ratio of the finger distances", () => {
    expect(pinchScale(1, 100, 200)).toBe(2);
    expect(pinchScale(2, 200, 100)).toBe(1);
  });

  it("clamps to the zoom range", () => {
    expect(pinchScale(1, 100, 10)).toBe(1);
    expect(pinchScale(4, 100, 1000)).toBe(6);
  });

  it("is a no-op without a starting distance", () => {
    expect(pinchScale(2.5, 0, 500)).toBe(2.5);
  });
});

describe("zoomAbout", () => {
  it("keeps the content under the anchor in place", () => {
    const anchor = { x: 80, y: -40 };
    const t = { x: 0, y: 0 };
    const t2 = zoomAbout(anchor, t, 1, DOUBLE_TAP_SCALE);
    // The point that was under the anchor: p = (anchor - t) / s, and after the zoom it
    // must land back on the anchor.
    const p = { x: anchor.x - t.x, y: anchor.y - t.y };
    expect(t2.x + DOUBLE_TAP_SCALE * p.x).toBeCloseTo(anchor.x);
    expect(t2.y + DOUBLE_TAP_SCALE * p.y).toBeCloseTo(anchor.y);
  });

  it("is the identity when the scale does not change", () => {
    const t = { x: 12, y: -5 };
    expect(zoomAbout({ x: 30, y: 30 }, t, 2, 2)).toEqual(t);
  });

  it("zooming out about the centre returns to the origin", () => {
    expect(zoomAbout({ x: 0, y: 0 }, { x: 0, y: 0 }, 2.5, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("clampPan", () => {
  it("pins a 1x image to the centre", () => {
    expect(clampPan({ x: 200, y: 200 }, 1, 390, 500)).toEqual({ x: 0, y: 0 });
  });

  it("allows half the overflow in each axis", () => {
    // At 2x a 390x500 image overflows by 390 and 500; half of each is the limit.
    expect(clampPan({ x: 999, y: -999 }, 2, 390, 500)).toEqual({ x: 195, y: -250 });
  });

  it("leaves a translate inside the bounds alone", () => {
    expect(clampPan({ x: 20, y: -10 }, 2, 390, 500)).toEqual({ x: 20, y: -10 });
  });
});

describe("flipFrom", () => {
  const thumb = { left: 20, top: 600, width: 96, height: 96 };
  const full = { left: 0, top: 122, width: 390, height: 600 };

  it("scales the full image down onto the thumbnail's width", () => {
    expect(flipFrom(thumb, full).scale).toBeCloseTo(96 / 390);
  });

  it("puts the two centres on top of each other", () => {
    const f = flipFrom(thumb, full);
    const cx = full.left + full.width / 2;
    const cy = full.top + full.height / 2;
    expect(f.x + f.scale * cx).toBeCloseTo(thumb.left + thumb.width / 2);
    expect(f.y + f.scale * cy).toBeCloseTo(thumb.top + thumb.height / 2);
  });

  it("renders as a transform with the translate first", () => {
    expect(flipCss({ x: 1, y: 2, scale: 0.5 })).toBe("translate3d(1px, 2px, 0) scale(0.5)");
  });
});

describe("velocityOf", () => {
  it("is px per ms over the trailing window", () => {
    expect(velocityOf([{ t: 0, v: 0 }, { t: 100, v: 100 }], 200, 300)).toBeCloseTo(2);
  });

  it("ignores samples older than the window, so a pause reads as slow", () => {
    const samples = [{ t: 0, v: 0 }, { t: 1000, v: 500 }];
    expect(velocityOf(samples, 1050, 505)).toBeCloseTo(0.1);
  });

  it("is zero with nothing to go on", () => {
    expect(velocityOf([], 10, 10)).toBe(0);
  });
});

describe("distance and midpoint", () => {
  it("measure between two fingers", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});
