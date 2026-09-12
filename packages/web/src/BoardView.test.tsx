import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { displayTabWhileClosing, paneHref, Section, stickyActorName, tabHref } from "./BoardView.tsx";

/**
 * #32: mobile's Done section is a plain vertical list now — every finished card renders, with
 * no "N more" fold. The phone renders `Section` without an `onToggleFold`, even when Done holds
 * far more cards than the old DONE_FOLD_AT threshold (4); the desktop kanban column renders its
 * own fold button directly and never goes through `Section` at all. This guards the mobile path:
 * `Section` must stay silent about folding whenever the caller doesn't ask for it, however many
 * cards it's counting.
 */
describe("Section fold control (#32)", () => {
  it("renders no fold button when onToggleFold is omitted, however large the count", () => {
    const html = renderToStaticMarkup(
      <Section status="done" count={46} onNew={() => {}}>
        <div className="list" />
      </Section>,
    );
    expect(html).not.toContain("section-fold");
    expect(html).not.toContain("more");
  });

  it("still renders the fold button when a caller opts in with onToggleFold", () => {
    const html = renderToStaticMarkup(
      <Section status="done" count={46} hidden={42} onToggleFold={() => {}} onNew={() => {}}>
        <div className="list" />
      </Section>,
    );
    expect(html).toContain("section-fold");
    expect(html).toContain("42 more");
  });

  it("shows the full count in the section head either way", () => {
    const html = renderToStaticMarkup(
      <Section status="done" count={46} onNew={() => {}}>
        <div className="list" />
      </Section>,
    );
    expect(html).toContain('<span class="section-count">46</span>');
  });
});

/**
 * Card #4: the top-nav back button from a card opened off Activity (or Channel, or Decisions)
 * used to land in two hops — the pane under the card reveals Cards the instant the exit
 * animation starts (the route's own tab stays "cards" for as long as the card page is on
 * screen), then a second, separate transition to the remembered tab once the delayed
 * navigation finally lands. `displayTabWhileClosing` is what the pane renders instead: the
 * destination tab from the first frame of the close, so there is only the one transition.
 */
describe("displayTabWhileClosing (#4)", () => {
  it("shows the remembered tab while the card is closing, not the route's own \"cards\"", () => {
    expect(displayTabWhileClosing("cards", true, "activity")).toBe("activity");
  });

  it("keeps a deep-linked card's fallback of cards when nothing else was ever remembered", () => {
    expect(displayTabWhileClosing("cards", true, "cards")).toBe("cards");
  });

  it("defers to the route's tab whenever the card isn't closing", () => {
    expect(displayTabWhileClosing("channel", false, "activity")).toBe("channel");
  });
});

/**
 * Card #3: `#/b/<slug>/a/<name>` has the same tab-less shape as `#/b/<slug>/c/<n>`, so
 * `parseRoute` reports "cards" for the whole time an actor is on screen, not just while it
 * closes. Unlike the card page, the actor sheet is a partial overlay — whatever is behind it
 * stays visible for the entire visit — so an avatar tapped from, say, the Activity tab used to
 * reveal Cards behind the sheet the moment it opened. `actorOpen` covers that the same way
 * `cardClosing` covers the card's close.
 */
describe("displayTabWhileClosing with an open actor (#3)", () => {
  it("shows the remembered tab for as long as the actor sheet is open, not the route's forced \"cards\"", () => {
    expect(displayTabWhileClosing("cards", false, "activity", true)).toBe("activity");
  });

  it("keeps a deep-linked actor's fallback of cards when nothing else was ever remembered", () => {
    expect(displayTabWhileClosing("cards", false, "cards", true)).toBe("cards");
  });

  it("defers to the route's tab once the actor is gone", () => {
    expect(displayTabWhileClosing("channel", false, "activity", false)).toBe("channel");
  });
});

/**
 * Card #22: `actorName` clears the instant the route does, before the actor sheet has had a
 * chance to play its own fade-out — `stickyActorName` is what lets the sheet keep naming the
 * actor (and hence keep fetching/rendering their real content) through that closing beat
 * instead of either unmounting outright or rendering blank.
 */
describe("stickyActorName (#22)", () => {
  it("passes the current name straight through while the sheet is open", () => {
    expect(stickyActorName("mira", "corvid")).toBe("mira");
  });

  it("falls back to the last real name once the route has cleared", () => {
    expect(stickyActorName(undefined, "corvid")).toBe("corvid");
  });

  it("is undefined when the sheet has never named anyone", () => {
    expect(stickyActorName(undefined, undefined)).toBeUndefined();
  });
});

/**
 * Tapping the Cards tab button while already on Cards has nowhere further "in" to go, so it
 * backs out to the boards list instead of re-rendering the same pane. Every other tab keeps
 * routing to itself on a re-tap, and Cards from any other tab still switches to Cards as usual.
 */
describe("tabHref", () => {
  it("routes Cards-while-on-Cards to the boards list", () => {
    expect(tabHref("flock", "cards", "cards")).toBe("#/");
  });

  it("routes Cards from another tab to the board's Cards route", () => {
    expect(tabHref("flock", "channel", "cards")).toBe("#/b/flock");
    expect(tabHref("flock", "activity", "cards")).toBe("#/b/flock");
    expect(tabHref("flock", "decisions", "cards")).toBe("#/b/flock");
  });

  it("leaves the other tabs unchanged on a re-tap", () => {
    expect(tabHref("flock", "channel", "channel")).toBe("#/b/flock/channel");
    expect(tabHref("flock", "activity", "activity")).toBe("#/b/flock/activity");
    expect(tabHref("flock", "decisions", "decisions")).toBe("#/b/flock/decisions");
  });

  it("routes normally between the non-Cards tabs", () => {
    expect(tabHref("flock", "cards", "channel")).toBe("#/b/flock/channel");
    expect(tabHref("flock", "channel", "activity")).toBe("#/b/flock/activity");
    expect(tabHref("flock", "activity", "decisions")).toBe("#/b/flock/decisions");
  });
});

/**
 * #23: leaving a card page goes *to* a tab, and `paneHref` is the route a tab lives at with no
 * tab-bar re-tap rule over it. A card route parses as `tab: "cards"`, so the back button used to
 * ask `tabHref` for "cards while on cards" and got the boards list — the card's exit animation
 * followed by the boards index pushing in over it. These are the cases the two helpers must
 * disagree on, which is the whole reason the split exists.
 */
describe("paneHref (#23)", () => {
  it("routes Cards to the board itself even when Cards is already the current route", () => {
    expect(paneHref("flock", "cards")).toBe("#/b/flock");
    expect(tabHref("flock", "cards", "cards")).toBe("#/");
  });

  it("routes the other tabs to their own route", () => {
    expect(paneHref("flock", "channel")).toBe("#/b/flock/channel");
    expect(paneHref("flock", "activity")).toBe("#/b/flock/activity");
    expect(paneHref("flock", "decisions")).toBe("#/b/flock/decisions");
  });

  it("agrees with tabHref everywhere the re-tap rule does not apply", () => {
    for (const current of ["cards", "channel", "activity", "decisions"] as const) {
      for (const target of ["cards", "channel", "activity", "decisions"] as const) {
        if (target === "cards" && current === "cards") continue;
        expect(tabHref("flock", current, target)).toBe(paneHref("flock", target));
      }
    }
  });
});
