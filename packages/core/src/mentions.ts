/**
 * `@name` and `@all` in a channel message or card comment (ADR 0029 §3). Pure, so the web
 * renders the same grammar the inbox routes on.
 */

/** Addresses every actor on the board. */
export const MENTION_ALL = "all";

/**
 * An `@` not preceded by a word character, `@` or `.` (so `rob@example.com` is not a mention),
 * then a name that starts and ends with a letter or digit. A trailing `.` or `-` is punctuation:
 * `thanks @scout.` mentions `scout`.
 */
export const MENTION_RE = /(?<![\w@.])@([A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)/gu;

/** Every distinct name mentioned in a body, lowercased, in first-seen order. */
export function parseMentions(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) names.add(m[1]!.toLowerCase());
  return [...names];
}

/** True when a body addresses `name`, directly or through `@all`. */
export function mentionsActor(body: string, name: string): boolean {
  const names = parseMentions(body);
  return names.includes(MENTION_ALL) || names.includes(name.toLowerCase());
}

/** `say --to a,b "hi"` is `@a @b hi`; a recipient the body already mentions is not repeated. */
export function addressTo(body: string, recipients: string[]): string {
  const already = parseMentions(body);
  const missing = recipients.map((r) => r.replace(/^@/, "")).filter((r) => r && !already.includes(r.toLowerCase()));
  return missing.length ? `${missing.map((r) => `@${r}`).join(" ")} ${body}` : body;
}
