import { describe, expect, it } from "bun:test";
import { buildCardActions, ROW_MAX, type CardActionKey, type CardActionsInput } from "./cardActions.ts";

const base: CardActionsInput = { status: "todo", assignee: null, held: false, blocked: false, me: "rob" };
const keys = (i: Partial<CardActionsInput>) => {
  const set = buildCardActions({ ...base, ...i });
  return { row: set.row.map((a) => a.key), overflow: set.overflow.map((a) => a.key) };
};
const all = (i: Partial<CardActionsInput>): CardActionKey[] => {
  const k = keys(i);
  return [...k.row, ...k.overflow];
};

describe("which two verbs get a button (card 99)", () => {
  it("an unclaimed card offers Claim and Hold", () => {
    expect(keys({}).row).toEqual(["claim", "hold"]);
  });

  it("a card you hold offers Release and Hold", () => {
    expect(keys({ assignee: "rob", status: "doing" }).row).toEqual(["release", "hold"]);
  });

  it("a held card leads with lifting the hold", () => {
    expect(keys({ held: true }).row).toEqual(["unhold"]);
    expect(keys({ held: true, assignee: "rob" }).row).toEqual(["unhold", "release"]);
  });

  it("a closed card offers Reopen and nothing else", () => {
    expect(keys({ status: "done" })).toEqual({ row: ["reopen"], overflow: [] });
    expect(keys({ status: "wontfix" })).toEqual({ row: ["reopen"], overflow: [] });
  });

  it("never draws more than ROW_MAX buttons, in any state", () => {
    for (const assignee of [null, "rob", "some-agent"]) {
      for (const held of [false, true]) {
        for (const blocked of [false, true]) {
          expect(keys({ assignee, held, blocked }).row.length).toBeLessThanOrEqual(ROW_MAX);
        }
      }
    }
  });
});

describe("what falls through to the overflow menu (card 99)", () => {
  it("Mark done is never a button — it has the Status row and the composer's Resolve", () => {
    for (const assignee of [null, "rob", "some-agent"]) {
      for (const held of [false, true]) {
        expect(keys({ assignee, held }).row).not.toContain("done" as CardActionKey);
        expect(keys({ assignee, held }).overflow).toContain("done" as CardActionKey);
      }
    }
  });

  it("Unassign someone else is never a button — its label is an agent's whole name", () => {
    const k = keys({ assignee: "card-actions-builder", status: "doing" });
    expect(k.row).toEqual(["hold"]);
    expect(k.overflow).toEqual(["unassign", "done"]);
  });

  it("Unassign carries the assignee's name so the menu item says whose claim it drops", () => {
    const set = buildCardActions({ ...base, assignee: "card-actions-builder", status: "doing" });
    expect(set.overflow.find((a) => a.key === "unassign")?.label).toBe("Unassign card-actions-builder");
  });

  it("every verb the state offers is reachable: the row and the menu never drop one", () => {
    for (const assignee of [null, "rob", "some-agent"]) {
      for (const held of [false, true]) {
        const verbs = all({ assignee, held, status: "doing" });
        expect(new Set(verbs).size).toBe(verbs.length);
        expect(verbs).toContain("done" as CardActionKey);
        expect(verbs).toContain(held ? ("unhold" as CardActionKey) : ("hold" as CardActionKey));
      }
    }
  });
});

describe("labels (card 99)", () => {
  it("a blocked, unclaimed card says Claim anyway", () => {
    const set = buildCardActions({ ...base, blocked: true });
    expect(set.row[0]?.label).toBe("Claim anyway");
  });

  it("a held card never offers Claim — claiming one always conflicts", () => {
    expect(all({ held: true })).not.toContain("claim" as CardActionKey);
    expect(all({ held: true, blocked: true })).not.toContain("claim" as CardActionKey);
  });

  it("Hold is the quiet one beside a solid button", () => {
    const set = buildCardActions(base);
    expect(set.row.find((a) => a.key === "hold")?.tone).toBe("ghost");
  });
});

describe("a lone action is never a ghost (card 99)", () => {
  it("Hold on someone else's card is solid, since nothing sits beside it", () => {
    const set = buildCardActions({ ...base, assignee: "some-agent", status: "doing" });
    expect(set.row.map((a) => a.key)).toEqual(["hold"]);
    expect(set.row[0]?.tone).toBeUndefined();
  });

  it("but stays a ghost next to Release", () => {
    const set = buildCardActions({ ...base, assignee: "rob", status: "doing" });
    expect(set.row.find((a) => a.key === "hold")?.tone).toBe("ghost");
  });
});
