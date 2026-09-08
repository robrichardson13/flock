import { describe, expect, test } from "bun:test";
import { Flock, FlockError, boardStateOf, exportBoard, importBoard, parseBoard, type Actor, type CardStatus } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Flock v1", body: "## Destination\nShip it." });
  return { f, board };
}

describe("claim", () => {
  test("is compare-and-swap: second claimant gets a conflict", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Parse markdown" });
    const won = f.claimCard(scout, board.id, c.num);
    expect(won.assignee).toBe("scout");
    expect(won.status).toBe("doing");
    expect(() => f.claimCard(builder, board.id, c.num)).toThrow(FlockError);
    try {
      f.claimCard(builder, board.id, c.num);
    } catch (e) {
      expect((e as FlockError).status).toBe(409);
    }
    // Re-claiming your own card is idempotent.
    expect(f.claimCard(scout, board.id, c.num).assignee).toBe("scout");
  });

  test("refuses a blocked card unless forced", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "A" });
    const b = f.createCard(ada, board.id, { title: "B", blockedBy: [a.num] });
    expect(b.blocked).toBe(true);
    expect(() => f.claimCard(scout, board.id, b.num)).toThrow(/blocked/);
    f.closeCard(scout, board.id, a.num, { resolution: "done it" });
    expect(f.card(board.id, b.num).blocked).toBe(false);
    expect(f.claimCard(scout, board.id, b.num).assignee).toBe("scout");
  });

  test("release puts the card back on the frontier", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "X" });
    f.claimCard(scout, board.id, c.num);
    expect(f.listCards(board.id, { frontier: true })).toHaveLength(0);
    f.releaseCard(scout, board.id, c.num);
    expect(f.listCards(board.id, { frontier: true }).map((c) => c.num)).toEqual([c.num]);
  });
});

describe("reopen", () => {
  test("moving a done card back to todo/doing requires a reason", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Parse markdown" });
    f.closeCard(scout, board.id, c.num, { resolution: "done it" });
    expect(() => f.moveCard(ada, board.id, c.num, "todo")).toThrow(FlockError);
    expect(() => f.moveCard(ada, board.id, c.num, "doing")).toThrow(/reason/);
    expect(() => f.moveCard(ada, board.id, c.num, "todo", { reason: "   " })).toThrow(/reason/);
    // still done: the rejected attempts didn't move it
    expect(f.card(board.id, c.num).status).toBe("done");
  });

  test("a wontfix card reopens the same way", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Parse markdown" });
    f.closeCard(scout, board.id, c.num, { status: "wontfix" });
    expect(() => f.moveCard(ada, board.id, c.num, "todo")).toThrow(FlockError);
    const reopened = f.moveCard(ada, board.id, c.num, "todo", { reason: "actually still needed" });
    expect(reopened.status).toBe("todo");
  });

  test("with a reason, the reopen succeeds, records the reason as a comment, and both events land", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Parse markdown" });
    f.closeCard(scout, board.id, c.num, { resolution: "done it" });
    const moved = f.moveCard(ada, board.id, c.num, "doing", { reason: "the parser still chokes on nested lists" });
    expect(moved.status).toBe("doing");

    const comments = f.comments(board.id, c.num);
    const last = comments[comments.length - 1]!;
    expect(last.body).toBe("the parser still chokes on nested lists");
    expect(last.author).toBe("ada");
    expect(last.kind).toBe("comment");

    const events = f.events({ boardId: board.id }).filter((e) => e.cardNum === c.num);
    const types = events.map((e) => e.type);
    expect(types).toContain("card.moved");
    expect(types).toContain("comment.posted");
    // the move and the comment landed together, back to back
    const movedIdx = events.findIndex((e) => e.type === "card.moved" && (e.data as any).to === "doing");
    expect(events[movedIdx + 1]?.type).toBe("comment.posted");
  });

  test("reason is not required for moves that aren't a reopen", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Parse markdown" });
    expect(f.moveCard(ada, board.id, c.num, "doing").status).toBe("doing");
    expect(f.moveCard(ada, board.id, c.num, "awaiting-human" as CardStatus).status).toBe("awaiting-human");
    const done = f.closeCard(ada, board.id, c.num, { status: "wontfix" });
    expect(done.status).toBe("wontfix");
    // moving a closed card to another closed status isn't a reopen either
    expect(f.moveCard(ada, board.id, c.num, "done").status).toBe("done");
  });
});

describe("frontier", () => {
  test("is open, unblocked, unclaimed, in position order", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "A" });
    const b = f.createCard(ada, board.id, { title: "B", blockedBy: [a.num] });
    const c = f.createCard(ada, board.id, { title: "C" });
    const d = f.createCard(ada, board.id, { title: "D", assignee: "scout" });
    expect(f.listCards(board.id, { frontier: true }).map((x) => x.num)).toEqual([a.num, c.num]);
    f.closeCard(ada, board.id, a.num);
    expect(f.listCards(board.id, { frontier: true }).map((x) => x.num)).toEqual([b.num, c.num]);
    expect(f.snapshot(board.id).frontier).toEqual([b.num, c.num]);
    void d;
  });
});

describe("human in the loop", () => {
  test("ask parks the card; answer hands it back to the holder", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Pick a DB" });
    f.claimCard(scout, board.id, c.num);
    const asked = f.askHuman(scout, board.id, c.num, "SQLite or Postgres?");
    expect(asked.status).toBe("awaiting-human");
    expect(asked.question).toBe("SQLite or Postgres?");
    expect(f.needsHuman().map((x) => x.num)).toEqual([c.num]);
    expect(() => f.answerHuman(ada, board.id, 99, "x")).toThrow(/No card/);
    const answered = f.answerHuman(ada, board.id, c.num, "SQLite.");
    expect(answered.status).toBe("doing");
    expect(answered.assignee).toBe("scout");
    expect(answered.question).toBeNull();
    expect(f.comments(board.id, c.num).map((x) => x.kind)).toEqual(["question", "answer"]);
    expect(f.needsHuman()).toHaveLength(0);
  });
});

describe("events", () => {
  test("are monotonic and filterable by board and since", async () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });
    const c = f.createCard(ada, board.id, { title: "A" });
    f.createCard(ada, other.id, { title: "B" });
    f.claimCard(scout, board.id, c.num);
    const all = f.events();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    const mine = f.events({ boardId: board.id });
    expect(mine.map((e) => e.type)).toEqual(["board.created", "card.created", "card.claimed"]);
    const since = f.events({ boardId: board.id, since: mine[1].seq });
    expect(since.map((e) => e.type)).toEqual(["card.claimed"]);
    const waited = await f.waitForEvents({ boardId: board.id, since: f.lastSeq(), timeoutMs: 50, intervalMs: 10 });
    expect(waited).toEqual([]);
  });

  test("tail returns the last N events for a board in ascending order, unaffected by another board's seqs", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });
    // Interleave writes on another board so this board's seqs are sparse in the global range.
    for (let i = 0; i < 20; i++) f.createCard(ada, other.id, { title: `Other ${i}` });
    const c = f.createCard(ada, board.id, { title: "A" });
    f.claimCard(scout, board.id, c.num);
    f.addComment(scout, board.id, c.num, "progress");

    const all = f.events({ boardId: board.id });
    expect(all.map((e) => e.type)).toEqual(["board.created", "card.created", "card.claimed", "comment.posted"]);

    const tailed = f.events({ boardId: board.id, tail: true, limit: 2 });
    expect(tailed.map((e) => e.type)).toEqual(["card.claimed", "comment.posted"]);
    expect(tailed.map((e) => e.seq)).toEqual([...tailed.map((e) => e.seq)].sort((a, b) => a - b));

    const tailedAll = f.events({ boardId: board.id, tail: true, limit: 50 });
    expect(tailedAll.map((e) => e.type)).toEqual(all.map((e) => e.type));
  });
});

describe("markdown", () => {
  test("round-trips a board", () => {
    const { f, board } = fresh();
    const a = f.createCard(ada, board.id, { title: "Schema", labels: ["wayfinder:grilling"], body: "Decide the schema.\nTwo lines." });
    const b = f.createCard(ada, board.id, { title: "API", blockedBy: [a.num], labels: ["ready-for-agent"] });
    f.claimCard(scout, board.id, a.num);
    f.askHuman(scout, board.id, a.num, "One table or two?");
    f.closeCard(ada, board.id, b.num, { status: "wontfix" });
    f.decide(ada, board.id, "SQLite is the truth", a.num);

    const md = exportBoard(f, board.id);
    expect(md).toContain("# Flock v1");
    expect(md).toContain("## Destination");
    expect(md).toContain("- #1: SQLite is the truth");
    expect(md).toContain("- [ ] #1 Schema @scout [wayfinder:grilling]");
    expect(md).toContain("  > ? One table or two?");
    expect(md).toContain("- [x] #2 API [ready-for-agent] (blocked by #1)");

    const parsed = parseBoard(md);
    expect(parsed.title).toBe("Flock v1");
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0]).toMatchObject({ num: 1, title: "Schema", assignee: "scout", labels: ["wayfinder:grilling"], status: "awaiting-human", question: "One table or two?", body: "Decide the schema.\nTwo lines." });
    expect(parsed.cards[1]).toMatchObject({ num: 2, title: "API", status: "wontfix", blockedBy: [1] });

    const g = new Flock(":memory:");
    const imported = importBoard(g, ada, md);
    const snap = g.snapshot(imported.id);
    expect(snap.board.body).toContain("Ship it.");
    expect(snap.cards.map((c) => [c.num, c.title, c.status, c.assignee, c.blockedBy])).toEqual([
      [1, "Schema", "awaiting-human", "scout", []],
      [2, "API", "wontfix", null, [1]],
    ]);
    expect(snap.decisions[0]).toMatchObject({ gist: "SQLite is the truth", cardNum: 1 });
    expect(exportBoard(g, imported.id)).toBe(md);
  });

  test("parses a hand-written board", () => {
    const parsed = parseBoard(`# Plan\n\nGoal text.\n\n## Todo\n- [ ] First thing\n- [ ] Second thing [research]\n## Done\n- [x] Setup\n`);
    expect(parsed.body).toBe("Goal text.");
    expect(parsed.cards.map((c) => [c.title, c.status, c.labels])).toEqual([
      ["First thing", "todo", []],
      ["Second thing", "todo", ["research"]],
      ["Setup", "done", []],
    ]);
  });
});

describe("boards", () => {
  test("slugs dedupe and lookup works by id, slug, or title", () => {
    const f = new Flock(":memory:");
    const a = f.createBoard(ada, { title: "My Board" });
    const b = f.createBoard(ada, { title: "My Board" });
    expect(a.slug).toBe("my-board");
    expect(b.slug).toBe("my-board-2");
    expect(f.board(a.id).id).toBe(a.id);
    expect(f.board("my-board").id).toBe(a.id);
    expect(f.board("My Board").id).toBe(a.id);
    expect(() => f.board("nope")).toThrow(/No board/);
  });
});

describe("deleteBoard", () => {
  /** Fill one board with a row in every table that hangs off a board. */
  function populate(f: Flock, title: string) {
    const board = f.createBoard(ada, { title });
    const a = f.createCard(ada, board.id, { title: `${title} A` });
    const b = f.createCard(ada, board.id, { title: `${title} B`, blockedBy: [a.num] });
    f.claimCard(scout, board.id, a.num);
    f.addComment(scout, board.id, b.num, "on it");
    f.decide(ada, board.id, "ship it", b.num);
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const att = f.attach(scout, board.id, { mime: "image/png", bytes: png, name: "shot.png" });
    f.say(ada, board.id, "hello", { attachments: [att.id] });
    return board;
  }

  const countFor = (f: Flock, boardId: string) => ({
    boards: (f.db.query("SELECT COUNT(*) AS n FROM boards WHERE id = ?").get(boardId) as { n: number }).n,
    cards: (f.db.query("SELECT COUNT(*) AS n FROM cards WHERE board_id = ?").get(boardId) as { n: number }).n,
    blockers: (
      f.db
        .query("SELECT COUNT(*) AS n FROM card_blockers WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)")
        .get(boardId) as { n: number }
    ).n,
    comments: (
      f.db.query("SELECT COUNT(*) AS n FROM comments WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)").get(boardId) as {
        n: number;
      }
    ).n,
    messages: (f.db.query("SELECT COUNT(*) AS n FROM messages WHERE board_id = ?").get(boardId) as { n: number }).n,
    decisions: (f.db.query("SELECT COUNT(*) AS n FROM decisions WHERE board_id = ?").get(boardId) as { n: number }).n,
    attachments: (f.db.query("SELECT COUNT(*) AS n FROM attachments WHERE board_id = ?").get(boardId) as { n: number }).n,
    events: (f.db.query("SELECT COUNT(*) AS n FROM events WHERE board_id = ?").get(boardId) as { n: number }).n,
  });

  test("empties every board-scoped table and leaves other boards untouched", () => {
    const f = new Flock(":memory:");
    const doomed = populate(f, "Doomed");
    const keeper = populate(f, "Keeper");

    const before = countFor(f, keeper.id);
    // Every table has something in it, so the assertion below is not vacuous.
    for (const [table, n] of Object.entries(countFor(f, doomed.id))) expect(`${table}=${n > 0}`).toBe(`${table}=true`);

    const result = f.deleteBoard(ada, doomed.slug);
    expect(result).toEqual({ slug: "doomed", cards: 2 });

    expect(countFor(f, doomed.id)).toEqual({ boards: 0, cards: 0, blockers: 0, comments: 0, messages: 0, decisions: 0, attachments: 0, events: 0 });
    expect(countFor(f, keeper.id)).toEqual(before);
    expect(f.findBoard("doomed")).toBeNull();
    expect(f.listBoards().map((b) => b.slug)).toEqual(["keeper"]);
    expect(f.board(keeper.id).slug).toBe("keeper");
  });

  test("frees the project directory for a new board", () => {
    const f = new Flock(":memory:");
    const first = f.createBoard(ada, { title: "First", project: "/tmp/proj" });
    f.deleteBoard(ada, first.slug);
    const second = f.createBoard(ada, { title: "Second", project: "/tmp/proj" });
    expect(second.project).toBe("/tmp/proj");
  });

  test("unknown board throws the same not-found as the other methods", () => {
    const f = new Flock(":memory:");
    expect(() => f.deleteBoard(ada, "nope")).toThrow(FlockError);
    try {
      f.deleteBoard(ada, "nope");
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
      expect((e as FlockError).status).toBe(404);
      expect((e as FlockError).message).toMatch(/No board/);
    }
  });
});

describe("runtime", () => {
  test("harness/model/effort land on the event and cache onto the actor row", () => {
    const { f, board } = fresh();
    const scoutOpus: Actor = { name: "scout", kind: "agent", harness: "claude-code@2.1.261", model: "opus-5", effort: "high" };
    const c = f.createCard(scoutOpus, board.id, { title: "X" });
    const events = f.events({ boardId: board.id });
    const created = events.find((e) => e.type === "card.created")!;
    expect(created.harness).toBe("claude-code@2.1.261");
    expect(created.model).toBe("opus-5");
    expect(created.effort).toBe("high");
    void c;

    const actor = f.listActors().find((a) => a.name === "scout")!;
    expect(actor.harness).toBe("claude-code@2.1.261");
    expect(actor.model).toBe("opus-5");
    expect(actor.effort).toBe("high");
  });

  test("a runtime-less write does not clobber a known model on the actor row", () => {
    const { f, board } = fresh();
    const scoutOpus: Actor = { name: "scout", kind: "agent", model: "opus-5" };
    const scoutBare: Actor = { name: "scout", kind: "agent" };
    f.createCard(scoutOpus, board.id, { title: "X" });
    const c2 = f.createCard(scoutBare, board.id, { title: "Y" });
    void c2;

    const actor = f.listActors().find((a) => a.name === "scout")!;
    expect(actor.model).toBe("opus-5");

    const events = f.events({ boardId: board.id });
    const secondCreate = events.filter((e) => e.type === "card.created")[1]!;
    expect(secondCreate.model).toBeUndefined();
  });

  test("touchActor with a model, then touchActor without one, retains the model", () => {
    const { f } = fresh();
    f.touchActor({ name: "scout", kind: "agent", model: "opus-5" });
    f.touchActor({ name: "scout", kind: "agent" });
    const actor = f.listActors().find((a) => a.name === "scout")!;
    expect(actor.model).toBe("opus-5");
  });

  test("an actor with no runtime stays null through claim and close", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "X" });
    f.claimCard(scout, board.id, c.num);
    f.closeCard(scout, board.id, c.num, { resolution: "done" });
    const actor = f.listActors().find((a) => a.name === "scout")!;
    expect(actor.harness).toBeUndefined();
    expect(actor.model).toBeUndefined();
    expect(actor.effort).toBeUndefined();
  });
});

describe("projects", () => {
  test("one active board per directory; subdirectories and worktrees resolve to the nearest board", () => {
    const f = new Flock(":memory:");
    const repo = f.createBoard(ada, { title: "Repo", project: "/tmp/x/repos/app/" });
    const wt = f.createBoard(ada, { title: "Feature worktree", project: "/tmp/x/repos/app/.worktrees/feat" });
    expect(repo.project).toBe("/tmp/x/repos/app");
    expect(() => f.createBoard(ada, { title: "Dup", project: "/tmp/x/repos/app" })).toThrow(/already has a board/);
    expect(f.boardForDir("/tmp/x/repos/app/src/lib")?.id).toBe(repo.id);
    expect(f.boardForDir("/tmp/x/repos/app/.worktrees/feat/src")?.id).toBe(wt.id);
    expect(f.boardForDir("/tmp/x/repos/other")).toBeNull();
    expect(f.boardForDir("/tmp/x/repos/application")).toBeNull();
    // Archiving frees the directory for a fresh board.
    f.updateBoard(ada, repo.id, { status: "archived" });
    expect(f.boardForDir("/tmp/x/repos/app")).toBeNull();
    const again = f.createBoard(ada, { title: "Repo round 2", project: "/tmp/x/repos/app" });
    expect(f.boardForDir("/tmp/x/repos/app")?.id).toBe(again.id);
    expect(f.listBoards({ project: "/tmp/x/repos/app" }).map((b) => b.id)).toEqual([again.id]);
  });
});

describe("board team", () => {
  test("snapshot lists everyone who wrote on this board, board-scoped and newest first", () => {
    const f = new Flock(":memory:");
    const a = f.createBoard(ada, { title: "A" });
    const b = f.createBoard(ada, { title: "B" });
    const c1 = f.createCard(ada, a.id, { title: "One" });
    f.claimCard({ ...scout, model: "opus-5", harness: "claude-code@2.1.0", effort: "high" }, a.id, c1.num);
    // builder writes only on the other board, so it must not appear in A's team.
    const c2 = f.createCard(ada, b.id, { title: "Two" });
    f.claimCard(builder, b.id, c2.num);

    const team = f.snapshot(a.slug).team;
    expect(team.map((m) => m.name).sort()).toEqual(["ada", "scout"]);
    // scout wrote last, so it leads.
    expect(team[0].name).toBe("scout");
    expect(team[0].kind).toBe("agent");
    expect(team[0].model).toBe("opus-5");
    expect(team[0].harness).toBe("claude-code@2.1.0");
    expect(team[0].effort).toBe("high");
    expect(team[0].events).toBe(1);
    const human = team.find((m) => m.name === "ada")!;
    expect(human.kind).toBe("human");
    expect(human.model).toBeUndefined();
    // board.created + two card.created on A.
    expect(human.events).toBe(2);
    expect(f.snapshot(b.slug).team.map((m) => m.name).sort()).toEqual(["ada", "builder"]);
  });

  test("a later runtime-less write does not erase the model shown for that actor", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "One" });
    f.claimCard({ ...scout, model: "opus-5" }, board.id, c.num);
    f.addComment(scout, board.id, c.num, "no runtime on this one");
    const scoutRow = f.snapshot(board.slug).team.find((m) => m.name === "scout")!;
    expect(scoutRow.model).toBe("opus-5");
    expect(scoutRow.events).toBe(2);
  });
});

describe("actorProfile", () => {
  test("lists every card an actor touched, with the roles and no claim limit", () => {
    const { f, board } = fresh();
    const held1 = f.createCard(ada, board.id, { title: "One" });
    const held2 = f.createCard(ada, board.id, { title: "Two" });
    const spoke = f.createCard(ada, board.id, { title: "Three" });
    const closed = f.createCard(ada, board.id, { title: "Four" });
    const theirs = f.createCard(scout, board.id, { title: "Five" });
    f.createCard(ada, board.id, { title: "Untouched" });

    // Nothing stops one actor holding several cards at once.
    f.claimCard({ ...scout, model: "opus-5" }, board.id, held1.num);
    f.claimCard(scout, board.id, held2.num);
    f.addComment(scout, board.id, spoke.num, "looked at this");
    f.claimCard(scout, board.id, closed.num);
    expect(f.listCards(board.id, { assignee: "scout", status: "doing" }).length).toBe(3);
    f.closeCard(scout, board.id, closed.num, { resolution: "shipped" });

    const p = f.actorProfile(board.slug, "scout");
    expect(p.kind).toBe("agent");
    expect(p.model).toBe("opus-5");
    expect(p.lastSeen).not.toBeNull();
    expect(p.events).toBeGreaterThan(0);

    const by = new Map(p.cards.map((c) => [c.num, c]));
    expect([...by.keys()].sort((a, b) => a - b)).toEqual([held1.num, held2.num, spoke.num, closed.num, theirs.num].sort((a, b) => a - b));
    expect(by.get(held1.num)!.roles).toEqual(["holding", "claimed"]);
    expect(by.get(held1.num)!.status).toBe("doing");
    expect(by.get(spoke.num)!.roles).toEqual(["commented"]);
    // Closing leaves the assignee in place and writes the resolution as a comment.
    expect(by.get(closed.num)!.roles).toEqual(["holding", "claimed", "commented", "resolved"]);
    expect(by.get(closed.num)!.status).toBe("done");
    // A card they opened but never claimed still lists, as theirs to have made.
    expect(by.get(theirs.num)!.roles).toEqual(["created"]);
    // Newest touch first.
    expect(p.cards[0].num).toBe(closed.num);
  });

  test("counts a card handed over with no event of the assignee's own, and is board-scoped", () => {
    const f = new Flock(":memory:");
    const a = f.createBoard(ada, { title: "A" });
    const b = f.createBoard(ada, { title: "B" });
    const given = f.createCard(ada, a.id, { title: "Handed over" });
    f.assignCard(ada, a.id, given.num, "builder");
    const elsewhere = f.createCard(ada, b.id, { title: "Other board" });
    f.claimCard(builder, b.id, elsewhere.num);

    const p = f.actorProfile(a.slug, "builder");
    expect(p.cards.map((c) => c.num)).toEqual([given.num]);
    expect(p.cards[0].roles).toEqual(["holding"]);
    // builder has written nothing on A, so this board has never seen them.
    expect(p.lastSeen).toBeNull();
    expect(p.events).toBe(0);
  });

  test("an actor the board has never seen is not found", () => {
    const { f, board } = fresh();
    expect(() => f.actorProfile(board.slug, "ghost")).toThrow(FlockError);
    try {
      f.actorProfile(board.slug, "ghost");
    } catch (e) {
      expect((e as FlockError).status).toBe(404);
    }
  });
});

function zeroCounts(overrides: Partial<Record<CardStatus, number>> = {}): Record<CardStatus, number> {
  return { todo: 0, doing: 0, "awaiting-human": 0, done: 0, wontfix: 0, ...overrides };
}

describe("board summaries", () => {
  test("boardStateOf: awaiting beats working beats idle", () => {
    expect(boardStateOf(zeroCounts({ "awaiting-human": 1, doing: 2, todo: 3 }), "active")).toBe("awaiting");
    expect(boardStateOf(zeroCounts({ doing: 1, todo: 3 }), "active")).toBe("working");
    expect(boardStateOf(zeroCounts({ todo: 3 }), "active")).toBe("idle");
  });

  test("boardStateOf: zero cards is idle", () => {
    expect(boardStateOf(zeroCounts(), "active")).toBe("idle");
  });

  test("boardStateOf: all closed, including a wontfix, is complete", () => {
    expect(boardStateOf(zeroCounts({ done: 2, wontfix: 1 }), "active")).toBe("complete");
  });

  test("boardStateOf: archived wins over any counts", () => {
    expect(boardStateOf(zeroCounts({ "awaiting-human": 1 }), "archived")).toBe("archived");
    expect(boardStateOf(zeroCounts(), "archived")).toBe("archived");
  });

  test("doing lists the cards being worked, most recently updated first, capped at 3", () => {
    const { f, board } = fresh();
    const nums = [1, 2, 3, 4].map((i) => f.createCard(ada, board.id, { title: `Card ${i}` }).num);
    for (const n of nums) f.claimCard(scout, board.id, n);
    f.createCard(ada, board.id, { title: "Todo only" });
    const s = f.boardSummaries().find((b) => b.id === board.id)!;
    expect(s.doing.map((c) => c.num)).toEqual([4, 3, 2]);
    expect(s.doing[0]).toEqual({ num: 4, title: "Card 4", assignee: "scout" });
  });

  test("doing is empty on a board with nothing in progress", () => {
    const { f, board } = fresh();
    f.createCard(ada, board.id, { title: "Waiting" });
    expect(f.boardSummaries().find((b) => b.id === board.id)!.doing).toEqual([]);
  });

  test("orders by state rank, then recency within a rank", () => {
    const f = new Flock(":memory:");
    const awaiting = f.createBoard(ada, { title: "Awaiting board" });
    const working = f.createBoard(ada, { title: "Working board" });
    const idle = f.createBoard(ada, { title: "Idle board" });
    const complete = f.createBoard(ada, { title: "Complete board" });

    const aCard = f.createCard(ada, awaiting.id, { title: "Ask" });
    f.claimCard(scout, awaiting.id, aCard.num);
    f.askHuman(scout, awaiting.id, aCard.num, "Which way?");

    const wCard = f.createCard(ada, working.id, { title: "Work" });
    f.claimCard(scout, working.id, wCard.num);

    f.createCard(ada, idle.id, { title: "Todo" });

    const cCard = f.createCard(ada, complete.id, { title: "Done" });
    f.closeCard(ada, complete.id, cCard.num);

    expect(f.boardSummaries().map((b) => b.slug)).toEqual([awaiting.slug, working.slug, idle.slug, complete.slug]);

    // A message on the idle board (recency) must not overtake the working board (rank beats recency).
    f.say(ada, idle.id, "hello");
    expect(f.boardSummaries().map((b) => b.slug)).toEqual([awaiting.slug, working.slug, idle.slug, complete.slug]);

    // Two working boards order by most recent event first.
    const working2 = f.createBoard(ada, { title: "Working board 2" });
    const w2Card = f.createCard(ada, working2.id, { title: "Work 2" });
    f.claimCard(scout, working2.id, w2Card.num);
    f.say(ada, working.id, "still going");
    const order = f.boardSummaries().map((b) => b.slug);
    expect(order.indexOf(working.slug)).toBeLessThan(order.indexOf(working2.slug));
  });

  test("tie-break: identical state and no events beyond creation orders by title", () => {
    const f = new Flock(":memory:");
    const z = f.createBoard(ada, { title: "Zeta" });
    const a = f.createBoard(ada, { title: "Alpha" });
    // Force identical lastActivityAt so the title tie-break is exercised.
    f.db.query("UPDATE boards SET updated_at = ?").run("2026-01-01T00:00:00.000Z");
    f.db.query("UPDATE events SET created_at = ?").run("2026-01-01T00:00:00.000Z");
    expect(f.boardSummaries().map((b) => b.slug)).toEqual([a.slug, z.slug]);
  });

  test("fields: counts, open/total, lastEvent, lastActivityAt, team", () => {
    const { f, board } = fresh();
    const c1 = f.createCard(ada, board.id, { title: "One" });
    f.claimCard(scout, board.id, c1.num);
    f.createCard(ada, board.id, { title: "Two" });

    const summary = f.boardSummaries().find((b) => b.id === board.id)!;
    const snap = f.snapshot(board.id);
    expect(summary.counts).toEqual(snap.counts);
    expect(summary.open).toBe(summary.counts.todo + summary.counts.doing + summary.counts["awaiting-human"]);
    expect(summary.total).toBe(Object.values(summary.counts).reduce((a, b) => a + b, 0));
    expect(summary.lastEvent).not.toBeNull();
    expect(summary.lastEvent!.type).toBe("card.created");
    expect(summary.lastActivityAt).toBe(summary.lastEvent!.createdAt);
    expect(summary.team.length).toBeLessThanOrEqual(5);
    // ada wrote last (creating card "Two"), so ada leads the team.
    expect(summary.team[0].name).toBe("ada");
  });

  test("a board of only wontfix cards is complete and counts n/n", () => {
    const { f, board } = fresh();
    const c = f.createCard(ada, board.id, { title: "Never" });
    f.closeCard(ada, board.id, c.num, { status: "wontfix" });
    const s = f.boardSummaries().find((b) => b.id === board.id)!;
    expect(s.state).toBe("complete");
    expect(s.total).toBe(1);
    expect(s.open).toBe(0);
    expect(s.counts.wontfix + s.counts.done).toBe(s.total);
  });

  test("a board whose only event is its creation still has a lastEvent", () => {
    const { f, board } = fresh();
    const s = f.boardSummaries().find((b) => b.id === board.id)!;
    expect(s.total).toBe(0);
    expect(s.state).toBe("idle");
    expect(s.lastEvent!.type).toBe("board.created");
    expect(s.lastActivityAt).toBe(s.lastEvent!.createdAt);
  });

  test("a board whose latest event is board.updated reports it with no card", () => {
    const { f, board } = fresh();
    f.updateBoard(ada, board.id, { body: "a brief" });
    const s = f.boardSummaries().find((b) => b.id === board.id)!;
    expect(s.lastEvent!.type).toBe("board.updated");
    expect(s.lastEvent!.cardNum).toBeNull();
  });

  test("team is capped at 5 of ten writers, most recent first", () => {
    const { f, board } = fresh();
    for (let i = 0; i < 10; i++) f.say({ name: `a${i}`, kind: "agent" }, board.id, "hi");
    const s = f.boardSummaries().find((b) => b.id === board.id)!;
    expect(s.team.map((m) => m.name)).toEqual(["a9", "a8", "a7", "a6", "a5"]);
  });

  test("an archived board with an awaiting card still ranks archived and last", () => {
    const { f, board } = fresh();
    const archived = f.createBoard(ada, { title: "Archived but asking" });
    const c = f.createCard(ada, archived.id, { title: "Ask" });
    f.claimCard(scout, archived.id, c.num);
    f.askHuman(scout, archived.id, c.num, "Which way?");
    f.updateBoard(ada, archived.id, { status: "archived" });

    expect(f.boardSummaries().map((b) => b.id)).not.toContain(archived.id);
    const all = f.boardSummaries({ includeArchived: true });
    expect(all.find((b) => b.id === archived.id)!.state).toBe("archived");
    expect(all[all.length - 1].id).toBe(archived.id);
    void board;
  });

  test("archived boards are absent by default, present and last with includeArchived", () => {
    const { f, board } = fresh();
    const archived = f.createBoard(ada, { title: "Old board" });
    f.updateBoard(ada, archived.id, { status: "archived" });

    expect(f.boardSummaries().map((b) => b.slug)).not.toContain(archived.slug);
    const all = f.boardSummaries({ includeArchived: true });
    expect(all.map((b) => b.slug)).toContain(archived.slug);
    expect(all[all.length - 1].slug).toBe(archived.slug);
    void board;
  });
});
