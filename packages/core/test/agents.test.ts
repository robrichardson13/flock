import { describe, expect, test } from "bun:test";
import { Flock, type Actor, type NewAgent } from "../src/index.ts";

const rob: Actor = { name: "rob", kind: "human" };
const conductor: Actor = { name: "conductor", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(rob, { title: "Team", project: "/repos/app" });
  const card = f.createCard(rob, board.slug, { title: "Parser" });
  return { f, slug: board.slug, card: card.num };
}

const scoutOn = (card: number, over: Partial<NewAgent> = {}): NewAgent => ({
  name: "scout",
  cardNum: card,
  harness: "claude-code",
  model: "sonnet",
  effort: null,
  sessionKey: "claude-code:1111",
  openUrl: null,
  cwd: "/repos/app",
  pid: 42,
  launcher: "builtin",
  ...over,
});

describe("agents", () => {
  test("registering an agent records it and emits agent.spawned on its card", () => {
    const { f, slug, card } = fresh();
    f.registerAgent(conductor, slug, scoutOn(card));
    expect(f.agents(slug).map((a) => [a.name, a.status, a.sessionKey])).toEqual([["scout", "running", "claude-code:1111"]]);
    const spawned = f.events({ boardId: f.board(slug).id }).find((e) => e.type === "agent.spawned")!;
    expect([spawned.cardNum, spawned.data.name]).toEqual([card, "scout"]);
  });

  test("unread counts the inbox past the agent's cursor", () => {
    const { f, slug, card } = fresh();
    f.registerAgent(conductor, slug, scoutOn(card));
    f.say(builder, slug, "@scout one");
    f.say(builder, slug, "@scout two");
    expect(f.agents(slug)[0]!.unread).toBe(2);
    f.markInboxRead(slug, "scout", f.lastSeq(f.board(slug).id));
    expect(f.agents(slug)[0]!.unread).toBe(0);
  });

  test("spawning the same name again replaces the session but keeps what it has not read", () => {
    const { f, slug, card } = fresh();
    f.registerAgent(conductor, slug, scoutOn(card));
    f.updateAgent(slug, "scout", { status: "exited" });
    f.say(builder, slug, "@scout while you were out");
    f.registerAgent(conductor, slug, scoutOn(card, { sessionKey: "claude-code:2222" }));
    const [scout] = f.agents(slug);
    expect([scout!.status, scout!.sessionKey, scout!.unread]).toEqual(["running", "claude-code:2222", 1]);
  });
});

describe("linked directories", () => {
  test("a linked worktree resolves to the spawning board until its card closes", () => {
    const { f, slug, card } = fresh();
    f.linkDir(slug, "/repos/app-card-1", card);
    expect(f.boardForDir("/repos/app-card-1/src")?.slug).toBe(slug);
    f.closeCard(rob, slug, card);
    expect(f.boardForDir("/repos/app-card-1/src")).toBeNull();
  });

  test("a worktree with a board of its own keeps it when nested deeper than a link", () => {
    const { f, slug, card } = fresh();
    f.linkDir(slug, "/repos/wt", card);
    const own = f.createBoard(rob, { title: "Own", project: "/repos/wt/feature" });
    expect(f.boardForDir("/repos/wt/feature")?.slug).toBe(own.slug);
    expect(f.boardForDir("/repos/wt/other")?.slug).toBe(slug);
  });
});

describe("a new agent's inbox", () => {
  test("starts at spawn: what the board said before is in its handoff, not its unread", () => {
    const { f, slug, card } = fresh();
    f.decide(rob, slug, "no new dependencies");
    f.registerAgent(conductor, slug, scoutOn(card));
    expect(f.agents(slug)[0]!.unread).toBe(0);
  });
});
