/**
 * A short, human name for a push subscription, from its user agent. Pure. Never shown next to
 * the raw string — the caller puts the full user agent in a `title` attribute, if anywhere.
 *
 * First match wins, case-insensitive: iPhone / iPad / Mac / Android / Windows / Linux, else
 * "Unknown device". Safari is the platform default on Apple devices and is never appended;
 * Chrome, Edge and Firefox are appended when detected (`Edg/` before the bare "Chrome" check,
 * since Edge's UA also contains "Chrome"). Separator is " · ", the app's existing meta
 * separator. Capped at 40 characters.
 */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;

  let platform: string;
  if (/iPhone/i.test(ua)) platform = "iPhone";
  else if (/iPad/i.test(ua)) platform = "iPad";
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = "Mac";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Linux/i.test(ua)) platform = "Linux";
  else return "Unknown device";

  let browser: string | null = null;
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";

  const label = browser ? `${platform} · ${browser}` : platform;
  return label.slice(0, 40);
}
