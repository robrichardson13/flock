/**
 * Consecutive-message grouping for the channel: a run of messages from the same actor,
 * posted close together, shares one header instead of repeating avatar + name + time on
 * every line. Pure, so the rule is testable without a DOM.
 */

/** How long a run stays "the same breath". Past this, the next message starts a new group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type Groupable = { author: string; createdAt: string };

/**
 * Split messages (in display order) into runs. A message joins the previous run when it has
 * the same author and was posted within `windowMs` of the message immediately before it —
 * measured message-to-message, not from the head of the run, so a long slow conversation
 * does not get chopped at an arbitrary five-minute boundary while a real pause does.
 *
 * An unparseable or out-of-order timestamp starts a new group rather than silently merging.
 */
export function groupMessages<T extends Groupable>(messages: readonly T[], windowMs: number = GROUP_WINDOW_MS): T[][] {
  const groups: T[][] = [];
  let prevTime = 0;
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    const last = groups[groups.length - 1];
    const joins =
      !!last &&
      last[last.length - 1].author === m.author &&
      Number.isFinite(t) &&
      Number.isFinite(prevTime) &&
      t - prevTime >= 0 &&
      t - prevTime <= windowMs;
    if (joins) last.push(m);
    else groups.push([m]);
    prevTime = t;
  }
  return groups;
}

/** A chunk of a card's thread: either a run of ordinary comments, or one system entry. */
export type ThreadChunk<T> = { system: boolean; items: T[] };

export type Kinded = Groupable & { kind: string };

/**
 * The card thread's shape. Ordinary comments group into bubble runs exactly as channel
 * messages do; a question, an answer or the resolution is never part of a run — it is a
 * thing that happened to the card, so it stands on its own as a system row and never
 * silently swallows the comment before or after it into its group.
 */
export function threadChunks<T extends Kinded>(entries: readonly T[], windowMs: number = GROUP_WINDOW_MS): ThreadChunk<T>[] {
  const chunks: ThreadChunk<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    for (const g of groupMessages(run, windowMs)) chunks.push({ system: false, items: g });
    run = [];
  };
  for (const e of entries) {
    if (e.kind === "comment") run.push(e);
    else {
      flush();
      chunks.push({ system: true, items: [e] });
    }
  }
  flush();
  return chunks;
}

/** One calendar day's worth of events (or anything else timestamped), in display order. */
export type DayGroup<T> = { label: string; items: T[] };

/**
 * `Today`, `Yesterday`, then a short weekday-and-date for anything older — the same three
 * words a calendar app uses, so a multi-day Activity feed reads as "when" without making the
 * reader do date arithmetic on a relative age (#2 design review gap #6). Calendar days, not
 * rolling 24-hour windows: an event at 11:58pm and one two minutes later belong to different
 * days here even though they are four minutes apart.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(d);
}

/**
 * Splits an already-ordered list into runs sharing the same day label, without reordering or
 * re-bucketing anything — a feed that jumps back and forth across a day boundary (it never
 * should, but this does not assume otherwise) gets a repeated label rather than a merged one.
 */
export function splitByDay<T extends { createdAt: string }>(items: readonly T[], now: Date = new Date()): DayGroup<T>[] {
  const days: DayGroup<T>[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt, now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return days;
}
