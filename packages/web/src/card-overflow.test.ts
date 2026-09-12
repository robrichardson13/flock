import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { splitDocumentBlocks } from "./markdown.tsx";

/**
 * Card 30: on mobile the card detail view could scroll sideways. Live reproduction (seeded
 * card with an 80-char unbroken title, a 200-char URL, a 150-char code line, a wide pipe
 * table, a checklist, eight labels, a long unbroken comment, a long-path resolution and a
 * long-filename attachment, measured with Playwright at 390x844 against both Chromium and
 * WebKit) found every one of those already contained by `overflow-wrap: anywhere` on `.md`,
 * `.msg-body`, `.detail-value` and `.card-heading`, and by `min-width: 0` on `.msg-main` — the
 * one open path left was structural, not content-shaped: `.screen-body.card-body` is a flex
 * column whose own children never shrink (`.screen-body > *` is `flex: none`), so a future
 * child that forgets its own wrap rule — the harness "Run block", or anything else — would
 * widen the body itself and put a scrollbar under the whole card rather than under just that
 * child. The fix is the backstop in styles.css: `.card-body { overflow-x: hidden }`. `pre`
 * inside `.md` keeps its own `overflow-x: auto` (a nested scroll container an ancestor's
 * `overflow-x: hidden` does not reach into), so a wide fenced code block still scrolls in
 * place — the one thing this bug's acceptance criteria allows to scroll.
 *
 * Uses the styles.css-as-text pattern from `bottom-inset.test.ts` — no CSSOM, no layout, since
 * the fake DOM (testdom.ts) has neither a stylesheet nor `scrollWidth`/`getBoundingClientRect`.
 */
const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

type Rule = { selector: string; body: string };

function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let head = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = head.trim();
      head = "";
      let depth = 1;
      let j = i + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      const body = src.slice(i + 1, j - 1);
      if (!prelude.startsWith("@")) out.push({ selector: prelude, body: body.replace(/\{[\s\S]*?\}/g, "") });
      out.push(...rules(body).map((r) => ({ ...r })));
      i = j - 1;
    } else if (c === "}") {
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

describe("the card detail body never scrolls sideways (card 30)", () => {
  const all = rules(CSS);

  it(".card-body clips its own horizontal overflow", () => {
    const r = all.find((x) => x.selector === ".card-body");
    expect(r).toBeDefined();
    expect(declares(r!.body, "overflow-x", /hidden/)).toBe(true);
  });

  it(".md pre keeps its own horizontal scroller, unaffected by the body's clip", () => {
    const r = all.find((x) => x.selector === ".md pre");
    expect(r).toBeDefined();
    expect(declares(r!.body, "overflow-x", /auto/)).toBe(true);
  });

  it("an unbreakable run in a card body, comment, or detail value has somewhere to wrap", () => {
    for (const selector of [".md", ".msg-body", ".detail-value", ".card-heading"]) {
      const r = all.find((x) => x.selector === selector);
      expect(r).toBeDefined();
      expect(declares(r!.body, "overflow-wrap", /anywhere/)).toBe(true);
    }
  });

  it(".msg-main (a flex item beside the avatar) does not floor its row at its content width", () => {
    const r = all.find((x) => x.selector === ".msg-main");
    expect(r).toBeDefined();
    expect(declares(r!.body, "min-width", /0/)).toBe(true);
  });
});

/**
 * Follow-up (the human's repro on card 30): a blocked, unassigned card's primary-actions row
 * reads "Claim anyway" (longer than plain "Claim") plus "Hold" plus "Mark done", and those
 * three `white-space: nowrap` buttons did not fit one 390px row. `.card-body`'s `overflow-x:
 * hidden` backstop above stopped that from becoming a scrollbar, but it also clipped "Mark
 * done" clean off — a button a person could no longer see or tap, worse than the scroll it
 * replaced. The fix lets the row wrap instead: `flex-wrap: wrap` on `.primary-actions`, and
 * `flex: 1 1 auto` (not the bare `flex: 1` — shorthand for `1 1 0%` — the row had) on each
 * `.btn`, so a button's hypothetical size going into the wrap decision is its real label width
 * rather than a zero basis that always looks like it fits. Confirmed live: three buttons wrap
 * to "Claim anyway" + "Hold" on one row and "Mark done" alone on the next, all fully visible,
 * zero horizontal overflow, at 390px in both Chromium and WebKit; a held card's "Release hold"
 * + "Mark done" still share one row.
 */
describe("the card's primary-actions row wraps instead of overflowing (card 30 follow-up)", () => {
  const all = rules(CSS);

  it(".primary-actions wraps its buttons onto a new line rather than overflowing", () => {
    const r = all.find((x) => x.selector === ".primary-actions");
    expect(r).toBeDefined();
    expect(declares(r!.body, "flex-wrap", /wrap/)).toBe(true);
  });

  it("a primary-actions button's wrap-line size is its own label, not a zero flex-basis", () => {
    const r = all.find((x) => x.selector === ".primary-actions .btn");
    expect(r).toBeDefined();
    expect(declares(r!.body, "flex", /^\s*1\s+1\s+auto\s*$/)).toBe(true);
  });
});

/**
 * The renderer side of the same bug class: a fenced code block always becomes a `<pre><code>`
 * pair, which is the only element `.md pre`'s `overflow-x: auto` targets. If a future change to
 * `splitDocumentBlocks` ever let a fenced block's content leak into a plain paragraph instead,
 * that content would lose its scroll container and fall back on the page-wide clip — no longer
 * scrollable at all, just truncated. Pinning the block shape here catches that before it ships.
 */
describe("a fenced code block always renders as its own block, never inlined into a paragraph", () => {
  it("a 150-char unbroken line inside a fence stays a `code` block", () => {
    const longLine = "x".repeat(150);
    const blocks = splitDocumentBlocks(`before\n\n\`\`\`js\n${longLine}\n\`\`\`\n\nafter`);
    expect(blocks).toEqual([
      { t: "para", lines: ["before"] },
      { t: "code", value: longLine },
      { t: "para", lines: ["after"] },
    ]);
  });
});
