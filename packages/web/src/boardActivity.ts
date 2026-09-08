/**
 * Active vs idle, for the Home boards list: the same split the board's own state already
 * mostly encodes, plus a recency window for a board that has gone quiet but was touched
 * recently enough to still read as "in play" (card #26).
 *
 * A board is active when it has open work needing attention (`doing` or `awaiting-human`
 * cards — a `working` actor is the same fact seen from the person side, so it needs no
 * separate check here), or when something happened on it inside the last hour. Everything
 * else — typically all-done or dormant — is idle. The hour matches `SEEN_WINDOW_MS` in
 * people.ts, so "idle" here and the idle presence dot agree about what "recent" means.
 */

const ACTIVE_RECENCY_MS = 60 * 60 * 1000;

export function isActiveBoard(
  b: { counts: { doing: number; "awaiting-human": number }; lastEvent: { createdAt: string } | null },
  now = Date.now(),
): boolean {
  if (b.counts.doing > 0 || b.counts["awaiting-human"] > 0) return true;
  // No open work: fall back to the last-event time when the snapshot has one, else there is
  // nothing to call recent and the board is idle.
  if (!b.lastEvent) return false;
  return now - new Date(b.lastEvent.createdAt).getTime() < ACTIVE_RECENCY_MS;
}

/**
 * Splits an already-ordered board list into active and idle groups, keeping each group's
 * relative order exactly as given — the server's own state-then-recency sort already puts
 * needs-you boards first within "active", so a filter is all a group needs.
 */
export function groupBoardsByActivity<T extends { counts: { doing: number; "awaiting-human": number }; lastEvent: { createdAt: string } | null }>(
  boards: T[],
  now = Date.now(),
): { active: T[]; idle: T[] } {
  const active: T[] = [];
  const idle: T[] = [];
  for (const b of boards) (isActiveBoard(b, now) ? active : idle).push(b);
  return { active, idle };
}
