import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Card #1's diagnosis, card #2's fix (decision d1). `0730125` wrapped the textarea in
 * `.composer-field { position: relative }` with the input at `z-index: 1` (styles.css:1583,
 * 1588), so it paints and hit-tests *after* a static sibling. The mobile `--btn-lift` rule
 * (styles.css, `@media (max-width: 899px)`) slides the attach/send row up to 40px into that
 * field's box, so a tap in the overlap resolved to the textarea instead of the button — the
 * keyboard opened instead of the message sending.
 *
 * The fix gives the lifted buttons their own stacking context above the field: this pins that
 * the mobile `.icon-btn` rule carrying `--btn-lift`/`margin-top` declares `position: relative`
 * and a `z-index` strictly greater than the field input's `z-index: 1`, using the
 * styles.css-as-text rule parser from `composer-clamp.test.ts`/`hover-gate.test.ts` (a CSSOM
 * walk over nested rules is not trustworthy there either).
 */
const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Rule = { selector: string; body: string; stack: string[] };

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

function declaration(body: string, prop: string): string | null {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

describe("the lifted mobile .icon-btn wins the hit test over .composer-field", () => {
  const liftRule = () =>
    rules(CSS).find(
      (r) => inMobileMediaQuery(r) && /\.line-composer\s*>\s*\.icon-btn\b/.test(r.selector) && /--btn-lift\s*:/.test(r.body),
    );

  const fieldInputRule = () => rules(CSS).find((r) => /\.composer-field\s*>\s*\.line-composer-input\b/.test(r.selector));

  it("finds both rules the mechanism depends on", () => {
    expect(liftRule()).toBeTruthy();
    expect(fieldInputRule()).toBeTruthy();
  });

  it("the field's input rule is what the lifted button has to out-stack", () => {
    const field = fieldInputRule()!;
    expect(declaration(field.body, "z-index")).toBe("1");
  });

  it("the lift rule gives itself a stacking context (position: relative)", () => {
    const lift = liftRule()!;
    expect(declaration(lift.body, "position")).toBe("relative");
  });

  it("the lift rule's z-index is a number strictly greater than the field input's", () => {
    const lift = liftRule()!;
    const field = fieldInputRule()!;
    const liftZ = Number(declaration(lift.body, "z-index"));
    const fieldZ = Number(declaration(field.body, "z-index"));
    expect(Number.isFinite(liftZ)).toBe(true);
    expect(liftZ).toBeGreaterThan(fieldZ);
  });
});
