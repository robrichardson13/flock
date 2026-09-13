/**
 * The React half of inline rendering: `inline.ts`'s tokens as nodes, plus the smart-reference
 * pass from `refs.ts`.
 *
 * Split out of `markdown.tsx` so the block renderers there stay the file's whole subject, and
 * so the one place that turns a ref token into an anchor sits next to the one place that
 * decides whether refs are linkified at all.
 */
import { type ReactNode } from "react";
import type { InlineToken } from "./inline.ts";
import { tokenizeInline } from "./inline.ts";
import { linkifyRefs, MAX_REFS, refHref } from "./refs.ts";
import { useBoardRef } from "./ui.tsx";

/**
 * Which board a reference resolves against, and how many more this render may make.
 *
 * Null outside a board — the Home needs-you list shows cards from every board, so a `card 12`
 * there has no unambiguous target and stays plain text rather than linking to the wrong one.
 */
export interface RefScope {
  slug: string;
  /** Shared by every `inline()` call of one render, so the cap is per body, not per line. */
  budget: { left: number };
}

/** The ref scope for the board in view, with a fresh budget for this render. */
export function useRefScope(): RefScope | null {
  const slug = useBoardRef();
  return slug ? { slug, budget: { left: MAX_REFS } } : null;
}

function renderTokens(tokens: InlineToken[], scope: RefScope | null): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.t) {
      case "text":
        return t.v;
      case "code":
        return <code key={i}>{t.v}</code>;
      case "ref":
        // An in-app hash route, so no `target`/`rel`: this navigates the board the reader is
        // already on rather than opening a second copy of the app in a new tab.
        return <a key={i} className="ref-link" href={refHref(scope!.slug, t.kind, t.num)}>{t.v}</a>;
      case "strong":
        return <strong key={i}>{renderTokens(t.kids, scope)}</strong>;
      case "em":
        return <em key={i}>{renderTokens(t.kids, scope)}</em>;
      case "del":
        return <del key={i}>{renderTokens(t.kids, scope)}</del>;
      case "link":
        return (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer">
            {renderTokens(t.kids, scope)}
          </a>
        );
    }
  });
}

/**
 * The inline subset — bold, italic, strikethrough, code, links — as React nodes, with
 * flock references linked when a board is in scope.
 */
export function inline(s: string, scope: RefScope | null = null): ReactNode {
  const tokens = tokenizeInline(s);
  return renderTokens(scope ? linkifyRefs(tokens, scope.budget) : tokens, scope);
}
