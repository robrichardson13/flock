import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `4a5bc63` added a mobile `max-height` on `.line-composer-input` to make collapse-on-scroll
 * continuous, but left it ungated: it capped the field to one line at *every* value of
 * `--composer-collapse`, so a growing draft was clipped mid-glyph (card #1's diagnosis, card
 * #2's fix, commit `21bfab4`). That fix gated the clamp on `.composer-open` — a class
 * mirroring `userExpanded` (thread.tsx) — so a focused/non-empty/staged composer fell through
 * to the base 212px cap and `useAutoGrow`'s inline height instead of being pinned to one line.
 *
 * Card #6 asks a blurred *draft* composer to keep collapsing too (design write-up #5, approach
 * A: the line-quantized peek), so `.composer-open` on its own is no longer "never clamped" —
 * it now splits on `.composer-focused` (mirroring the field's own focus, added by #6):
 *   - `.composer-open:not(.composer-focused)` (a blurred draft) gets a *new* max-height that
 *     interpolates from the grown height (`--composer-grown-h`) down to one whole line box,
 *     quantized with `round(down, …, var(--lh-body))` so the ceiling is never a fraction of a
 *     line — the mid-glyph slice was arithmetic (48px against a 24px line box always cuts a
 *     glyph), so the invariant this file now pins is quantization, not "no clamp at all".
 *   - `.composer-focused` never gets a mobile max-height — focus keeps the pre-#6, pre-#2-fix
 *     behaviour (the base 212px cap plus the live inline height) unconditionally.
 *   - `:not(.composer-open)` (genuinely empty and unfocused) keeps #2's untouched 48px->40px
 *     resting interpolation.
 *
 * Uses the styles.css-as-text pattern from `hover-gate.test.ts` (a CSSOM walk over nested rules
 * is not trustworthy — see that file's comment) rather than asserting the clamp's actual pixel
 * behaviour: happy-dom computes neither `max-height` nor `scrollHeight`, so the clamp itself is
 * not unit-testable. A regression here is a real browser/manual check (card #3), not this test.
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

const inMobileMediaQuery = (r: Rule) => r.stack.some((a) => /@media[^{]*max-width\s*:\s*899px/.test(a));

const isRestGate = (selector: string) => /:not\(\.composer-open\)/.test(selector);
const isPeekGate = (selector: string) => /\.composer-open\b/.test(selector) && /:not\(\.composer-focused\)/.test(selector);
const isFocused = (selector: string) => /\.composer-focused\b/.test(selector) && !/:not\(\.composer-focused\)/.test(selector);

describe("the mobile collapse's max-height on .line-composer-input", () => {
  const maxHeightRules = () =>
    rules(CSS).filter((r) => inMobileMediaQuery(r) && /\.line-composer-input\b/.test(r.selector) && /max-height\s*:/.test(r.body));

  it("only ever clamps the resting-empty gate or the blurred-draft peek gate — never ungated, never while focused", () => {
    const offenders = maxHeightRules()
      .filter((r) => !isRestGate(r.selector) && !isPeekGate(r.selector))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("never clamps .composer-focused — a focused composer keeps the base cap plus the live inline height", () => {
    const offenders = maxHeightRules()
      .filter((r) => isFocused(r.selector))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("the blurred-draft peek's ceiling is quantized to whole line boxes (round(down, …, var(--lh-body)))", () => {
    const peek = maxHeightRules().filter((r) => isPeekGate(r.selector));
    expect(peek.length).toBeGreaterThan(0);
    for (const r of peek) {
      expect(r.body).toMatch(/round\(\s*down\s*,/);
      // The quantization step — round()'s last argument — has to be a whole line box, or
      // this is quantizing to the wrong unit.
      expect(r.body).toMatch(/,\s*var\(--lh-body\)\s*\)/);
    }
  });

  it("the blurred-draft peek interpolates from the grown height (--composer-grown-h), not a fixed constant", () => {
    const peek = maxHeightRules().filter((r) => isPeekGate(r.selector));
    expect(peek.length).toBeGreaterThan(0);
    for (const r of peek) {
      expect(r.body).toMatch(/var\(--composer-grown-h/);
    }
  });

  /** The parser has to actually see the rules it is meant to catch, or the assertions above
   *  are vacuous. */
  it("the walk actually finds both the resting gate and the peek gate", () => {
    const all = maxHeightRules();
    expect(all.some((r) => isRestGate(r.selector))).toBe(true);
    expect(all.some((r) => isPeekGate(r.selector))).toBe(true);
  });
});

describe("a blurred draft's peek reads as a window, not a cut", () => {
  it("the peek rule hides overflow rather than leaving it scrollable, and masks the bottom edge instead of hard-cutting it", () => {
    const peek = rules(CSS).filter(
      (r) => inMobileMediaQuery(r) && /\.line-composer-input\b/.test(r.selector) && isPeekGate(r.selector),
    );
    expect(peek.length).toBeGreaterThan(0);
    for (const r of peek) {
      expect(r.body).toMatch(/overflow\s*:\s*hidden/);
      expect(r.body).toMatch(/mask-image\s*:/);
    }
  });
});

describe("the collapsed peek never paints the draft under the send button or the paperclip", () => {
  const peekInput = () =>
    rules(CSS).filter((r) => inMobileMediaQuery(r) && /\.line-composer-input\b/.test(r.selector) && isPeekGate(r.selector));

  /**
   * Card #15: `--btn-lift` seats the attach/send row *inside* the field's box as collapse
   * progresses, and a round button only paints inside its circle — the corners of its own box
   * stay transparent — so the collapsed line's tail showed through and under the send button.
   * The fix is on the textarea, not behind the buttons (#12 rejected an opaque backdrop): one
   * extra mask layer per button, a radial hole shaped and positioned like that button, on top
   * of the existing vertical fade.
   */
  it("punches a radial hole per button into the textarea's mask, keeping the vertical fade", () => {
    const peek = peekInput();
    expect(peek.length).toBeGreaterThan(0);
    for (const r of peek) {
      for (const prop of ["mask-image", "-webkit-mask-image"]) {
        const decl = r.body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`))?.[1] ?? "";
        // The bottom fade #6 shipped, plus one radial per button — a declaration carrying only
        // the fade would silently drop the button holes in whichever engine reads that property.
        expect(decl).toMatch(/linear-gradient\(\s*to bottom[^)]*var\(--peek-fade\)/);
        expect(decl.match(/radial-gradient\(/g)?.length).toBe(2);
        expect(decl).toMatch(/radial-gradient\([^;]*at right[^;]*var\(--peek-clear-send\)/);
        expect(decl).toMatch(/radial-gradient\([^;]*at left[^;]*var\(--peek-clear-attach\)/);
      }
    }
  });

  /**
   * The hole has to sit on the button, so its centre is derived from the same arithmetic
   * `--btn-lift` uses — the lift, minus the row-gap, minus half a `--tap` — not from a
   * hand-tuned constant that would drift the moment either endpoint moves. It is negative
   * (below the field, clearing nothing) until the lift has actually pulled the row into the
   * field, which is what makes a progress gate unnecessary.
   */
  it("centres each hole on the button, from --btn-lift's own arithmetic", () => {
    const peek = peekInput();
    for (const r of peek) {
      const cy = r.body.match(/--peek-btn-cy\s*:\s*([\s\S]*?);/)?.[1] ?? "";
      expect(cy).toMatch(/var\(--lh-body\)/);
      expect(cy).toMatch(/var\(--composer-collapse/);
      expect(cy).toMatch(/var\(--tap\)\s*\/\s*2/);
      // Horizontally: half a --tap in from each end, the button's own centre.
      for (const decl of ["mask-image"]) {
        const body = r.body.match(new RegExp(`(?:^|[;\\s])${decl}\\s*:\\s*([^;]+);`))?.[1] ?? "";
        expect(body).toMatch(/at right calc\(var\(--tap\) \/ 2\) bottom var\(--peek-btn-cy\)/);
        expect(body).toMatch(/at left calc\(var\(--tap\) \/ 2\) bottom var\(--peek-btn-cy\)/);
      }
    }
  });

  /** The paperclip is `scale(1 - collapse)`d away, so its hole must close on the same curve —
   *  at full collapse there is no paperclip and the draft's opening characters must be whole. */
  it("closes the paperclip's hole on the paperclip's own fade curve", () => {
    const peek = peekInput();
    for (const r of peek) {
      for (const name of ["--peek-clear-attach", "--peek-feather-attach"]) {
        const decl = r.body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1] ?? "";
        expect(decl).toMatch(/1\s*-\s*var\(--composer-collapse/);
      }
      // Send keeps --tap throughout, so its hole must not shrink with progress.
      const send = r.body.match(/--peek-clear-send\s*:\s*([^;]+);/)?.[1] ?? "";
      expect(send).toMatch(/var\(--tap\)/);
      expect(send).not.toMatch(/var\(--composer-collapse/);
    }
  });

  it("composites the layers so any one of them can hide a pixel", () => {
    const peek = peekInput();
    for (const r of peek) {
      expect(r.body).toMatch(/mask-composite\s*:\s*intersect/);
      expect(r.body).toMatch(/-webkit-mask-composite\s*:\s*source-in/);
    }
  });

  /** No backdrop behind a button: the round `--tap` shape and its transparent corners are the
   *  approved look (#12 rejected an opaque square), so the clear has to stay on the textarea. */
  it("adds no opaque backdrop behind the composer's buttons", () => {
    const offenders = rules(CSS)
      .filter((r) => inMobileMediaQuery(r) && /\.icon-btn-fill\b/.test(r.selector))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });
});
