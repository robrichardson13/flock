import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Card #4: with the mobile bottom tab bar (and, on Channel/Decisions, the floating composer
 * chin) taken out of the document flow (`position: absolute`), a scroller that does not reserve
 * bottom space for them lets the tail of short content sit underneath that chrome with nothing
 * to scroll it clear of — the bug is specifically that content *just short of* needing a scroll
 * gets none, so the overlay covers it with no way to reveal it.
 *
 * The mechanism fixes that by giving every scroller under the tab bar a trailing reservation
 * that folds the chrome's height into `scrollHeight` itself, so as soon as content would touch
 * the overlay, the container becomes scrollable by exactly enough to clear it.
 *
 * Card #18: that reservation is a `::after` *box*, not `padding-bottom`. It was padding until
 * #18, which is correct in every engine except the one this bug lives in: iOS WebKit folds a
 * scroll container's trailing padding into its scrollable overflow only once the boxes inside
 * have already overflowed the padding box on their own. Below that threshold the padding is not
 * scrollable space at all — `scrollHeight === clientHeight`, no scroll, and the tail of the feed
 * stays under the composer with no gesture that can reveal it, which is card #4 again. The
 * human's phone reported exactly that: nine short messages, no scroll; ten, and the whole 228px
 * appeared at once (`scrollHeight` 1034 = content 806 + 228). Desktop WebKit counts the padding
 * either way, which is why three harness-verified fixes were rejected on device.
 *
 * A generated box has no such rule: it is laid out, it is in the flex flow, and it is in the
 * scrollable overflow rect unconditionally. So the three rules below now zero their
 * `padding-bottom` and publish the same expression as `--bottom-reserve`, which the shared
 * `::after` spends as its own height. This test pins that wiring:
 *
 * - Cards (`.screen-body`) and Activity (a `.pane` with no `.pane-foot`) only ever pay the tab
 *   bar's own clearance, `--pillbar-space` (itself `--pillbar-h + --pillbar-gap + --s2 +
 *   --sab-in`, so it already carries the iOS safe-area inset via `--sab-in`).
 * - Channel and Decisions (a `.pane` that *has* a `.pane-foot`, i.e. carries the composer) pay
 *   `--composer-space`, which is `--pillbar-space` plus the composer's own reservation — so it
 *   tracks both the tab bar and the composer's height. `--composer-space` (not the live,
 *   continuously-moving `--composer-h`) is deliberately what a bottom inset should key off: the
 *   live height chases the composer through scroll-collapse and auto-grow and fighting that is
 *   what card #6 in this codebase's own history had to fix for `scrollHeight` once already.
 *
 * The spacer cancels one flex `gap` with a negative `margin-top`, so the reserved distance is
 * the same number the padding reserved rather than that plus a gap — which is only expressible
 * because every `gap` on these two scrollers is now named `--scroll-gap`.
 *
 * Uses the styles.css-as-text pattern from `hover-gate.test.ts` / `composer-clamp.test.ts`
 * rather than a CSSOM walk (untrustworthy for nested rules) or asserting real layout: happy-dom
 * computes neither `max-height` nor `scrollHeight`/`clientHeight`, so the actual scroll math is
 * not unit-testable here — a regression in the geometry itself is a real-browser check.
 */
const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Rule = { selector: string; body: string; stack: string[] };

/** Flatten a stylesheet into its style rules, each carrying the at-rule preludes it is nested
 *  inside. Comment-aware, brace-matched; no CSSOM, no regex over the whole file. */
function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = head.trim();
      head = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
      } else {
        let depth = 1;
        let j = i + 1;
        for (; j < src.length && depth > 0; j++) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
        }
        const body = src.slice(i + 1, j - 1);
        out.push({ selector: prelude, body: body.replace(/\{[\s\S]*?\}/g, ""), stack: [...stack] });
        for (const nested of rules(body)) out.push({ ...nested, stack: [...stack, prelude, ...nested.stack] });
        i = j - 1;
      }
    } else if (c === "}") {
      stack.pop();
      head = "";
    } else if (c === ";" && !head.includes("{")) {
      head = "";
    } else {
      head += c;
    }
  }
  return out;
}

function declares(body: string, prop: string, valuePattern: RegExp): boolean {
  const re = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (valuePattern.test(m[2])) return true;
  }
  return false;
}

describe("mobile scroll containers reserve bottom space for the tab bar and composer", () => {
  const all = rules(CSS);

  it("Cards' .screen-body pays --pillbar-space", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .screen-body");
    expect(r).toBeDefined();
    expect(declares(r!.body, "--bottom-reserve", /--pillbar-space/)).toBe(true);
  });

  it("Activity's composer-less .pane-scroll pays --pillbar-space", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .pane:not(:has(> .pane-foot)) .pane-scroll");
    expect(r).toBeDefined();
    expect(declares(r!.body, "--bottom-reserve", /--pillbar-space/)).toBe(true);
  });

  it("Channel/Decisions' .pane-scroll (a pane that has a .pane-foot) pays --composer-space, not raw --composer-h", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .pane:has(> .pane-foot) .pane-scroll");
    expect(r).toBeDefined();
    expect(declares(r!.body, "--bottom-reserve", /--composer-space/)).toBe(true);
  });

  // #18: the reservation is spent as a box, and the padding it used to be spent as is gone.
  // Trailing padding on these scrollers is the exact thing iOS WebKit refuses to make
  // scrollable until it is already too late, so a reservation must never live there again.
  it("no scroller under the tab bar spends its reservation as trailing padding", () => {
    for (const selector of [
      ".screen:has(.tabbar) .screen-body",
      ".screen:has(.tabbar) .pane:not(:has(> .pane-foot)) .pane-scroll",
      ".screen:has(.tabbar) .pane:has(> .pane-foot) .pane-scroll",
    ]) {
      const r = all.find((x) => x.selector === selector);
      expect(r).toBeDefined();
      expect(declares(r!.body, "padding-bottom", /0/)).toBe(true);
      expect(declares(r!.body, "padding-bottom", /--pillbar-space|--composer-space/)).toBe(false);
    }
  });

  it("the ::after spacer is a real, unshrinkable box whose height is that reservation", () => {
    const r = all.find(
      (x) => x.selector === ".screen:has(.tabbar) .screen-body::after,\n.screen:has(.tabbar) .pane .pane-scroll::after",
    );
    expect(r).toBeDefined();
    // Without `content` there is no box at all, and without `flex: none` a flex item with no
    // content shrinks to nothing — which is the reservation quietly evaporating.
    expect(declares(r!.body, "content", /""/)).toBe(true);
    expect(declares(r!.body, "flex", /none/)).toBe(true);
    expect(declares(r!.body, "height", /--bottom-reserve/)).toBe(true);
  });

  it("the spacer cancels exactly one flex gap, and every gap on these scrollers is nameable", () => {
    const spacer = all.find((x) => /\.pane-scroll::after$/.test(x.selector));
    expect(declares(spacer!.body, "margin-top", /calc\(\s*-1\s*\*\s*var\(--scroll-gap\)/)).toBe(true);
    // If any rule set `gap` to something other than `--scroll-gap`, the spacer would cancel a
    // gap of the wrong size on the scroller that rule applies to.
    const strays = all.filter(
      (x) => /(^|,|\s)(\.pane-scroll|\.screen-body)([.:][^\s,]*)?$/.test(x.selector.trim()) &&
        declares(x.body, "gap", /.*/) && !declares(x.body, "gap", /var\(--scroll-gap\)/),
    );
    expect(strays.map((x) => x.selector)).toEqual([]);
    // And every one of them names the value it uses.
    const named = all.filter((x) => declares(x.body, "--scroll-gap", /.*/));
    expect(named.length).toBeGreaterThanOrEqual(5);
  });

  it("--composer-space itself folds in --pillbar-space and the composer's measured height", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .pane:has(> .pane-foot)");
    expect(r).toBeDefined();
    expect(declares(r!.body, "--composer-space", /--pillbar-space/)).toBe(true);
    expect(declares(r!.body, "--composer-space", /--composer-h\b/)).toBe(true);
  });

  it("--pillbar-space (and so every reservation built on it) carries the iOS safe-area inset", () => {
    const r = all.find((x) => declares(x.body, "--pillbar-space", /--sab-in/));
    expect(r).toBeDefined();
  });

  it("--sab-in is ultimately derived from env(safe-area-inset-bottom)", () => {
    const r = all.find((x) => declares(x.body, "--sab", /env\(\s*safe-area-inset-bottom/));
    expect(r).toBeDefined();
  });
});

/**
 * Card #16: the precondition every assertion above silently assumes — that the shell fills the
 * glass, so a reservation measured from its bottom edge is measured from the bottom of the
 * screen.
 *
 * In the iOS home-screen app with `viewport-fit=cover` it did not. The page is laid out over
 * the whole display, but `window.innerHeight` comes back with the top safe-area inset already
 * subtracted, while `document.documentElement.clientHeight` — and the containing block every
 * `position: fixed` box is laid out against — stay the full display: **793 against 852** on the
 * human's phone. A shell sized from `innerHeight` therefore ended 59pt above the bottom of the
 * glass, which is one geometry with three faces: a band of dark under the tab bar, every
 * scroller 59pt short, and content sized to the real screen overflowing by a few tens of pixels
 * — a rubber-band rather than a scroll, with the last message left under the composer.
 *
 * No emulator produces that condition on its own: they set `innerHeight`,
 * `documentElement.clientHeight` and `visualViewport.height` from the single viewport they were
 * given, so the shell fills the glass by construction. Reproducing it takes a context of one
 * height with `innerHeight` overridden to a different one. The arithmetic side of the fix is
 * covered by `shellHeight` in `vv.test.ts`; this pins the CSS half and, crucially, its two
 * scopes.
 */
describe("the standalone shell fills the glass (#16)", () => {
  const all = rules(CSS);
  const floor = all.find((x) => /^html\[data-standalone\]:not\(\[data-keyboard\]\) \.app$/.test(x.selector));

  it("floors .app at the layout engine's own viewport, not only at the JS reading", () => {
    expect(floor).toBeDefined();
    // `dvh` is resolved against the very viewport the engine places this fixed box in, so it
    // cannot be short the way `innerHeight` is; `max()` keeps --vvh whenever it is the taller.
    expect(declares(floor!.body, "height", /max\(/)).toBe(true);
    expect(declares(floor!.body, "height", /--vvh/)).toBe(true);
    expect(declares(floor!.body, "height", /100dvh/)).toBe(true);
  });

  it("is scoped to standalone and to no-keyboard, and nothing else floors .app", () => {
    // Standalone only: in a Safari tab `100dvh` is the toolbars-retracted *large* viewport and
    // this would grow the shell under Safari's own chrome. No-keyboard only: a keyboard is
    // exactly when the visible strip is genuinely shorter than the viewport.
    const others = all.filter(
      (x) => /(^|,)\s*\.app\s*$/.test(x.selector) && declares(x.body, "height", /max\(/),
    );
    expect(others).toHaveLength(0);
    // The unscoped rules still size the shell from --vvh alone.
    const plain = all.filter((x) => /(^|,)\s*\.app\s*$/.test(x.selector) && declares(x.body, "height", /--vvh/));
    expect(plain.length).toBeGreaterThan(0);
  });
});
