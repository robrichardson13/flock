import { describe, expect, test } from "bun:test";
import { Flock, FlockError, exportBoard, holdConflictMessage, importBoard, type Actor } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Hold test", body: "## Destination\nShip it." });
  return { f, board };
}

describe("holdCard", () => {
  test("sets all three columns, derives held, and emits card.held with the actor", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    const held = f.holdCard(ada, board.id, c.num, { reason: "waiting on design" });
    expect(held.held).toBe(true);
    expect(held.heldBy).toBe("ada");
    expect(held.holdReason).toBe("waiting on design");
    expect(held.heldAt).not.toBeNull();

    const events = f.events({ boardId: board.id }).filter((e) => e.type === "card.held");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("ada");
    expect(events[0].cardNum).toBe(c.num);
    expect((events[0].data as { reason: string }).reason).toBe("waiting on design");
  });

  test("hold with no reason stores null", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    const held = f.holdCard(ada, board.id, c.num);
    expect(held.holdReason).toBeNull();
    const held2 = f.holdCard(ada, board.id, c.num, { reason: "   " });
    expect(held2.holdReason).toBeNull();
  });

  test("re-holding an already-held card re-stamps it and emits a second card.held", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num, { reason: "first" });
    const second = f.holdCard(ada, board.id, c.num, { reason: "second" });
    expect(second.holdReason).toBe("second");
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "card.held")).toHaveLength(2);
  });

  test("throws conflict on a closed card", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.closeCard(scout, board.id, c.num, { resolution: "done" });
    expect(() => f.holdCard(ada, board.id, c.num)).toThrow(FlockError);
    try {
      f.holdCard(ada, board.id, c.num);
    } catch (e) {
      expect((e as FlockError).status).toBe(409);
    }
  });

  test("holding a doing card keeps it doing; holding an awaiting-human card keeps it awaiting-human", () => {
    const { f, board } = fresh();
    const doing = f.createCard(ada, board.id, { title: "Doing card" });
    f.claimCard(scout, board.id, doing.num);
    const heldDoing = f.holdCard(ada, board.id, doing.num, { reason: "pause" });
    expect(heldDoing.status).toBe("doing");
    expect(heldDoing.held).toBe(true);

    const asking = f.createCard(ada, board.id, { title: "Ask card" });
    f.claimCard(scout, board.id, asking.num);
    f.askHuman(scout, board.id, asking.num, "what now?");
    const heldAsking = f.holdCard(ada, board.id, asking.num, { reason: "thinking" });
    expect(heldAsking.status).toBe("awaiting-human");
    expect(heldAsking.held).toBe(true);
  });

  test("a held doing card can still be commented and moved by its assignee", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.claimCard(scout, board.id, c.num);
    f.holdCard(ada, board.id, c.num, { reason: "pause" });
    expect(() => f.addComment(scout, board.id, c.num, "still working")).not.toThrow();
    const moved = f.moveCard(scout, board.id, c.num, "awaiting-human", { reason: "checking in" });
    expect(moved.status).toBe("awaiting-human");
    expect(moved.held).toBe(true);
  });

  test("closing a held card (done or wontfix) clears the hold", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.claimCard(scout, board.id, c.num);
    f.holdCard(ada, board.id, c.num, { reason: "pause" });
    const closed = f.closeCard(scout, board.id, c.num, { resolution: "done despite hold" });
    expect(closed.status).toBe("done");
    expect(closed.held).toBe(false);
    expect(closed.heldAt).toBeNull();
    expect(closed.heldBy).toBeNull();
    expect(closed.holdReason).toBeNull();

    const d = f.createCard(ada, board.id, { title: "B" });
    f.holdCard(ada, board.id, d.num, { reason: "not this one either" });
    const wontfixed = f.moveCard(ada, board.id, d.num, "wontfix");
    expect(wontfixed.held).toBe(false);
    expect(wontfixed.heldAt).toBeNull();
  });

  test("closing a held card emits card.unheld with the prior hold's fields, before card.closed", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num, { reason: "pause" });
    f.closeCard(ada, board.id, c.num, { resolution: "done" });

    const events = f.events({ boardId: board.id }).filter((e) => e.cardNum === c.num);
    const unheldIdx = events.findIndex((e) => e.type === "card.unheld");
    const closedIdx = events.findIndex((e) => e.type === "card.closed");
    expect(unheldIdx).toBeGreaterThan(-1);
    expect(closedIdx).toBeGreaterThan(-1);
    expect(unheldIdx).toBeLessThan(closedIdx);
    const unheldEvent = events[unheldIdx];
    expect((unheldEvent.data as { heldBy: string; reason: string }).heldBy).toBe("ada");
    expect((unheldEvent.data as { heldBy: string; reason: string }).reason).toBe("pause");
  });

  test("closing an unheld card emits no card.unheld", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.closeCard(ada, board.id, c.num, { resolution: "done" });
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "card.unheld")).toHaveLength(0);
  });

  test("holdCard on a closed card remains a conflict, so a held-then-closed card can never round-trip through export as (on hold)", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num, { reason: "pause" });
    f.closeCard(ada, board.id, c.num, { resolution: "done" });
    expect(() => f.holdCard(ada, board.id, c.num)).toThrow(FlockError);
    const md = exportBoard(f, board.id);
    expect(md).not.toContain("(on hold)");
  });
});

describe("unholdCard", () => {
  test("clears all three columns and emits card.unheld carrying the prior reason", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num, { reason: "wait" });
    const unheld = f.unholdCard(ada, board.id, c.num);
    expect(unheld.held).toBe(false);
    expect(unheld.heldAt).toBeNull();
    expect(unheld.heldBy).toBeNull();
    expect(unheld.holdReason).toBeNull();

    const events = f.events({ boardId: board.id }).filter((e) => e.type === "card.unheld");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("ada");
    expect((events[0].data as { reason: string; heldBy: string }).reason).toBe("wait");
    expect((events[0].data as { reason: string; heldBy: string }).heldBy).toBe("ada");
  });

  test("is a no-op on a card that is not held: no write, no event, no error", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    const before = f.card(board.id, c.num);
    const after = f.unholdCard(ada, board.id, c.num);
    expect(after).toEqual(before);
    expect(f.events({ boardId: board.id }).filter((e) => e.type === "card.unheld")).toHaveLength(0);
  });
});

describe("claim guard against a hold", () => {
  test("claim on a held card throws conflict and the message names the holder", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num, { reason: "waiting on design" });
    expect(() => f.claimCard(scout, board.id, c.num)).toThrow(FlockError);
    try {
      f.claimCard(scout, board.id, c.num);
    } catch (e) {
      expect((e as FlockError).status).toBe(409);
      expect((e as FlockError).message).toBe(holdConflictMessage(f.card(board.id, c.num)));
      expect((e as FlockError).message).toContain("ada");
      expect((e as FlockError).message).toContain("waiting on design");
      expect((e as FlockError).message).toContain("flock unhold");
    }
  });

  test("force does not override a hold", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num);
    expect(() => f.claimCard(scout, board.id, c.num, { force: true })).toThrow(FlockError);
    expect(f.card(board.id, c.num).assignee).toBeNull();
  });

  test("a card that is both held and blocked reports the hold", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "A" });
    const b = f.createCard(ada, board.id, { title: "B", blockedBy: [a.num] });
    f.holdCard(ada, board.id, b.num, { reason: "not yet" });
    try {
      f.claimCard(scout, board.id, b.num, { force: true });
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as FlockError).message).toContain("on hold");
      expect((e as FlockError).message).not.toContain("blocked");
    }
  });

  test("claim succeeds once the hold is lifted", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.holdCard(ada, board.id, c.num);
    f.unholdCard(ada, board.id, c.num);
    expect(f.claimCard(scout, board.id, c.num).assignee).toBe("scout");
  });
});

describe("frontier, needs-me and the held filter", () => {
  test("listCards({ frontier: true }) and snapshot().frontier exclude held cards", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "A" });
    const b = f.createCard(ada, board.id, { title: "B" });
    f.holdCard(ada, board.id, a.num, { reason: "later" });
    expect(f.listCards(board.id, { frontier: true }).map((c) => c.num)).toEqual([b.num]);
    const snap = f.snapshot(board.id);
    expect(snap.frontier).toEqual([b.num]);
    expect(snap.held).toEqual([a.num]);
  });

  test("listCards({ held: true/false }) filters", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "A" });
    const b = f.createCard(ada, board.id, { title: "B" });
    f.holdCard(ada, board.id, a.num);
    expect(f.listCards(board.id, { held: true }).map((c) => c.num)).toEqual([a.num]);
    expect(f.listCards(board.id, { held: false }).map((c) => c.num)).toEqual([b.num]);
  });

  test("needsHuman() excludes a held awaiting-human card", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "A" });
    f.claimCard(scout, board.id, c.num);
    f.askHuman(scout, board.id, c.num, "what now?");
    expect(f.needsHuman().map((x) => x.num)).toEqual([c.num]);
    f.holdCard(ada, board.id, c.num, { reason: "I saw it, not answering yet" });
    expect(f.needsHuman().map((x) => x.num)).toEqual([]);
  });
});

describe("markdown export / import", () => {
  test("round-trips a held card and its reason", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "Held card" });
    f.holdCard(ada, board.id, a.num, { reason: "not ready yet" });
    f.createCard(ada, board.id, { title: "Unheld card" });

    const md = exportBoard(f, board.id);
    expect(md).toContain("(on hold)");
    expect(md).toContain("> ! not ready yet");

    const imported = importBoard(f, builder, md, { slug: "imported" });
    const snap = f.snapshot(imported.id);
    const held = snap.cards.find((c) => c.title === "Held card")!;
    const unheld = snap.cards.find((c) => c.title === "Unheld card")!;
    expect(held.held).toBe(true);
    expect(held.holdReason).toBe("not ready yet");
    expect(unheld.held).toBe(false);
    // held_by / held_at do not round-trip: the importing actor and import time stand in.
    expect(held.heldBy).toBe("builder");
  });

  test("round-trips a held card with no reason", () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "Held, no reason" });
    f.holdCard(ada, board.id, 1);
    const md = exportBoard(f, board.id);
    const imported = importBoard(f, builder, md, { slug: "imported2" });
    const held = f.snapshot(imported.id).cards[0];
    expect(held.held).toBe(true);
    expect(held.holdReason).toBeNull();
  });

  test("F3: a multi-line hold reason round-trips intact on a card that also has a question", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Asking and held" });
    f.askHuman(scout, board.id, c.num, "which way?");
    f.holdCard(ada, board.id, c.num, { reason: "line one\nline two" });

    const md = exportBoard(f, board.id);
    const imported = importBoard(f, builder, md, { slug: "imported3" });
    const row = f.snapshot(imported.id).cards.find((x) => x.title === "Asking and held")!;
    expect(row.question).toBe("which way?");
    expect(row.holdReason).toBe("line one\nline two");
  });

  test("F4: a hand-written (on hold) on a closed card is skipped, with a warning, not aborted mid-import", () => {
    const md = [
      "# Hand-written",
      "",
      "## Done",
      "",
      "- [x] #1 Closed but held (on hold)",
      "- [x] #2 Second card",
      "",
    ].join("\n");
    const f = new Flock(":memory:");
    const warnings: string[] = [];
    const imported = importBoard(f, builder, md, { slug: "handwritten", warnings });
    const cards = f.snapshot(imported.id).cards;
    expect(cards.length).toBe(2);
    const first = cards.find((c) => c.num === 1)!;
    expect(first.status).toBe("done");
    expect(first.held).toBe(false);
    expect(warnings.some((w) => w.includes("#1") && w.includes("on hold"))).toBe(true);
  });

  test("F5: assign <n> self on a held card conflicts like claim; assigning someone else is unaffected", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Held card" });
    f.holdCard(ada, board.id, c.num, { reason: "waiting" });

    expect(() => f.assignCard(scout, board.id, c.num, "scout")).toThrow(FlockError);
    try {
      f.assignCard(scout, board.id, c.num, "scout");
    } catch (e) {
      expect((e as FlockError).code).toBe("conflict");
      expect((e as FlockError).message).toBe(holdConflictMessage(f.card(board.id, c.num)));
    }

    // Assigning it to someone else, or clearing the assignee, is unaffected.
    const reassigned = f.assignCard(ada, board.id, c.num, "builder");
    expect(reassigned.assignee).toBe("builder");
    const cleared = f.assignCard(ada, board.id, c.num, null);
    expect(cleared.assignee).toBeNull();
  });
});
