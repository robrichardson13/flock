/**
 * Cold-start placeholders (#43).
 *
 * The settled screen comes from a cached snapshot on every refresh of something you have
 * already seen (snapshot.ts), so these are only for the case where there is nothing better
 * to paint: a first ever visit, a board you have never opened, a cleared store. What they
 * must not do is introduce a second shift, so each one is built from the *real* row's
 * elements and inherits the real row's geometry — the Home row's 60px pitch from #47, the
 * card row's 44px tap-target pitch from #48 — with the text replaced by a bar.
 *
 * They are decoration, not content: `aria-hidden`, no landmarks, and the shimmer is a
 * background animation that `prefers-reduced-motion` stops dead (styles.css).
 */
import type { CSSProperties } from "react";
import { Icons, STATUS_LABEL } from "./ui.tsx";
import type { CardStatus } from "@flock/core/types";

/** A bar standing in for a line of text. Widths are fixed per position, so a skeleton does
 *  not reshuffle itself between renders while the fetch is still in flight. */
export function Line({ w, className }: { w: string; className?: string }) {
  return <span className={className ? `sk-line ${className}` : "sk-line"} style={{ "--sk-w": w } as CSSProperties} />;
}

const TITLE_W = ["78%", "56%", "88%", "64%", "72%", "48%"];

/** Home's board rows: title over an 18px metadata slot, the trailing side cell, 60px pitch.
 *  On the phone that is `.list-row.board-row`, the same shape `PhoneRow` renders. On desktop
 *  (#21/C2) the real row also carries `.board-row-desk`, which is what caps a row's measure at
 *  `100ch` (`board-desktop.css:157-165`) — without it a skeleton bar ran ~450px past where the
 *  settled row stops. */
export function HomeSkeleton({ rows = 4, mobile }: { rows?: number; mobile: boolean }) {
  return (
    <section className="sk" aria-hidden>
      <div className="section-head"><Line w="52px" className="sk-head" /></div>
      <div className="list">
        {Array.from({ length: rows }, (_, i) =>
          mobile ? (
            <div className="list-row board-row sk-row" key={i}>
              <div className="list-main">
                <div className="list-title"><Line w={TITLE_W[i % TITLE_W.length]} /></div>
                <div className="board-meta"><Line w="34%" className="sk-meta" /></div>
              </div>
              <div className="board-row-side"><Line w="18px" className="sk-side" /></div>
            </div>
          ) : (
            <div className="list-row board-row board-row-desk sk-row" key={i}>
              <div className="board-cell board-cell-id">
                <div className="board-desk-title"><Line w={TITLE_W[i % TITLE_W.length]} /></div>
                <div className="board-desk-meta"><Line w="30%" className="sk-meta" /></div>
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/** The Cards tab: a couple of headed sections of one-line card rows (44px each). */
export function CardsSkeleton() {
  return (
    <>
      {[3, 4].map((rows, s) => (
        <section className="section sk" key={s} aria-hidden>
          <div className="section-head"><Line w="46px" className="sk-head" /></div>
          <div className="list">
            {Array.from({ length: rows }, (_, i) => (
              <div className="list-row card-row sk-row" key={i}>
                <div className="card-row-line">
                  <div className="list-title"><Line w={TITLE_W[(s * 3 + i) % TITLE_W.length]} /></div>
                </div>
                <Line w="22px" className="sk-side" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** How many tile-shaped bars each column shows while the board is still a skeleton. Fixed per
 *  position for the same reason `TITLE_W` is: a skeleton must not reshuffle itself while the
 *  fetch is in flight. */
const KANBAN_COLUMNS: { status: CardStatus; tiles: number }[] = [
  { status: "todo", tiles: 2 },
  { status: "doing", tiles: 3 },
  { status: "done", tiles: 4 },
];

/** A tile-shaped bar: the title's own line, then the caption line under it, at the real
 *  `.card-tile` padding and gap so a column of these sits at the settled tile's 76px-ish
 *  pitch. */
function CardTileSkeleton({ titleW }: { titleW: string }) {
  return (
    <div className="card-tile sk">
      <div className="card-title"><Line w={titleW} /></div>
      <div className="card-tile-meta"><Line w="88px" className="sk-meta" /></div>
    </div>
  );
}

/**
 * The desktop board's kanban, cold (#21/C2, critique A's F2 and critique B's B3). Built from
 * the real `.kanban` / `.column` / `.column-head` / `.card-tile` classes so the swap to the
 * settled three-column board moves nothing — no column appears, no tile changes width. Column
 * names are static labels (`STATUS_LABEL`), not fetched data, so they are drawn for real from
 * the first frame exactly as the mobile skeleton's tab labels are; only the counts and the
 * cards underneath are bars.
 */
export function KanbanSkeleton() {
  return (
    <div className="kanban sk" aria-hidden>
      {KANBAN_COLUMNS.map(({ status, tiles }) => (
        <div className={`column column-${status}`} key={status}>
          <div className="column-head">
            <span className="column-head-label">{STATUS_LABEL[status]}</span>
            <Line w="14px" className="sk-meta" />
          </div>
          <div className="column-cards">
            {Array.from({ length: tiles }, (_, i) => (
              <CardTileSkeleton key={i} titleW={TITLE_W[i % TITLE_W.length]} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The desktop board's side pane, cold (#21/C2, critique A's F2 and critique B's B3): the real
 * `.pane-block` / `.pane-head` / `.pane` / `.pane-scroll` / `.pane-foot` shapes, so a 535px
 * strip of empty ground does not suddenly become a conversation once the snapshot lands. The
 * head's label and its three switch glyphs are static (`PANE_TAB_LABEL`'s "Channel" and the
 * phone tab bar's own icons), drawn for real; only the messages and the composer are bars.
 */
export function BoardSideSkeleton() {
  return (
    <aside className="board-side sk" aria-hidden>
      <section className="pane-block">
        <div className="pane-head">
          <span className="pane-head-label">Channel</span>
          <span className="pane-head-switch">
            {[Icons.chat, Icons.pulse, Icons.flag].map((icon, i) => (
              <span className={`pane-head-btn icon-btn${i === 0 ? " active" : ""}`} key={i}>{icon(16)}</span>
            ))}
          </span>
        </div>
        <div className="pane">
          <div className="pane-body">
            <div className="pane-scroll chan-scroll">
              {["78%", "50%", "64%"].map((w, i) => (
                <div className="msg-group" key={i}>
                  <span className="avatar sk-avatar" />
                  <div className="msg-main">
                    <div className="msg-head"><Line w="72px" className="sk-meta" /></div>
                    <div className="bubble"><Line w={w} className="sk-body" /></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pane-foot">
            <div className="line-composer">
              <span className="icon-btn sk-btn" />
              <span className="input textarea line-composer-input sk-input" />
              <span className="icon-btn icon-btn-primary sk-send" />
            </div>
          </div>
        </div>
      </section>
    </aside>
  );
}

/**
 * The Activity pane, cold (#2 design review gap #8): events arrive from their own fetch after
 * the snapshot resolves, so without this the pane flashed its empty state on every open. Six
 * rows of the real row's own avatar-plus-two-lines shape, at the real `.evt` gap, so the swap
 * to settled content does not reflow the pane.
 */
export function ActivitySkeleton({ mobile }: { mobile: boolean }) {
  const size = mobile ? 22 : 28;
  return (
    <div className="sk-activity sk" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div className="evt sk-row" key={i}>
          <span className="avatar sk-avatar" style={{ width: size, height: size }} />
          <div className="evt-body">
            <Line w="55%" className="sk-meta" />
            <Line w="80%" className="sk-body" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A card page with no board snapshot behind it: the number, the title, two lines of body,
 *  the Details list, a couple of comment-feed rows and the compose chin, at the sizes and
 *  positions the real page (CardPage.tsx) uses — mobile's stacked body or the desktop
 *  drawer's actions bar — so opening a card link cold, or returning to one before the
 *  snapshot lands, never reflows the header or the composer once the card arrives. The
 *  caller supplies the surrounding chrome (topbar, page/drawer wrapper): this is everything
 *  inside it. */
export function CardPageSkeleton({ mobile }: { mobile: boolean }) {
  const body = (
    <>
      <div className="card-heading-num"><Line w="28px" className="sk-meta" /></div>
      <h1 className="card-heading"><Line w="86%" /></h1>
      <h1 className="card-heading sk-heading-2"><Line w="52%" /></h1>
      <div className="sk-para">
        <Line w="94%" className="sk-body" />
        <Line w="88%" className="sk-body" />
        <Line w="61%" className="sk-body" />
      </div>
      <div className="card-details">
        {/* buildDetailRows (details.ts) always renders these four base rows (status,
            assignee, labels, blocked-by); "Blocks" is the only conditional one, and it is
            rare enough (only cards something else blocks on) not to mock. Three rows here
            used to undercount every card by one row's height, moving everything below the
            details list — actions, comments — up relative to where it lands once real data
            arrives. */}
        {["Status", "Assignee", "Labels", "Blocked by"].map((k) => (
          <div className="detail-row sk-detail" key={k}>
            <Line w="64px" className="sk-body" />
            <Line w="96px" className="sk-body" />
          </div>
        ))}
      </div>
    </>
  );
  // The "Created by X, updated Y" byline: real height and position (CardPage.tsx's
  // `createdLine`), last on mobile and between the comment feed and the actions bar on
  // desktop — otherwise the composer below it lands where the byline's line-box and the
  // surrounding gap would have pushed it, and the swap to real content shifts the whole
  // compose chin down.
  const createdLine = (
    <div className="muted small">
      <Line w="55%" className="sk-meta" />
    </div>
  );
  // Card 99: two buttons is the row's maximum and its commonest width (Claim/Release beside
  // Hold), and `--action-count` is what sizes the grid's columns — without it the placeholder
  // would draw one full-width column and shift when the real pair arrives.
  const actions = (
    <div className="primary-actions" style={{ "--action-count": 2 } as CSSProperties}>
      <span className="btn sk-btn" />
      <span className="btn sk-btn" />
    </div>
  );
  const comments = (
    <div className="comments">
      {["78%", "50%"].map((w, i) => (
        <div className="msg-group" key={i}>
          <span className="avatar sk-avatar" />
          <div className="msg-main">
            <div className="msg-head"><Line w="72px" className="sk-meta" /></div>
            <div className="bubble"><Line w={w} className="sk-body" /></div>
          </div>
        </div>
      ))}
    </div>
  );
  const composer = (
    <>
      <div className="mode-row">
        <span className="mode sk-mode" />
        <span className="mode sk-mode" />
        <span className="mode sk-mode" />
      </div>
      <div className="line-composer">
        <span className="input textarea line-composer-input sk-input" />
        <span className="icon-btn icon-btn-primary sk-send" />
      </div>
    </>
  );
  // Every top-level piece here has to carry its *real* class (screen-body/card-body,
  // card-actions-bar, pane-foot/card-composer) directly, as a sibling of the others, not
  // nested one level deeper inside a shared `.sk` wrapper: the real page relies on
  // screen-body's `flex: 1` to fill the space between the fixed topbar and the fixed
  // actions-bar/composer, pinning the composer to the shell's bottom edge regardless of
  // content length. A wrapping div around all of it has no flex-grow of its own, so it
  // sizes to its content instead and the composer floats wherever that content ends —
  // which is what produced the compose-chin shift this replaces (#6). `sk`/`aria-hidden`
  // move onto each piece individually so every one of them still shimmer-quiets and hides
  // from assistive tech the same as before.
  return (
    <>
      {mobile ? (
        <div className="screen-body card-body sk" aria-hidden>
          {body}
          {actions}
          {comments}
          {createdLine}
        </div>
      ) : (
        <>
          <div className="screen-body card-body sk" aria-hidden>
            {body}
            {comments}
            {createdLine}
          </div>
          <div className="card-actions-bar sk" aria-hidden>{actions}</div>
        </>
      )}
      <div className="pane-foot card-composer sk" aria-hidden>{composer}</div>
    </>
  );
}
