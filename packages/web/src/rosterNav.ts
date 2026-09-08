/**
 * Moving between the roster and one actor (#31).
 *
 * The roster is an overlay whose open/closed state lives in React, while the actor view is a
 * *route* (`#/b/<slug>/a/<name>`, #49) that replaces whatever was on screen. Those two facts
 * used to be wired straight to each other — tapping a roster row navigated, and an effect
 * closed the roster — so the actor view was a one-way door: its only control returned to the
 * board, and the list you came from was gone.
 *
 * All the state that fixes it is here rather than in `BoardView`, which already carries a
 * dozen refs: whether the roster is showing, and where its list had been scrolled to when it
 * was last left, so `back` puts it back exactly as it was rather than at the top.
 *
 * A deep link starts from `ROSTER_NAV_INITIAL` — nothing was scrolled because nothing was
 * open — so `back` from a linked actor opens the roster at its top, which is right: that
 * reader has never seen the list.
 */
export interface RosterNav {
  /** Is the roster showing? */
  open: boolean;
  /** Where the roster's list was when it was last left, restored when `back` reopens it. */
  scrollTop: number;
}

export const ROSTER_NAV_INITIAL: RosterNav = { open: false, scrollTop: 0 };

export type RosterNavAction =
  /** The team stack, or the board menu's Team item. */
  | { type: "open" }
  /** The roster's own ✕, its scrim, or Escape. */
  | { type: "dismiss" }
  /** A roster row was tapped: the actor view takes the screen, and this is where we were. */
  | { type: "enterActor"; scrollTop: number }
  /** The actor view's back control. */
  | { type: "back" }
  /** The actor view was dismissed outright (✕, scrim, Escape) rather than stepped back from. */
  | { type: "leaveActor" };

/**
 * Deliberately closing the roster forgets the scroll; stepping *into* an actor remembers it.
 * The difference is what the reader meant: "I am done with this list" starts the next visit
 * at the top, while "show me this one" is still the same visit and owes them their place.
 */
export function rosterNav(state: RosterNav, action: RosterNavAction): RosterNav {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "dismiss":
      return { open: false, scrollTop: 0 };
    case "enterActor":
      return { open: false, scrollTop: action.scrollTop };
    case "back":
      return { ...state, open: true };
    case "leaveActor":
      return { open: false, scrollTop: 0 };
  }
}
