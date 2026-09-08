import type { CSSProperties } from "react";
import type { BoardState, BoardSummary, CardStatus, NeedsHuman, TeamMember } from "./api.ts";
import { timeAgo } from "./App.tsx";
import { eventSummary } from "./EventLine.tsx";
import { enterClass } from "./live.ts";
import { isActive } from "./people.ts";
import { Avatar, Icons, useIsMobile } from "./ui.tsx";

/** The word under the bar on the phone row. `.board-state-word` hides it; kept so the phone
 *  DOM is unchanged and the word is there the moment a layout wants it. */
export const STATE_WORD: Record<BoardState, string> = {
  awaiting: "needs you",
  working: "working",
  idle: "idle",
  complete: "done",
  archived: "archived",
};

/**
 * The short identity of a board: the last two segments of its project directory, so two
 * worktrees of one repo read as `flock/overall-ui` and `flock/hosting` rather than as the
 * same ellipsised home path. Boards with no project fall back to their slug.
 */
export function wherePath(project: string | null, slug: string): string {
  if (!project) return slug;
  const segs = project.split("/").filter(Boolean);
  if (segs.length === 0) return slug;
  return segs.slice(-2).join("/");
}

/**
 * How far along the board is, in one 4px bar: closed, doing and awaiting segments over a
 * track, with the closed-over-total count beside it. A board with no cards says so instead
 * of drawing an empty bar that would read as "nothing done yet".
 */
export function ProgressBar({ counts, total, word, count = true }: { counts: Record<CardStatus, number>; total: number; word?: string; count?: boolean }) {
  // `word` rides inside `.board-progress` rather than beside it, so a layout that wants the
  // state in words gets the pair in one cell. Only PhoneRow passes it, and CSS hides it: the
  // desktop row says the state in its status pill instead.
  const stateWord = word ? <span className="board-state-word">{word}</span> : null;
  if (total === 0) return <div className="board-progress"><span className="board-progress-count">no cards</span>{stateWord}</div>;
  const closed = counts.done + counts.wontfix;
  return (
    <div className="board-progress">
      <Bar counts={counts} total={total} />
      {/* `34/34` beside a full bar says the same thing twice. The phone keeps the drawing;
          desktop, which has a legend to reconcile with, keeps the numerals. */}
      {count && <span className="board-progress-count">{closed}/{total}</span>}
      {stateWord}
    </div>
  );
}

/**
 * The three segments alone, so the index row's 4px bar and the sidebar item's 3px bar are
 * one drawing at two sizes. Markup and aria-label are exactly what ProgressBar always drew.
 */
export function Bar({ counts, total, className }: { counts: Record<CardStatus, number>; total: number; className?: string }) {
  const closed = counts.done + counts.wontfix;
  const doing = counts.doing;
  const awaiting = counts["awaiting-human"];
  const pct = (n: number) => `${(n / total) * 100}%`;
  const label = `${closed} of ${total} closed` +
    (doing ? `, ${doing} doing` : "") +
    (awaiting ? `, ${awaiting} needs you` : "");
  return (
    <div className={className ? `board-bar ${className}` : "board-bar"} role="img" aria-label={label}>
      {closed > 0 && <span className="board-bar-closed" style={{ flexBasis: pct(closed) }} />}
      {doing > 0 && <span className="board-bar-doing" style={{ flexBasis: pct(doing) }} />}
      {awaiting > 0 && <span className="board-bar-awaiting" style={{ flexBasis: pct(awaiting) }} />}
    </div>
  );
}

export function NeedsPill({ n }: { n: number }) {
  return <span className="pill pill-alert">{n} need you</span>;
}

/**
 * Who is on this board *right now*: agents that wrote inside the active window, newest
 * first, three at most. Nothing when nobody is live — the row then keeps its chevron.
 */
export function liveAgents(team: TeamMember[]): TeamMember[] {
  return team
    .filter((m) => m.kind === "agent" && isActive(m.lastSeen))
    .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
}

export function AvatarRow({ team }: { team: TeamMember[] }) {
  const live = liveAgents(team);
  if (live.length === 0) return null;
  const shown = live.slice(0, 3);
  const overflow = live.length - shown.length;
  return (
    <span className="board-avatars" title={live.map((m) => m.name).join(", ")}>
      {shown.map((m, i) => (
        <span key={m.name} className="board-avatar-item" style={{ zIndex: shown.length - i }}>
          <Avatar name={m.name} kind={m.kind} size={22} live />
        </span>
      ))}
      {overflow > 0 && (
        <span className="board-avatar-item board-avatar-more">
          <span className="avatar avatar-overflow" style={{ width: 22, height: 22, fontSize: 10 }}>+{overflow}</span>
        </span>
      )}
    </span>
  );
}

/**
 * One board on the index, on the phone and on the desktop, in the same two ranks the kanban
 * tile wears since #12: the title on its own line, then one quiet caption line under it. The
 * desktop caption carries the bar (active boards only), the counts, the age of the last
 * event, and either the open question or the repo tail — with the last event itself a hover
 * away in the tail's place. Who is here stays in its own fixed column at the right edge, so
 * a row's right edge is as tabular as the old five-column table was.
 */
export function BoardRow({ b, isNew, questions = [], style, idle = false }: { b: BoardSummary; isNew: boolean; questions?: NeedsHuman[]; style?: CSSProperties; idle?: boolean }) {
  const mobile = useIsMobile();
  if (mobile) return <PhoneRow b={b} isNew={isNew} style={style} idle={idle} />;
  const needs = b.counts["awaiting-human"];
  const question = b.state === "awaiting" ? questions[0] : undefined;
  return (
    <a
      data-anchor
      href={`#/b/${b.slug}`}
      className={`list-row board-row board-row-desk state-${b.state}${enterClass(isNew)}`}
      style={style}
      title={b.title}
    >
      <div className="board-cell board-cell-id">
        <div className="board-desk-title">
          <span className="list-title">{b.title}</span>
          {/* The one pill left on Home. Every other state is already said twice — by the
              Active/Idle head and by the caption's own words — but "needs you" is the one
              state you have to act on, and it is the phone's own badge. */}
          {needs > 0 && <NeedsPill n={needs} />}
          {/* Who is here, at the measure's right edge rather than the window's: the phone row
              puts the same faces at the same edge, and a 22px face pinned 1150px away from
              the title it belongs to is not a column, it is an orphan. */}
          <AvatarRow team={b.team} />
        </div>
        <div className="board-desk-meta">
          {/* The switcher's 3px bar, and only on an active board: an idle board's bar was
              either full or empty and said nothing, so it says its fact in words instead.
              That is exactly PhoneRow's rule, so Home reads the same at 390 and at 1920. */}
          {!idle && b.total > 0 && <Bar counts={b.counts} total={b.total} className="board-bar-mini" />}
          <span className="board-desk-fact">{deskFact(b)}</span>
          <span className="board-desk-age">{timeAgo(b.lastActivityAt)}</span>
          {question
            ? <span className="board-desk-q">{`\u201C${question.question ?? question.title}\u201D`}</span>
            : (
              <>
                <span className="board-desk-where" title={b.project ?? undefined}>{wherePath(b.project, b.slug)}</span>
                {/* What happened last, at the caption's own size and in the caption's own
                    colour, revealed on hover or keyboard focus in the `where`'s place. The
                    age beside the fact carries it at rest; the sentence itself was the
                    widest, quietest, most-repeated thing on the page. */}
                {b.lastEvent && <span className="board-desk-last">{eventSummary(b.lastEvent)}</span>}
              </>
            )}
        </div>
      </div>
    </a>
  );
}

/**
 * The words in a desktop row's caption. Same grammar as the phone's `idleMeta` — how much is
 * left, or what got finished — with the live count in front when somebody is on it. The state
 * itself is not spelled out: the Active/Idle head says it, and `3 doing` says it again in the
 * only terms that carry information.
 */
export function deskFact(b: Pick<BoardSummary, "state" | "counts" | "open" | "total">): string {
  if (b.state === "archived") return "Archived";
  if (b.total === 0) return "No cards";
  const closed = b.counts.done + b.counts.wontfix;
  if (b.open === 0) return `${closed} done`;
  return b.counts.doing ? `${b.counts.doing} doing \u00B7 ${b.open} open` : `${b.open} open`;
}

/**
 * The one line of fact under an idle board's title, in place of its bar (#47). An idle board
 * is finished, dormant or empty; its bar was either full (a grey rule under every finished
 * title, brighter than the dimmed title itself) or empty, and said nothing four times down
 * the screen. What a person wants from a dormant row is how much is left and how long it
 * has been quiet: `5 open · 2d`. A finished board says what it finished: `34 done · 3d`.
 * The age is `timeAgo`'s own vocabulary so it matches the Activity tab.
 */
export function idleMeta(b: Pick<BoardSummary, "state" | "counts" | "open" | "total" | "lastActivityAt">, ago: (iso: string) => string): string {
  if (b.state === "archived") return "Archived";
  if (b.total === 0) return "No cards";
  const closed = b.counts.done + b.counts.wontfix;
  const fact = b.open === 0 ? `${closed} done` : `${b.open} open`;
  const age = ago(b.lastActivityAt);
  return age === "just now" ? fact : `${fact} · ${age}`;
}

/**
 * The phone row: the desktop table would be a wall of columns at 390px. Under the title sits
 * one 18px line of metadata — the bar on an active board, a phrase on an idle one — so both
 * groups keep one row pitch and the title is always the brightest thing in the row.
 */
function PhoneRow({ b, isNew, style, idle }: { b: BoardSummary; isNew: boolean; style?: CSSProperties; idle: boolean }) {
  const needs = b.counts["awaiting-human"];
  const side = needs > 0
    ? <NeedsPill n={needs} />
    : liveAgents(b.team).length > 0
      ? <AvatarRow team={b.team} />
      : <span className="chev">{Icons.chevron(18)}</span>;
  return (
    <a
      data-anchor
      href={`#/b/${b.slug}`}
      className={`list-row board-row state-${b.state}${enterClass(isNew)}`}
      style={style}
      title={b.title}
    >
      <div className="list-main">
        <div className="list-title">{b.title}</div>
        {/* Title and progress, and nothing else. The directory line went first — the title
            usually said the same thing, and the path is in the board sheet — and #38 took the
            last-event line with it: "conductor posted message" under every row was the same
            sentence six times down the screen, and what is actually live is already said by
            the bar, the Active/Idle grouping and the avatars on the right. The event itself
            is one tap away in Activity, and the desktop row still carries it in its own
            column, where there is width for it to mean something. */}
        {idle
          ? <div className="board-meta">{idleMeta(b, timeAgo)}</div>
          : <ProgressBar counts={b.counts} total={b.total} word={STATE_WORD[b.state]} count={false} />}
      </div>
      <div className="board-row-side">{side}</div>
    </a>
  );
}

/**
 * One board in the sidebar: state dot · title · need-you count, over a mini bar and the repo
 * tail. Same server order as the index, so the map does not reshuffle when you click in. The
 * dot slot is always there so titles align whether or not the dot is coloured.
 */
export function BoardNavItem({ b, needs, active }: { b: BoardSummary; needs: number; active: boolean }) {
  return (
    <a href={`#/b/${b.slug}`} className={`board-link board-link-rich state-${b.state}${active ? " active" : ""}`} title={b.title}>
      <span className="board-link-top">
        <span className={`board-dot board-dot--${b.state}`} />
        <span className="board-link-title">{b.title}</span>
        {needs > 0 && <span className="pill pill-alert">{needs}</span>}
      </span>
      <span className="board-link-sub">
        {/* #22/C6/F8: the same rule Home's row uses (card #15) — an idle board's bar is
            either full or empty and says nothing a fill-less 48px dash didn't already say
            worse, so only the active board draws one. This item never rendered avatars, so
            that half of the fix was already true. */}
        {active && b.total > 0 && <Bar counts={b.counts} total={b.total} className="board-bar-mini" />}
        <span className="board-link-where" title={b.project ?? undefined}>{wherePath(b.project, b.slug)}</span>
      </span>
    </a>
  );
}
