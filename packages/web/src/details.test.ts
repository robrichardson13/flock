import { describe, expect, it } from "bun:test";
import { buildDetailRows, isOpenStatus, runtimeText, type DetailRow } from "./details.ts";
import type { CardStatus } from "./api.ts";

const card = (over: Partial<{ status: CardStatus; assignee: string | null; labels: string[]; blockedBy: number[] }> = {}) => ({
  status: "todo" as CardStatus,
  assignee: null,
  labels: [],
  blockedBy: [],
  ...over,
});

const rowsOf = (rows: DetailRow[]) => rows.map((r) => r.key);
const find = <K extends DetailRow["key"]>(rows: DetailRow[], key: K) =>
  rows.find((r) => r.key === key) as Extract<DetailRow, { key: K }>;

describe("isOpenStatus", () => {
  it("counts everything that is not closed as open", () => {
    expect(isOpenStatus("todo")).toBe(true);
    expect(isOpenStatus("doing")).toBe(true);
    expect(isOpenStatus("awaiting-human")).toBe(true);
    expect(isOpenStatus("done")).toBe(false);
    expect(isOpenStatus("wontfix")).toBe(false);
  });

  it("treats a card we cannot see as open, so its blocker still warns", () => {
    expect(isOpenStatus(undefined)).toBe(true);
  });
});

describe("runtimeText", () => {
  it("is the model alone when there is no effort", () => {
    expect(runtimeText({ model: "opus" })).toBe("opus");
  });

  it("joins model and effort with a middot", () => {
    expect(runtimeText({ model: "opus", effort: "high" })).toBe("opus · high");
  });

  it("is nothing without a model, even with an effort", () => {
    expect(runtimeText({ effort: "high" })).toBeNull();
    expect(runtimeText(undefined)).toBeNull();
  });
});

describe("buildDetailRows", () => {
  it("always renders status, assignee, labels and blocked-by", () => {
    const rows = buildDetailRows({ card: card(), blocks: [], allCards: [] });
    expect(rowsOf(rows)).toEqual(["status", "assignee", "labels", "blockedBy"]);
  });

  it("hides Blocks entirely when the card blocks nothing", () => {
    expect(rowsOf(buildDetailRows({ card: card(), blocks: [], allCards: [] }))).not.toContain("blocks");
  });

  it("shows Blocks when there is something to say", () => {
    const rows = buildDetailRows({ card: card(), blocks: [7], allCards: [{ num: 7, status: "todo" }] });
    expect(find(rows, "blocks").tokens).toEqual([{ num: 7, status: "todo", open: true }]);
  });

  it("keeps a Blocked-by row even when empty, because that is where a blocker is added", () => {
    const rows = buildDetailRows({ card: card(), blocks: [], allCards: [] });
    const r = find(rows, "blockedBy");
    expect(r.tokens).toEqual([]);
    expect(r.tappable).toBe(true);
  });

  it("marks a closed blocker as no longer open", () => {
    const rows = buildDetailRows({
      card: card({ blockedBy: [3, 4] }),
      blocks: [],
      allCards: [{ num: 3, status: "done" }, { num: 4, status: "doing" }],
    });
    expect(find(rows, "blockedBy").tokens).toEqual([
      { num: 3, status: "done", open: false },
      { num: 4, status: "doing", open: true },
    ]);
  });

  it("labels the status row with the app's word for it", () => {
    const rows = buildDetailRows({ card: card({ status: "awaiting-human" }), blocks: [], allCards: [] });
    expect(find(rows, "status").value).toBe("Needs you");
  });

  it("carries the assignee's kind and runtime suffix", () => {
    const rows = buildDetailRows({
      card: card({ assignee: "detailer" }),
      blocks: [],
      allCards: [],
      holder: { kind: "agent", model: "opus", effort: "high" },
    });
    const r = find(rows, "assignee");
    expect(r.assignee).toBe("detailer");
    expect(r.kind).toBe("agent");
    expect(r.runtime).toBe("opus · high");
    expect(r.tappable).toBe(false);
  });

  it("treats an unknown holder as an agent and says nothing about its runtime", () => {
    const rows = buildDetailRows({ card: card({ assignee: "ada" }), blocks: [], allCards: [] });
    expect(find(rows, "assignee").kind).toBe("agent");
    expect(find(rows, "assignee").runtime).toBeNull();
  });

  it("does not invent a runtime for an unassigned card", () => {
    const rows = buildDetailRows({ card: card(), blocks: [], allCards: [], holder: { model: "opus" } });
    expect(find(rows, "assignee").assignee).toBeNull();
    expect(find(rows, "assignee").runtime).toBeNull();
  });

  it("passes the labels through in order", () => {
    const rows = buildDetailRows({ card: card({ labels: ["ux", "web"] }), blocks: [], allCards: [] });
    expect(find(rows, "labels").labels).toEqual(["ux", "web"]);
  });
});
