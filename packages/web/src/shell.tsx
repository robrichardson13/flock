import type { ReactNode } from "react";
import type { BoardSummary, NeedsHuman } from "./api.ts";
import { BoardNavItem } from "./BoardRow.tsx";
import { Brand } from "./Mark.tsx";
import type { PushState } from "./push.ts";
import { Avatar, Icons, Menu, useIsMobile } from "./ui.tsx";

/**
 * The desktop shell's one top bar, on Home and on a board alike (P1.3).
 *
 * The board page used to grow a 240px sidebar that was a smaller copy of Home, which made
 * the two routes different shapes and squeezed the kanban. With it gone, one bar carries
 * what the sidebar carried — brand, the boards list, new board, who you are — and each
 * route adds its own primary action beside it. The bar is full-bleed but its contents sit
 * inside the same `--shell-max` box as the page below, so Home and a board share a left
 * edge (F10).
 */
export function AppTopBar({ boards, activeBoard, needs, actor, dbPath, onNewBoard, onRename, onOpenNotifications, pushKind, action, trailing }: {
  /** Present on a board: the switcher that reaches another board without going Home. */
  boards?: BoardSummary[];
  activeBoard?: string;
  needs?: NeedsHuman[];
  actor: string;
  dbPath?: string;
  onNewBoard: () => void;
  onRename: () => void;
  /** Opens the push notifications panel: a quiet bell beside the avatar (#8). */
  onOpenNotifications: () => void;
  /** This device's push state, so the bell can swap to `bellOff` and carry its warn dot when `blocked`. */
  pushKind?: PushState["kind"];
  /** The route's primary action: New board, or New card. */
  action?: ReactNode;
  /** Anything that belongs after it — on a board, the "⋯" menu. */
  trailing?: ReactNode;
}) {
  // The face inside the identity button is a nested tab stop for a control the reader has
  // already reached. It keeps its click and its label; on desktop it stops costing a press
  // on the way down the page (#17 B4).
  const mobile = useIsMobile();
  return (
    <header className="app-topbar">
      <div className="app-topbar-inner">
        <a className="brand-name" href="#/" aria-label="All boards"><Brand size={18} /></a>
        {boards && (
          <Menu
            label="Switch board"
            align="left"
            triggerClass="btn btn-ghost boards-switch"
            menuClass="menu-boards"
            trigger={(
              <span className="boards-switch-label">
                Boards <span className="boards-switch-chev">{Icons.chevron(14)}</span>
              </span>
            )}
          >
            {(close) => (
              <div onClick={close}>
                {/* The sidebar's own list, in the server's order, so the map does not
                    reshuffle between one board and the next. */}
                {boards.map((b) => (
                  <BoardNavItem
                    key={b.id}
                    b={b}
                    needs={(needs ?? []).filter((x) => x.boardId === b.id).length}
                    active={activeBoard === b.slug || activeBoard === b.id}
                  />
                ))}
                {boards.length === 0 && <div className="muted small pad">No boards yet.</div>}
                <div className="menu-divider" />
                <a className="menu-item" role="menuitem" href="#/">{Icons.cards(16)}<span>All boards</span></a>
                <button className="menu-item" role="menuitem" onClick={onNewBoard}>{Icons.plus(16)}<span>New board</span></button>
              </div>
            )}
          </Menu>
        )}
        <span className="grow" />
        {action}
        {/* Subtle entrance (#8): a quiet, icon-only bell beside the avatar, not inside it — the
            identity control reverts to a plain rename trigger so the two stay independent. */}
        <button
          className="icon-btn notify-btn"
          onClick={onOpenNotifications}
          aria-label="Notifications"
          title="Notifications"
        >
          {pushKind === "blocked" ? Icons.bellOff(16) : Icons.bell(16)}
          {pushKind === "blocked" && <span className="notify-dot" />}
        </button>
        <button className="me-btn me-btn-inline" onClick={onRename} title="Change your name">
          <Avatar name={actor || "?"} kind="human" size={22} quiet={!mobile} />
          <span className="ellipsis">{actor || "…"}</span>
        </button>
        {dbPath && <span className="muted tiny ellipsis home-db" title={dbPath}>{dbPath.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/")}</span>}
        {trailing}
      </div>
    </header>
  );
}
