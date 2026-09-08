/** The bit of a card the Done column needs to order itself: when it closed, when it last
 * moved, and its number as a stable tiebreak. Generic so tests do not need a full Card. */
export type ClosedOrderable = { closedAt?: string | null; updatedAt: string; num: number };

/**
 * Sorts cards newest-first for the Done column: by `closedAt` descending, falling back to
 * `updatedAt` for cards with no `closedAt` (shouldn't happen for done/wontfix, but keeps the
 * helper safe for any status), and breaking ties by `num` descending so ordering is stable.
 */
export function closedOrder<T extends ClosedOrderable>(cards: T[]): T[] {
  const at = (c: T) => c.closedAt ?? c.updatedAt;
  return [...cards].sort((a, b) => {
    const byTime = Date.parse(at(b)) - Date.parse(at(a));
    if (byTime !== 0) return byTime;
    return b.num - a.num;
  });
}
