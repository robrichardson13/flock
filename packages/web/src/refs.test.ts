import { expect, test } from "bun:test";
import { tokenizeInline, type InlineToken } from "./inline.ts";
import { findRefs, linkifyRefs, MAX_REFS, refHref } from "./refs.ts";

const found = (s: string) => findRefs(s).map((r) => `${r.kind}:${r.num}:${s.slice(r.start, r.end)}`);

test("card references, written every way flock prints them", () => {
  expect(found("blocked by card 59")).toEqual(["card:59:card 59"]);
  expect(found("Card 7 is next")).toEqual(["card:7:Card 7"]);
  expect(found("see card #12")).toEqual(["card:12:card #12"]);
  // Only the number the word governs: a trailing "and 4" is prose, not a second reference.
  expect(found("cards 3 and 4")).toEqual(["card:3:cards 3"]);
});

test("a bare #n is a card", () => {
  expect(found("#59")).toEqual(["card:59:#59"]);
  expect(found("fixed in #1")).toEqual(["card:1:#1"]);
  expect(found("(#22)")).toEqual(["card:22:#22"]);
});

test("decisions and messages", () => {
  expect(found("d8 says so")).toEqual(["decision:8:d8"]);
  expect(found("per m194 and d15")).toEqual(["message:194:m194", "decision:15:d15"]);
});

test("false positives stay plain text", () => {
  // A heading never reaches the inline layer, but the digit-hugging forms must not fire.
  expect(found("# Heading")).toEqual([]);
  expect(found("##59")).toEqual([]);
  expect(found("colour #ff0000")).toEqual([]);
  expect(found("order #1234567")).toEqual([]);
  expect(found("#0 and d0")).toEqual([]);
  // Letters only count on a word boundary, and only lowercase.
  expect(found("cmd5 sha1d3 D3 M2")).toEqual([]);
  expect(found("a scorecard 5 rating")).toEqual([]);
  // The comment ref form is deliberately unsupported: too many version numbers look like it.
  expect(found("took 1.5 seconds on v2.1")).toEqual([]);
});

test("findRefs is capped", () => {
  const many = Array.from({ length: MAX_REFS + 20 }, (_, i) => `#${i + 1}`).join(" ");
  expect(findRefs(many)).toHaveLength(MAX_REFS);
});

test("hrefs are the app's own hash routes", () => {
  expect(refHref("flock-2", "card", 59)).toBe("#/b/flock-2/c/59");
  expect(refHref("flock-2", "decision", 8)).toBe("#/b/flock-2/decisions");
  expect(refHref("flock-2", "message", 194)).toBe("#/b/flock-2/channel");
  expect(refHref("a b", "card", 1)).toBe("#/b/a%20b/c/1");
});

const shape = (tokens: InlineToken[]): string =>
  tokens
    .map((t) => {
      if (t.t === "text") return `t(${t.v})`;
      if (t.t === "code") return `code(${t.v})`;
      if (t.t === "ref") return `ref(${t.kind}:${t.num}:${t.v})`;
      if (t.t === "link") return `link(${t.href}:${shape(t.kids)})`;
      return `${t.t}(${shape(t.kids)})`;
    })
    .join("");

const lit = (s: string) => shape(linkifyRefs(tokenizeInline(s)));

test("linkify splits text around refs and leaves the rest alone", () => {
  expect(lit("see card 59 now")).toBe("t(see )ref(card:59:card 59)t( now)");
  expect(lit("**card 59**")).toBe("strong(ref(card:59:card 59))");
  expect(lit("plain prose")).toBe("t(plain prose)");
});

test("never inside a code span", () => {
  expect(lit("run `flock card show 59` first")).toBe("t(run )code(flock card show 59)t( first)");
});

test("never inside an existing link", () => {
  expect(lit("[card 59](https://example.com/x)")).toBe("link(https://example.com/x:t(card 59))");
  expect(lit("https://example.com/pull/59")).toBe("link(https://example.com/pull/59:t(https://example.com/pull/59))");
});

test("the linkify budget is shared across calls", () => {
  const budget = { left: 2 };
  expect(shape(linkifyRefs(tokenizeInline("#1 #2 #3"), budget))).toBe("ref(card:1:#1)t( )ref(card:2:#2)t( #3)");
  expect(shape(linkifyRefs(tokenizeInline("#4"), budget))).toBe("t(#4)");
});
