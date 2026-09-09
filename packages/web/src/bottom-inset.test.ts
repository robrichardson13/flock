import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Card #4: with the mobile bottom tab bar (and, on Channel/Decisions, the floating composer
 * chin) taken out of the document flow (`position: absolute`), a scroller that does not reserve
 * bottom space for them lets the tail of short content sit underneath that chrome with nothing
 * to scroll it clear of — the bug is specifically that content *just short of* needing a scroll
 * gets none, so the overlay covers it with no way to reveal it.
 *
 * The mechanism already in this tree fixes that by giving every scroller under the tab bar a
 * `padding-bottom` that folds the chrome's height into `scrollHeight` itself, so as soon as
 * content would touch the overlay, the container becomes scrollable by exactly enough to clear
 * it (verified by hand at the mobile width across Cards, Channel, Activity and Decisions, at
 * content lengths straddling the scrollable/non-scrollable boundary, with the composer both at
 * rest and grown — see card #4's resolution). This test pins that the three scrollers keep their
 * padding wired to the right reservation:
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
    expect(declares(r!.body, "padding-bottom", /--pillbar-space/)).toBe(true);
  });

  it("Activity's composer-less .pane-scroll pays --pillbar-space", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .pane:not(:has(> .pane-foot)) .pane-scroll");
    expect(r).toBeDefined();
    expect(declares(r!.body, "padding-bottom", /--pillbar-space/)).toBe(true);
  });

  it("Channel/Decisions' .pane-scroll (a pane that has a .pane-foot) pays --composer-space, not raw --composer-h", () => {
    const r = all.find((x) => x.selector === ".screen:has(.tabbar) .pane:has(> .pane-foot) .pane-scroll");
    expect(r).toBeDefined();
    expect(declares(r!.body, "padding-bottom", /--composer-space/)).toBe(true);
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
