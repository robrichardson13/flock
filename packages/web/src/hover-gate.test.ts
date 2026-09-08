import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Every `:hover` rule that paints must sit inside `@media (hover: hover)` — recipe step 3 in
 * `styles.css`. A touch device has no pointer to take a hover away again, so an ungated one
 * is a fill left painted behind after the tap.
 *
 * Cards #6, #8 and #14 all "proved" this held by walking the CSSOM in the browser and
 * counting the ungated rules. All three reported 0, and the count was a tautology: their walk
 * recursed into `rule.cssRules` and `continue`d before testing `selectorText`, and in a
 * Chromium that supports CSS nesting *every* `CSSStyleRule` carries a (usually empty)
 * `cssRules`. Instrumented against the live app, that branch swallowed 890 style rules and
 * the `:hover` test ran on none of them; the walk could not have returned anything but 0 for
 * any stylesheet whatsoever. Five ungated rules were live at the time, one of them on an
 * element that renders only on the phone (#16).
 *
 * So this reads the stylesheets as text. It cannot be quietly defeated by an engine changing
 * the shape of a DOM object underneath it, it needs no browser and no running app, and it
 * fails in `bun test` rather than in a verification pass that may or may not be run again.
 */
const SHEETS = ["styles.css", "board-desktop.css", "brand.css", "compose.css", "viewer.css"];

/** Properties whose value is something the user can see left behind. `cursor`, `z-index` and
 *  friends are not: a stuck one paints nothing. */
const VISUAL =
  /^(background|background-[a-z-]+|color|opacity|filter|backdrop-filter|border|border-[a-z-]+|box-shadow|transform|text-decoration|text-decoration-[a-z-]+|outline|outline-[a-z-]+)$/;

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
        // A style rule: take its body verbatim, then recurse into it for nested rules.
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

const gated = (r: Rule) => r.stack.some((a) => /@media[^{]*hover\s*:\s*hover/.test(a));

function visualDecls(body: string): string[] {
  return body
    .split(";")
    .map((d) => d.split(":")[0]?.trim() ?? "")
    .filter((p) => VISUAL.test(p));
}

describe("every :hover rule that paints is gated behind (hover: hover)", () => {
  for (const file of SHEETS) {
    it(file, () => {
      const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const all = rules(css);
      const ungated = all
        .filter((r) => /:hover/.test(r.selector) && !gated(r) && visualDecls(r.body).length > 0)
        .map((r) => `${r.selector} { ${visualDecls(r.body).join(", ")} }`);
      expect(ungated).toEqual([]);
    });
  }

  /** The parser has to actually see rules, or this file repeats the very failure it exists to
   *  catch. `styles.css` carries the bulk of the app's hover rules; if this count collapses,
   *  the walk above has stopped walking. */
  it("the walk reaches the rules it is checking", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const all = rules(css);
    expect(all.length).toBeGreaterThan(400);
    expect(all.filter((r) => /:hover/.test(r.selector)).length).toBeGreaterThan(20);
    expect(all.filter((r) => /:hover/.test(r.selector) && gated(r)).length).toBeGreaterThan(20);
  });
});
