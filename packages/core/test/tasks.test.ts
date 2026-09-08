import { describe, expect, test } from "bun:test";
import { Flock, FlockError, setTaskChecked, taskItems, type Actor } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Flock v1" });
  return { f, board };
}

describe("taskItems", () => {
  test("finds unchecked, checked, nested and numbered items", () => {
    const body = [
      "Plan:",
      "- [ ] Dockerfile",
      "- [x] Auth model",
      "  - [ ] token shape",
      "\t- [X] cookie shape",
      "1. [ ] numbered",
      "* [ ] star marker",
      "- plain bullet",
    ].join("\n");
    const items = taskItems(body);
    expect(items.map((i) => i.text)).toEqual([
      "Dockerfile",
      "Auth model",
      "token shape",
      "cookie shape",
      "numbered",
      "star marker",
    ]);
    expect(items.map((i) => i.checked)).toEqual([false, true, false, true, false, false]);
    expect(items.map((i) => i.indent)).toEqual([0, 0, 2, 4, 0, 0]);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("ignores task items inside fenced code blocks", () => {
    const body = [
      "- [ ] real one",
      "```md",
      "- [ ] sample in a fence",
      "- [x] another sample",
      "```",
      "- [x] real two",
      "~~~",
      "- [ ] tilde fenced",
      "~~~",
      "- [ ] real three",
    ].join("\n");
    expect(taskItems(body).map((i) => i.text)).toEqual(["real one", "real two", "real three"]);
  });

  test("an unclosed fence swallows the rest of the body", () => {
    const body = ["- [ ] real", "```", "- [ ] not real"].join("\n");
    expect(taskItems(body).map((i) => i.text)).toEqual(["real"]);
  });

  test("a body with no task items yields nothing", () => {
    expect(taskItems("Just prose.\n\n- a bullet\n")).toEqual([]);
    expect(taskItems("")).toEqual([]);
  });
});

describe("setTaskChecked", () => {
  test("rewrites only the target line", () => {
    const body = "Intro\n- [ ] one\n- [ ] two\nOutro [ ] not a task\n";
    expect(setTaskChecked(body, 1, true)).toBe("Intro\n- [ ] one\n- [x] two\nOutro [ ] not a task\n");
  });

  test("returns null when the index is out of range", () => {
    expect(setTaskChecked("- [ ] one", 1, true)).toBeNull();
    expect(setTaskChecked("no tasks here", 0, true)).toBeNull();
  });
});

describe("toggleCardTask", () => {
  test("toggles on and off, and persists to the body", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Deploy", body: "- [ ] one\n- [ ] two" });
    expect(f.toggleCardTask(scout, board.id, c.num, 1).body).toBe("- [ ] one\n- [x] two");
    expect(f.toggleCardTask(scout, board.id, c.num, 1).body).toBe("- [ ] one\n- [ ] two");
    // An explicit state is idempotent.
    f.toggleCardTask(scout, board.id, c.num, 0, true);
    expect(f.toggleCardTask(scout, board.id, c.num, 0, true).body).toBe("- [x] one\n- [ ] two");
  });

  test("indexes nested items in document order", () => {
    const { f, board } = fresh();
    const body = "- [ ] parent\n  - [ ] child\n- [ ] sibling";
    const c = f.createCard(ada, board.id, { title: "Nest", body });
    expect(f.toggleCardTask(scout, board.id, c.num, 1).body).toBe("- [ ] parent\n  - [x] child\n- [ ] sibling");
  });

  test("does not count items inside fenced code blocks", () => {
    const { f, board } = fresh();
    const body = "- [ ] real\n```\n- [ ] fenced\n```\n- [ ] also real";
    const c = f.createCard(ada, board.id, { title: "Fence", body });
    expect(f.toggleCardTask(scout, board.id, c.num, 1).body).toBe("- [ ] real\n```\n- [ ] fenced\n```\n- [x] also real");
    expect(() => f.toggleCardTask(scout, board.id, c.num, 2)).toThrow(/no item 2/);
  });

  test("rejects an out-of-range or negative index", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Deploy", body: "- [ ] one" });
    expect(() => f.toggleCardTask(scout, board.id, c.num, 5)).toThrow(FlockError);
    try {
      f.toggleCardTask(scout, board.id, c.num, 5);
    } catch (e) {
      expect((e as FlockError).status).toBe(404);
    }
    expect(() => f.toggleCardTask(scout, board.id, c.num, -1)).toThrow(/not a task index/);
    const plain = f.createCard(ada, board.id, { title: "No tasks", body: "prose" });
    expect(() => f.toggleCardTask(scout, board.id, plain.num, 0)).toThrow(/no task-list items/);
  });

  test("emits card.updated attributed to the actor", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Deploy", body: "- [ ] one" });
    f.toggleCardTask(scout, board.id, c.num, 0);
    const ev = f.events({ boardId: board.id }).filter((e) => e.type === "card.updated");
    expect(ev.length).toBe(1);
    expect(ev[0]!.actor).toBe("scout");
    expect(ev[0]!.cardNum).toBe(c.num);
  });
});
