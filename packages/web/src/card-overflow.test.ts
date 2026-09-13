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
 * Follow-up (the human's repro on card 30), settled for good by card 99: a blocked, unassigned
 * card's primary-actions row read "Claim anyway" plus "Hold" plus "Mark done", and those three
 * `white-space: nowrap` buttons did not fit one 390px row. Card 30 let the row wrap. Card 99
 * removed the third button instead — `cardActions.ts` caps the row at two verbs and sends the
 * rest to the "…" menu — so the row is a grid of exactly as many equal columns as it has
 * buttons, which cannot wrap or clip at any width. The invariant pinned here is that shape: if
 * a later change puts the row back on auto-sized flow, the overflow comes back with it.
 */
describe("the card's primary-actions row is a fixed grid, so it cannot overflow (card 99)", () => {
  const all = rules(CSS);

  it(".primary-actions lays its buttons out as equal columns, not a wrapping flex row", () => {
    const r = all.find((x) => x.selector === ".primary-actions");
    expect(r).toBeDefined();
    expect(declares(r!.body, "display", /grid/)).toBe(true);
    expect(declares(r!.body, "grid-template-columns", /repeat\(var\(--action-count/)).toBe(true);
  });

  it("a primary-actions button may shrink inside its column rather than widening it", () => {
    const r = all.find((x) => x.selector === ".primary-actions .btn");
    expect(r).toBeDefined();
    expect(declares(r!.body, "min-width", /0/)).toBe(true);
  });
});

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
