import type { ActorKind, Event } from "./types.ts";

/** What a browser hands back from PushManager.subscribe(), as we store it. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** null/absent = every board. A board id, never a slug. */
  boardId?: string | null;
  userAgent?: string | null;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  actor: string;
  actorKind: ActorKind;
  boardId: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What one notification says. Serialized to JSON and encrypted as the push payload. */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Hash route into the app, e.g. "#/b/flock/c/12". Always starts with "#/". */
  url: string;
  /**
   * Collapse key: a newer notification with the same tag replaces an older one on the device.
   * **Always exactly equal to `url`.** Safari does not reliably deliver `notification.data` to
   * `notificationclick` (MDN BCD reports `data` unsupported on Safari and iOS Safari), and `tag`
   * is a plain string that always survives — so the tag doubles as the routing carrier. It also
   * happens to give the collapse behaviour we want for free: two messages in one channel, or two
   * events on one card, replace each other instead of stacking.
   */
  tag: string;
  /** The event that produced it. For dedupe and for debugging a delivery. */
  seq: number;
}

/** What the sender knows about the event's board and card that the event row does not carry. */
export interface NotifyContext {
  boardSlug: string;
  boardTitle: string;
  /** Title of the event's `cardNum`, when it has one. */
  cardTitle?: string;
}

export interface NotifyTarget {
  subscription: PushSubscriptionRecord;
  payload: NotificationPayload;
}

/** First non-empty line, collapsed whitespace, truncated with a trailing "…". Exported for tests. */
export function summarize(text: string, max = 140): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + "…";
}

/** The notification this event deserves, or null when it deserves none. */
export function notificationFor(event: Event, ctx: NotifyContext): NotificationPayload | null {
  if (event.type === "message.posted") {
    const body = typeof event.data.body === "string" ? event.data.body : "";
    const attachments = typeof event.data.attachments === "number" ? event.data.attachments : 0;
    const summary = summarize(body);
    const url = `#/b/${ctx.boardSlug}/channel`;
    return {
      title: ctx.boardTitle,
      body: summary.length === 0 && attachments > 0 ? `${event.actor} sent an image` : `${event.actor}: ${summary}`,
      url,
      tag: url,
      seq: event.seq,
    };
  }

  if (event.type === "card.asked") {
    const question = typeof event.data.question === "string" ? event.data.question : "";
    const url = `#/b/${ctx.boardSlug}/c/${event.cardNum}`;
    return {
      title: `#${event.cardNum} needs you`,
      body: `${event.actor}: ${summarize(question)}`,
      url,
      tag: url,
      seq: event.seq,
    };
  }

  if (event.type === "card.moved" && event.data.to === "awaiting-human") {
    const url = `#/b/${ctx.boardSlug}/c/${event.cardNum}`;
    return {
      title: `#${event.cardNum} is waiting on you`,
      body: ctx.cardTitle ?? "",
      url,
      tag: url,
      seq: event.seq,
    };
  }

  return null;
}

/** Every (subscription, payload) pair this event should produce. Empty when nothing applies. */
export function notifyTargets(
  event: Event,
  ctx: NotifyContext,
  subs: readonly PushSubscriptionRecord[],
): NotifyTarget[] {
  const payload = notificationFor(event, ctx);
  if (!payload) return [];
  const targets: NotifyTarget[] = [];
  for (const sub of subs) {
    if (sub.actor === event.actor) continue;
    if (sub.boardId !== null && sub.boardId !== event.boardId) continue;
    targets.push({ subscription: sub, payload });
  }
  return targets;
}
