import { useEffect, useState } from "react";
import type { Card } from "./api.ts";

/** How long the filter waits after the last keystroke before it re-runs (the brief's ~100ms). */
export const SEARCH_DEBOUNCE_MS = 100;

/** The value, `SEARCH_DEBOUNCE_MS` after it last changed. A fresh keystroke restarts the
 *  wait rather than queuing another update, so a burst of typing filters once, not per key. */
export function useDebouncedValue<T>(value: T, delayMs: number = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The cards-tab search filter (card 50): pure, so it can be tested without a DOM and reused
 * identically by the phone's bottom composer and the desktop kanban.
 *
 * Multi-word is AND, not OR — "bug mobile" narrows to cards that mention both, the way a mail
 * client's search bar does, rather than widening to cards that mention either. A bare number
 * or a `#`-prefixed one matches that card's number exactly, on top of (not instead of) the
 * ordinary substring match everywhere else, so `12` still finds a card whose title mentions
 * "12" as text.
 */

/** Splits a query into lowercase, non-empty words. Empty (or all-whitespace) is "no query". */
function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The text a word is checked against: title, body, every label, and the assignee, all
 *  lower-cased once per card field rather than once per haystack per word. */
function haystacks(card: Card): string[] {
  return [card.title, card.body, card.assignee ?? "", ...card.labels].map((h) => h.toLowerCase());
}

/** One word matches the card either as a substring of title/body/label/assignee, or as an
 *  exact match on the card's number (with or without a leading `#`). */
function wordMatches(card: Card, word: string, fields: string[]): boolean {
  const bare = word.startsWith("#") ? word.slice(1) : word;
  if (bare !== "" && bare === String(card.num)) return true;
  return fields.some((h) => h.includes(word));
}

/** Does this card match every word in the query? An empty query matches everything. */
export function matchesQuery(card: Card, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const fields = haystacks(card);
  return words.every((w) => wordMatches(card, w, fields));
}

/** The cards search narrows to. Order is preserved. */
export function filterCards(cards: Card[], query: string): Card[] {
  if (queryWords(query).length === 0) return cards;
  return cards.filter((c) => matchesQuery(c, query));
}

/** The composer's own "N of M" readout. */
export function searchMatchCount(cards: Card[], query: string): { matched: number; total: number } {
  return { matched: filterCards(cards, query).length, total: cards.length };
}
