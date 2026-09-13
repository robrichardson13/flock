/**
 * Smart references: the forms flock already prints for its own things, recognised in
 * message and card-comment text and turned into links to the app's own hash routes.
 *
 * The point is that nobody has to do anything special. An agent writing "blocked by card
 * 59" or "see d8" or "picked up from m194" is writing the same prose it always wrote; the
 * reader gets a tap target. The forms are exactly the ones the CLI and the handoff use —
 * `card <n>`, `d<n>` for a decision, `m<n>` for a channel message — plus a bare `#<n>`,
 * which inside flock can only mean a card (d8 already bans `#n` for flock cards in GitHub
 * text, so the collision it would otherwise have never arises here).
 *
 * Deliberately *not* recognised: the bare comment ref `<card>.<n>` that `card show` prints.
 * `1.5 seconds`, `v2.1`, and every version number in every paste would linkify, and the
 * card it belongs to is already reachable from `card <n>`.
 *
 * Everything here is pure — no React, no DOM, no board knowledge beyond a slug passed in —
 * so the grammar can be tested directly.
 */
import type { InlineToken, RefKind } from "./inline.ts";

export interface FoundRef {
  /** Index of the first character of the match in the source string. */
  start: number;
  /** Index one past the last character of the match. */
  end: number;
  kind: RefKind;
  num: number;
}

/**
 * How many references one body may linkify. A wall of numbers pasted into the channel
 * should render, not produce ten thousand anchors; past the cap the rest stays plain text.
 */
export const MAX_REFS = 50;

/**
 * One alternation, three forms: `card 59` / `cards 59` / `card #59`, a bare `#59`, and
 * `d8` / `m194`. Numbers are capped at five digits — far past any real board, and it keeps
 * a pasted timestamp or order number (`#1234567`) from reading as a card. Case-sensitive
 * for `d`/`m` on purpose: flock prints them lowercase, and an uppercase `D3` or `M2` in
 * ordinary prose is a library or a chip, not a decision.
 */
const REF_RE = /\b[Cc]ards?\s+#?(\d{1,5})\b|(?<![\w#])#(\d{1,5})\b|(?<![\w#])([dm])(\d{1,5})\b/gu;

const KIND_OF: Record<string, RefKind> = { d: "decision", m: "message" };

/**
 * Every reference in a string, in source order, non-overlapping, capped at `MAX_REFS`.
 *
 * The regex is one alternation scanned once with `lastIndex`, so this is linear in the
 * length of the text; the cap bounds the output regardless of input.
 */
export function findRefs(text: string): FoundRef[] {
  const out: FoundRef[] = [];
  REF_RE.lastIndex = 0;
  for (let m = REF_RE.exec(text); m !== null; m = REF_RE.exec(text)) {
    if (out.length >= MAX_REFS) break;
    const [, worded, hashed, letter, lettered] = m;
    const digits = worded ?? hashed ?? lettered;
    if (digits === undefined) continue;
    const num = Number(digits);
    // A zero-numbered anything does not exist; leaving `#0` and `d0` as plain text costs
    // nothing and keeps a dead link off the page.
    if (num === 0) continue;
    const kind: RefKind = letter ? KIND_OF[letter]! : "card";
    out.push({ start: m.index, end: m.index + m[0].length, kind, num });
  }
  return out;
}

/** Where a reference points, as one of the app's own hash routes. */
export function refHref(boardSlug: string, kind: RefKind, num: number): string {
  const slug = encodeURIComponent(boardSlug);
  if (kind === "card") return `#/b/${slug}/c/${num}`;
  if (kind === "decision") return `#/b/${slug}/decisions`;
  return `#/b/${slug}/channel`;
}

/** Split one text token into text and ref tokens, sharing a budget with its siblings. */
function splitText(v: string, budget: { left: number }): InlineToken[] {
  const refs = findRefs(v);
  if (!refs.length || budget.left <= 0) return [{ t: "text", v }];
  const out: InlineToken[] = [];
  let at = 0;
  for (const r of refs) {
    if (budget.left <= 0) break;
    if (r.start > at) out.push({ t: "text", v: v.slice(at, r.start) });
    out.push({ t: "ref", kind: r.kind, num: r.num, v: v.slice(r.start, r.end) });
    budget.left--;
    at = r.end;
  }
  if (at < v.length) out.push({ t: "text", v: v.slice(at) });
  return out;
}

/**
 * Rewrite a token tree so plain text carries ref tokens where a reference was written.
 *
 * A post-pass over `tokenizeInline`'s output rather than a rule inside it: the inline
 * grammar keeps its exact existing behaviour, and the two rules that matter fall out of the
 * shape — a `code` token is never touched (a ref in backticks is literal), and a `link`'s
 * children are never descended into (no anchor inside an anchor). Emphasis recurses,
 * so **card 59** still links.
 */
export function linkifyRefs(tokens: InlineToken[], budget: { left: number } = { left: MAX_REFS }): InlineToken[] {
  const out: InlineToken[] = [];
  for (const t of tokens) {
    if (t.t === "text") out.push(...splitText(t.v, budget));
    else if (t.t === "strong" || t.t === "em" || t.t === "del") out.push({ t: t.t, kids: linkifyRefs(t.kids, budget) });
    else out.push(t);
  }
  return out;
}
