import { describe, expect, it } from "bun:test";
import { ROSTER_NAV_INITIAL, rosterNav, type RosterNav, type RosterNavAction } from "./rosterNav.ts";

const play = (...actions: RosterNavAction[]): RosterNav => actions.reduce(rosterNav, ROSTER_NAV_INITIAL);

describe("rosterNav (#31)", () => {
  it("starts closed at the top", () => {
    expect(ROSTER_NAV_INITIAL).toEqual({ open: false, scrollTop: 0 });
  });

  it("opens the roster from the team stack", () => {
    expect(play({ type: "open" }).open).toBe(true);
  });

  it("closes the roster while an actor is showing", () => {
    expect(play({ type: "open" }, { type: "enterActor", scrollTop: 240 }).open).toBe(false);
  });

  it("goes back from an actor to the roster, scrolled where it was left", () => {
    const s = play({ type: "open" }, { type: "enterActor", scrollTop: 240 }, { type: "back" });
    expect(s).toEqual({ open: true, scrollTop: 240 });
  });

  it("keeps the place across a second drill-down and back", () => {
    const s = play(
      { type: "open" },
      { type: "enterActor", scrollTop: 240 },
      { type: "back" },
      { type: "enterActor", scrollTop: 900 },
      { type: "back" },
    );
    expect(s).toEqual({ open: true, scrollTop: 900 });
  });

  it("forgets the place when the roster is dismissed rather than stepped into", () => {
    const s = play({ type: "open" }, { type: "enterActor", scrollTop: 240 }, { type: "back" }, { type: "dismiss" });
    expect(s).toEqual({ open: false, scrollTop: 0 });
    // ...so the next visit starts at the top.
    expect(rosterNav(s, { type: "open" })).toEqual({ open: true, scrollTop: 0 });
  });

  it("forgets the place when the actor view is dismissed outright instead of stepped back from", () => {
    const s = play({ type: "open" }, { type: "enterActor", scrollTop: 240 }, { type: "leaveActor" });
    expect(s).toEqual({ open: false, scrollTop: 0 });
  });

  it("opens the roster at its top when back is pressed on a deep-linked actor", () => {
    // Nobody opened a list to get here: `#/b/<slug>/a/<name>` was the first route.
    expect(play({ type: "back" })).toEqual({ open: true, scrollTop: 0 });
  });

  it("is pure: the same state and action always give the same result", () => {
    const s: RosterNav = { open: false, scrollTop: 120 };
    expect(rosterNav(s, { type: "back" })).toEqual(rosterNav(s, { type: "back" }));
    expect(s).toEqual({ open: false, scrollTop: 120 });
  });
});
