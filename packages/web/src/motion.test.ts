import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { D_BASE, D_FAST, D_FLIP, D_SLOW, EASE_IN, EASE_OUT, EASE_SPRING } from "./motion.ts";

/**
 * `motion.ts` is the one place a duration or a curve is spelled out in JS; this asserts it
 * agrees with the one place they are spelled out in CSS. In the spirit of the contrast
 * gate (`scripts/contrast.ts`): read the stylesheet itself, not a copy of its values, so a
 * token edited in one place and not the other fails here instead of drifting silently
 * (critique #17's B9 — `live.ts` disagreeing with styles.css is exactly this bug).
 */
const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** The value of `--name`, wherever in the file it is declared (styles.css has several
 *  `:root` blocks — identity tints reopen it further down — so this matches the
 *  declaration itself rather than assuming which block it lives in). */
function token(name: string): string {
  const m = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`styles.css has no --${name}`);
  return m[1].trim();
}

const ms = (v: string) => Number(v.replace("ms", ""));

describe("motion.ts mirrors styles.css's token block", () => {
  it("durations", () => {
    expect(D_FAST).toBe(ms(token("d-fast")));
    expect(D_BASE).toBe(ms(token("d-base")));
    expect(D_SLOW).toBe(ms(token("d-slow")));
    expect(D_FLIP).toBe(ms(token("d-flip")));
  });

  it("curves", () => {
    expect(EASE_OUT).toBe(token("ease-out"));
    expect(EASE_SPRING).toBe(token("ease-spring"));
    expect(EASE_IN).toBe(token("ease-in"));
  });
});
