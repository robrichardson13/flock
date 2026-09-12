import type { NotifyLevel, NotifySettings, PresenceClientInfo } from "@flock/core";

/**
 * One-line, greppable logging for presence and for the push suppression decision (card 54).
 *
 * Every function here is pure and the format is `key=value`, space separated, so `flock logs |
 * grep '\[presence\]'` reads on a phone-sized terminal. Nothing is logged that the server does
 * not already hold: actor names, board slugs and the user agent that is already stored on a push
 * subscription. The user agent is reduced to a short device label before it reaches the log.
 */

/** Longest user agent we will ever accept or store, before shortening. */
export const MAX_USER_AGENT = 256;

/** Longest dismissal label (a reason, a worker state, an ack) we will accept. */
export const MAX_DISMISS_LABEL = 64;
/** Longest dismissal error string we will accept. */
export const MAX_DISMISS_ERR = 120;

/** A short device label from a user agent, for the log. Never the raw string. */
export function shortUserAgent(ua: string | undefined | null): string {
  if (!ua) return "?";
  let platform = "other";
  if (/iPhone/i.test(ua)) platform = "iPhone";
  else if (/iPad/i.test(ua)) platform = "iPad";
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = "Mac";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Linux/i.test(ua)) platform = "Linux";

  let browser: string | null = null;
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  const os = /iPhone OS ([0-9_]+)/i.exec(ua)?.[1]?.replace(/_/g, ".");
  const label = [platform, os, browser].filter(Boolean).join("/");
  return label.slice(0, 40);
}

/** `1.5s`, `340ms`, `-` for a missing duration. Keeps a log line scannable. */
export function shortDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Quote a value only when it needs it, so the common case stays terse. */
function val(v: string): string {
  return /[\s"]/.test(v) ? JSON.stringify(v) : v;
}

function flag(v: boolean | undefined): string {
  return v === undefined ? "-" : String(v);
}

export interface PresenceLogLine {
  at: number;
  client: string;
  actor: string;
  actorKind: string;
  /** The board slug the client claims to be on, or null on Home. */
  board: string | null;
  /** Whether that slug resolved to a real board. */
  resolved: boolean;
  looking: boolean;
  info?: PresenceClientInfo;
}

/**
 * One line per `POST /api/presence`. The `visible/focused/input/fg` group is the client's own
 * `clientIsLooking` inputs, so the log says why the client decided what it decided rather than
 * only what it decided.
 */
export function formatPresenceReport(l: PresenceLogLine): string {
  const i = l.info ?? {};
  const parts = [
    `[presence]`,
    new Date(l.at).toISOString(),
    `actor=${val(l.actor)}`,
    `kind=${l.actorKind}`,
    `board=${l.board === null ? "-" : val(l.board)}${l.board !== null && !l.resolved ? "(unknown)" : ""}`,
    `looking=${l.looking}`,
    `mode=${i.mode ?? "-"}`,
    `build=${val(i.build ?? "-")}`,
    `visible=${flag(i.visible)}`,
    `focused=${flag(i.focused)}`,
    `input=${shortDuration(i.lastInputAgeMs)}`,
    `fg=${flag(i.foregroundOnly)}`,
    `ua=${val(shortUserAgent(i.userAgent))}`,
    `client=${val(l.client.slice(0, 8))}`,
    ...dismissParts(i),
  ];
  return parts.join(" ");
}

/**
 * The notification-dismissal read-out (card 70), appended to the presence line only once the
 * client has swept at least once. `sweep=-` on a client that has never swept is the whole point:
 * it says the resume produced no sweep, which no other line in the log can say.
 *
 * `seen`/`closed` are the page's numbers, `wseen`/`wclosed` the worker's own; the pair being
 * `0`/`-1` while the tray plainly holds a notification is the WebKit enumeration failure.
 */
export function dismissParts(i: PresenceClientInfo): string[] {
  if (i.sweepCount === undefined && i.sweepAgeMs === undefined) return ["sweep=-"];
  const n = (v: number | undefined): string => (v === undefined ? "-" : String(v));
  return [
    `sweep=${shortDuration(i.sweepAgeMs)}/${val(i.sweepReason ?? "-")}#${n(i.sweepCount)}`,
    `sw=${val(i.swState ?? "-")}`,
    `seen=${n(i.notifsSeen)}`,
    `closed=${n(i.notifsClosed)}`,
    `ack=${val(i.workerAck ?? "-")}`,
    `wseen=${n(i.workerSeen)}`,
    `wclosed=${n(i.workerClosed)}`,
    `act=${n(i.activateSeen)}/${n(i.activateClosed)}`,
    ...(i.dismissErr ? [`derr=${val(i.dismissErr)}`] : []),
  ];
}

export interface PushDecisionLine {
  seq: number;
  type: string;
  /** `urgent` bypasses presence entirely (ADR 0021), `chatter` is what presence suppresses,
   *  `none` notifies nobody. Without it a by-design ask looks like a suppression failure. */
  notificationClass: "urgent" | "chatter" | "none";
  actor: string;
  /** Board slug, for a human; the id is the key presence is actually stored under. */
  board: string;
  boardId: string;
  looking: boolean;
  /** Age of the freshest presence report for (actor, board), or null when there is none. */
  presenceAgeMs: number | null;
  /** How many live presence clients match (actor, board). */
  presenceClients: number;
  /** Which rule matched: the client is on this board, or on Home (card 54). */
  via: "board" | "home" | null;
  /** Push subscriptions this actor has for this board. */
  subscriptions: number;
  /** ADR 0024: the event's resolved level, or null when nothing would notify anyone (no payload). */
  level: NotifyLevel | null;
  /** Whether this recipient's settings let this level through. True whenever `level` is null,
   *  since there is nothing for a level filter to block in that case. */
  deliver: boolean;
  /** The settings `deliver` was computed from, or null when `level` is null (no filter ran). */
  settings: NotifySettings | null;
}

/**
 * One line per (event, recipient) at push decision time: what the pump believed about presence
 * (card 54) and what ADR 0024's level filter decided, folded into a single line. `looking=true`
 * means chatter is suppressed; an urgent notification still goes out by design (ADR 0021).
 * `deliver=false` means the level filter is why this recipient hears nothing, independent of
 * presence.
 */
export function formatPushDecision(d: PushDecisionLine): string {
  return [
    `[push] decision`,
    `event=${d.seq}`,
    `type=${val(d.type)}`,
    `class=${d.notificationClass}`,
    `actor=${val(d.actor)}`,
    `board=${val(d.board)}`,
    `boardId=${val(d.boardId)}`,
    `looking=${d.looking}${d.via === null ? "" : `(${d.via})`}`,
    `age=${shortDuration(d.presenceAgeMs)}`,
    `clients=${d.presenceClients}`,
    `level=${val(d.level ?? "-")}`,
    `deliver=${d.deliver}`,
    `settings=${d.settings ? JSON.stringify(d.settings) : "-"}`,
    `subs=${d.subscriptions}`,
  ].join(" ");
}

/**
 * Is this request from the machine the server runs on? Fails closed: an unknown peer address is
 * not loopback. Note the caveat for a dev setup — a request proxied by vite arrives from
 * 127.0.0.1 — which is why a forwarding header is rejected outright.
 */
export function isLoopbackRequest(address: string | undefined | null, forwardedFor?: string | null): boolean {
  if (forwardedFor) return false;
  if (!address) return false;
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (a === "127.0.0.1" || a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  if (a.startsWith("::ffff:")) return a.slice(7) === "127.0.0.1";
  return false;
}

/** Clamp and normalize the diagnostic block a client sends, so nothing unbounded is stored. */
export function normalizeClientInfo(raw: unknown, userAgent: string | undefined): PresenceClientInfo | undefined {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const info: PresenceClientInfo = {};
  if (typeof o.build === "string" && o.build.length > 0) info.build = o.build.slice(0, 64);
  if (o.mode === "standalone" || o.mode === "browser") info.mode = o.mode;
  if (typeof o.visible === "boolean") info.visible = o.visible;
  if (typeof o.focused === "boolean") info.focused = o.focused;
  if (typeof o.lastInputAgeMs === "number" && Number.isFinite(o.lastInputAgeMs)) {
    info.lastInputAgeMs = Math.max(0, Math.min(o.lastInputAgeMs, 24 * 60 * 60 * 1000));
  }
  if (typeof o.foregroundOnly === "boolean") info.foregroundOnly = o.foregroundOnly;
  if (userAgent) info.userAgent = userAgent.slice(0, MAX_USER_AGENT);

  // The dismissal read-out (card 70). Every field is optional, clamped, and never read by any
  // decision — a hostile client can make the log wrong about its own phone and nothing else.
  const int = (v: unknown, max: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(Math.round(v), max)) : undefined;
  const short = (v: unknown, max: number): string | undefined =>
    typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
  info.sweepAgeMs = int(o.sweepAgeMs, 24 * 60 * 60 * 1000);
  info.sweepReason = short(o.sweepReason, MAX_DISMISS_LABEL);
  info.sweepCount = int(o.sweepCount, 1_000_000);
  info.swState = short(o.swState, MAX_DISMISS_LABEL);
  info.notifsSeen = int(o.notifsSeen, 10_000);
  info.notifsClosed = int(o.notifsClosed, 10_000);
  info.workerAck = short(o.workerAck, MAX_DISMISS_LABEL);
  info.workerSeen = int(o.workerSeen, 10_000);
  info.workerClosed = int(o.workerClosed, 10_000);
  info.activateSeen = int(o.activateSeen, 10_000);
  info.activateClosed = int(o.activateClosed, 10_000);
  info.dismissErr = short(o.dismissErr, MAX_DISMISS_ERR);
  for (const k of Object.keys(info) as (keyof PresenceClientInfo)[]) {
    if (info[k] === undefined) delete info[k];
  }

  return Object.keys(info).length > 0 ? info : undefined;
}
