import type { CSSProperties } from "react";
import type { CardStatus } from "@flock/core/types";
import type { Event } from "./api.ts";
import { timeAgo } from "./App.tsx";
import { enterClass } from "./live.ts";
import { Avatar, STATUS_LABEL } from "./ui.tsx";

function imageWord(n: number): string {
  return `sent ${n} image${n === 1 ? "" : "s"}`;
}

/**
 * Past-tense, active-voice phrasing for every event type (#2 design review, gaps #4/#5): the
 * actor is always the subject, so a row reads as something someone did rather than a log
 * line. `verb` is what rank 1 says right after the actor's name; `cardSuffix` is the extra
 * prose that belongs after the `#N` link — a destination status, a won't-fix note, the other
 * card in a block — and already carries its own leading space so it concatenates cleanly.
 * `payload` is rank 2's content, or "" when the row says everything it has in rank 1 (a
 * claim, a release, an unblock).
 *
 * `cardTitle` comes from a `Map<number, string>` built off the snapshot's cards; when the
 * caller has no entry for this event's card (or passes nothing), the payload falls back to
 * "" except for `card.created`, whose own event data always carries the title it minted.
 */
export function eventPhrase(e: Event, cardTitle?: string): { verb: string; showCard: boolean; cardSuffix: string; payload: string } {
  const d = e.data as Record<string, any>;
  const title = cardTitle ?? (e.type === "card.created" ? String(d.title ?? "") : "");
  switch (e.type) {
    case "board.created":
      return { verb: "created the board", showCard: false, cardSuffix: "", payload: "" };
    case "board.updated":
      return { verb: "edited the brief", showCard: false, cardSuffix: "", payload: "" };
    case "card.created":
      return { verb: "opened", showCard: true, cardSuffix: "", payload: title };
    case "card.updated":
      return { verb: "edited", showCard: true, cardSuffix: "", payload: title };
    case "card.claimed":
      return { verb: "claimed", showCard: true, cardSuffix: "", payload: title };
    case "card.released":
      return { verb: "released", showCard: true, cardSuffix: "", payload: title };
    case "card.moved":
      return { verb: "moved", showCard: true, cardSuffix: `to ${STATUS_LABEL[d.to as CardStatus] ?? d.to}`, payload: title };
    case "card.closed":
      return d.to === "wontfix"
        ? { verb: "closed", showCard: true, cardSuffix: "as won't fix", payload: title }
        : { verb: "finished", showCard: true, cardSuffix: "", payload: title };
    case "card.blocked":
      return { verb: "blocked", showCard: true, cardSuffix: `on #${d.by}`, payload: title };
    case "card.unblocked":
      return { verb: "unblocked", showCard: true, cardSuffix: "", payload: title };
    case "card.asked":
      return { verb: "asked about", showCard: true, cardSuffix: "", payload: String(d.question ?? "") };
    case "card.answered":
      return { verb: "answered on", showCard: true, cardSuffix: "", payload: String(d.answer ?? "") };
    case "comment.posted":
      return {
        verb: "commented on",
        showCard: true,
        cardSuffix: "",
        payload: String(d.body ?? "").split("\n")[0] || (d.attachments ? imageWord(d.attachments) : ""),
      };
    case "message.posted":
      return { verb: "posted to the channel", showCard: false, cardSuffix: "", payload: d.body || (d.attachments ? imageWord(d.attachments) : "") };
    case "decision.recorded":
      return { verb: e.cardNum ? "decided on" : "decided", showCard: !!e.cardNum, cardSuffix: "", payload: String(d.gist ?? "") };
    default:
      return { verb: e.type, showCard: !!e.cardNum, cardSuffix: "", payload: "" };
  }
}

/**
 * The same event as one line of plain text, for a caption that has no room for an avatar, a
 * bold actor and a link (Home's hover reveal, BoardRow.tsx). Built from `eventPhrase` so this
 * and the Activity tab never again say different things about the same event (the drift
 * `eventVerb`/`eventDetail` invited, since fixed in #2).
 */
export function eventSummary(e: Event, cardTitle?: string): string {
  const { verb, showCard, cardSuffix, payload } = eventPhrase(e, cardTitle);
  const parts = [e.actor, verb];
  if (showCard && e.cardNum) parts.push(`#${e.cardNum}`);
  if (cardSuffix) parts.push(cardSuffix);
  if (payload) parts.push(payload);
  return parts.join(" ");
}

/**
 * One signed event row, shared by the Activity tab (mobile and desktop, now the same shape)
 * and the boards index's compact strip. Activity used to fork into a footnote-sized one-liner
 * on the phone and a two-rank tile on desktop (#25/C5); #2's design review found the phone
 * shape the odd one out in the whole app — the only pane set at caption rank, the only one
 * with faceless 16px avatars, the only one phrased as a log line — so both breakpoints now
 * render this one row: actor and verb at the app's own sub-title rank, the payload one step
 * down and clamped rather than hidden in a tooltip a phone cannot show.
 */
export function EventLine({ e, boardSlug, cardTitle, mobile, continued, isNew, style }: {
  e: Event;
  boardSlug: string;
  /** This event's card title, looked up by the caller from the snapshot's cards. */
  cardTitle?: string;
  /** Sets the avatar to the initials floor's mobile size (22) vs the desktop pane's (28). */
  mobile: boolean;
  /** True for every row after the first in a run grouped by `groupMessages` (same actor,
   *  same five-minute window): the avatar and name are skipped and the row starts at the
   *  verb, indented to the body column so the run still reads as one actor's turn. */
  continued?: boolean;
  isNew?: boolean;
  /** The arrival's place in the queue, as an animation-delay (see `enterDelay`). */
  style?: CSSProperties;
}) {
  const { verb, showCard, cardSuffix, payload } = eventPhrase(e, cardTitle);
  const size = mobile ? 22 : 28;
  const age = <span className="muted tiny evt-age" title={new Date(e.createdAt).toLocaleString()}>{timeAgo(e.createdAt)}</span>;
  const inner = (
    <>
      {continued ? (
        <span className="evt-avatar-slot" style={{ width: size, height: size }} aria-hidden />
      ) : (
        <Avatar name={e.actor} kind={e.actorKind} size={size} quiet />
      )}
      <span className="evt-body">
        <span className="evt-l1">
          {continued ? (
            <span className="evt-verb">{verb}</span>
          ) : (
            <>
              <span className="evt-actor">{e.actor}</span> <span className="evt-verb">{verb}</span>
            </>
          )}
          {showCard && e.cardNum ? <span className="evt-card">#{e.cardNum}</span> : null}
          {cardSuffix ? <span className="evt-suffix">{cardSuffix}</span> : null}
          {age}
        </span>
        {payload ? <span className="evt-l2">{payload}</span> : null}
      </span>
    </>
  );
  const className = `evt${continued ? " evt--continued" : ""}${enterClass(!!isNew)}`;
  if (e.cardNum) {
    return <a className={className} style={style} href={`#/b/${boardSlug}/c/${e.cardNum}`}>{inner}</a>;
  }
  return <div className={className} style={style}>{inner}</div>;
}

/**
 * The compact form used by the boards index: avatar, actor, verb, card link, time-ago, all on
 * one line. Kept in its original shape deliberately (#2 asked for one `EventLine` row and
 * left this one alone) — it is not a pane row, it has no payload rank to add, and it is not
 * currently rendered anywhere, but it stays available for a future compact context.
 */
export function EventStrip({ e, boardSlug, detail: inlineDetail = false }: {
  e: Event;
  boardSlug: string;
  /** Render the payload inline after the card link instead of hiding it in a tooltip. */
  detail?: boolean;
}) {
  const { verb, showCard, cardSuffix, payload } = eventPhrase(e);
  const showInline = inlineDetail && !!payload;
  return (
    <div className="event-line" title={showInline ? undefined : payload || undefined}>
      <Avatar name={e.actor} kind={e.actorKind} size={16} />
      <span className="event-line-text">
        <b>{e.actor}</b> {verb}
        {showCard && e.cardNum && <a href={`#/b/${boardSlug}/c/${e.cardNum}`}> #{e.cardNum}</a>}
        {cardSuffix && ` ${cardSuffix}`}
        {showInline && <span className="event-line-detail">{payload}</span>}
      </span>
      <span className="muted tiny">{timeAgo(e.createdAt)}</span>
    </div>
  );
}
