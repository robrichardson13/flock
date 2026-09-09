import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `4a5bc63` added a mobile `max-height` on `.line-composer-input` to make collapse-on-scroll
 * continuous, but left it ungated: it capped the field to one line at *every* value of
 * `--composer-collapse`, so a growing draft was clipped mid-glyph (card #1's diagnosis, card
 * #2's fix). The fix gates that rule on `.composer-open` — a class mirroring `userExpanded`
 * (thread.tsx) — so a focused/non-empty/staged composer falls through to the base 212px cap
 * and `useAutoGrow`'s inline height instead of being pinned to one line.
 *
 * This asserts the gate stays in place using the styles.css-as-text pattern from
 * `hover-gate.test.ts` (a CSSOM walk over nested rules is not trustworthy — see that file's
 * comment) rather than asserting the clamp's actual pixel behaviour: happy-dom computes
 * neither `max-height` nor `scrollHeight`, so the clamp itself is not unit-testable. A
 * regression here is a real browser/manual check (card #3), not this test.
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

describe("the mobile collapse's max-height on .line-composer-input is gated on rest", () => {
  it("every max-height rule on .line-composer-input inside the mobile media query excludes .composer-open", () => {
    const all = rules(CSS);
    const offenders = all
      .filter(
        (r) =>
          inMobileMediaQuery(r) &&
          /\.line-composer-input\b/.test(r.selector) &&
          /max-height\s*:/.test(r.body) &&
          !/:not\(\.composer-open\)/.test(r.selector),
      )
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  /** The parser has to actually see the rule it is meant to catch, or the assertion above is
   *  vacuous. */
  it("the walk actually finds the gated rule", () => {
    const all = rules(CSS);
    const gated = all.filter(
      (r) =>
        inMobileMediaQuery(r) &&
        /\.line-composer-input\b/.test(r.selector) &&
        /max-height\s*:/.test(r.body) &&
        /:not\(\.composer-open\)/.test(r.selector),
    );
    expect(gated.length).toBeGreaterThan(0);
  });
});
