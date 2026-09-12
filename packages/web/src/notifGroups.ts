/**
 * Pure helpers for grouping push notifications by board. `NotificationPayload.tag` (see
 * `packages/core/src/notify.ts`) is always the route it points at — `"#/b/<slug>/channel"` or
 * `"#/b/<slug>/c/<n>"` — so "same board" is a prefix match on that route, not an exact tag match.
 *
 * `packages/web/public/sw.js` needs the identical one-line regex but can't import this module: it
 * is plain JS copied verbatim into the built app with no bundler pass, so it carries its own
 * hand-synced copy (`boardPrefixOf` there, commented as such). This module is the one `bun test`
 * actually covers.
 */

/** The board segment of a route tag, including its trailing slash, or null when `tag` isn't a
 *  board route (e.g. absent, or some other shape entirely). */
export function boardPrefixOf(tag: string | null | undefined): string | null {
  if (typeof tag !== "string") return null;
  const m = tag.match(/^#\/b\/[^/]+\//);
  return m ? m[0] : null;
}

/**
 * Which of `openTags` should be closed to clear one board's notifications: every tag that shares
 * `boardSlug`'s prefix, or every tag at all when `boardSlug` is null (Home has no single board to
 * scope to), bounded to `limit`. Pure — the actual `Notification.close()` calls are the caller's
 * job (`closeBoardNotifications` in `push.ts`).
 */
export function notificationsToClose(openTags: readonly string[], boardSlug: string | null, limit: number): string[] {
  const bound = Math.max(0, limit);
  if (!boardSlug) return openTags.slice(0, bound);
  const prefix = `#/b/${boardSlug}/`;
  return openTags.filter((t) => t.startsWith(prefix)).slice(0, bound);
}
