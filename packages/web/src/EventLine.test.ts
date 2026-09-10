import { describe, expect, it } from "bun:test";
import { eventPhrase, eventSummary } from "./EventLine.tsx";
import type { Event } from "./api.ts";

function ev(type: Event["type"], data: Record<string, unknown> = {}, cardNum: number | null = 3): Event {
  return {
    seq: 1,
    boardId: "b1",
    actor: "builder-a",
    actorKind: "agent",
    type,
    cardNum,
    data,
    createdAt: "2026-09-08T12:00:00.000Z",
  };
}

describe("eventPhrase", () => {
  it("phrases board events without a card", () => {
    expect(eventPhrase(ev("board.created", {}, null))).toEqual({ verb: "created the board", showCard: false, cardSuffix: "", payload: "" });
    expect(eventPhrase(ev("board.updated", {}, null))).toEqual({ verb: "edited the brief", showCard: false, cardSuffix: "", payload: "" });
  });

  it("falls back to the event's own title for card.created when no title map entry is given", () => {
    expect(eventPhrase(ev("card.created", { title: "Fix the thing" }))).toEqual({
      verb: "opened", showCard: true, cardSuffix: "", payload: "Fix the thing",
    });
  });

  it("prefers a supplied card title over the event's own data", () => {
    expect(eventPhrase(ev("card.claimed", {}), "Newer title").payload).toBe("Newer title");
  });

  it("phrases a move with the destination's human label", () => {
    const p = eventPhrase(ev("card.moved", { from: "todo", to: "doing" }), "Ship it");
    expect(p).toEqual({ verb: "moved", showCard: true, cardSuffix: "to Doing", payload: "Ship it" });
  });

  it("distinguishes a close from a won't-fix", () => {
    expect(eventPhrase(ev("card.closed", { to: "done" }), "T").verb).toBe("finished");
    expect(eventPhrase(ev("card.closed", { to: "done" }), "T").cardSuffix).toBe("");
    const wontfix = eventPhrase(ev("card.closed", { to: "wontfix" }), "T");
    expect(wontfix.verb).toBe("closed");
    expect(wontfix.cardSuffix).toBe("as won't fix");
  });

  it("names the blocking card in the suffix", () => {
    expect(eventPhrase(ev("card.blocked", { by: 7 }), "T").cardSuffix).toBe("on #7");
  });

  it("uses the hold reason as the payload, falling back to the title without one", () => {
    expect(eventPhrase(ev("card.held", { reason: "waiting on design" }), "T").verb).toBe("put on hold");
    expect(eventPhrase(ev("card.held", { reason: "waiting on design" }), "T").payload).toBe("waiting on design");
    expect(eventPhrase(ev("card.held", { reason: null }), "T").payload).toBe("T");
  });

  it("says the hold was released, naming only the card", () => {
    const p = eventPhrase(ev("card.unheld", { reason: "waiting on design", heldBy: "rob" }), "T");
    expect(p.verb).toBe("released the hold on");
    expect(p.payload).toBe("T");
  });

  it("uses the question and answer as the payload", () => {
    expect(eventPhrase(ev("card.asked", { question: "Which API?" }), "T").payload).toBe("Which API?");
    expect(eventPhrase(ev("card.answered", { answer: "Places." }), "T").payload).toBe("Places.");
  });

  it("takes only the first line of a comment, or names the image count", () => {
    expect(eventPhrase(ev("comment.posted", { body: "Line one\nLine two" }), "T").payload).toBe("Line one");
    expect(eventPhrase(ev("comment.posted", { attachments: 2 }), "T").payload).toBe("sent 2 images");
    expect(eventPhrase(ev("comment.posted", { attachments: 1 }), "T").payload).toBe("sent 1 image");
  });

  it("has no card for a channel message, whose payload is its own body", () => {
    const p = eventPhrase(ev("message.posted", { body: "Hello" }, null));
    expect(p.showCard).toBe(false);
    expect(p.payload).toBe("Hello");
  });

  it("only shows a card when a decision is attached to one", () => {
    const withCard = eventPhrase(ev("decision.recorded", { gist: "Ship Apple Pay first" }, 5));
    expect(withCard.verb).toBe("decided on");
    expect(withCard.showCard).toBe(true);
    const boardWide = eventPhrase(ev("decision.recorded", { gist: "Freeze the schema" }, null));
    expect(boardWide.verb).toBe("decided");
    expect(boardWide.showCard).toBe(false);
  });
});

describe("eventSummary", () => {
  it("joins actor, verb, card and payload into one line", () => {
    expect(eventSummary(ev("card.claimed", {}), "Ship it")).toBe("builder-a claimed #3 Ship it");
  });

  it("puts a suffix-only card (a board-wide decision) after the verb with no #", () => {
    expect(eventSummary(ev("decision.recorded", { gist: "Freeze the schema" }, null))).toBe("builder-a decided Freeze the schema");
  });

  it("drops the card entirely for a channel message", () => {
    expect(eventSummary(ev("message.posted", { body: "Hi" }, null))).toBe("builder-a posted to the channel Hi");
  });
});
