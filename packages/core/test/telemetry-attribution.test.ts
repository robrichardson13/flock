/**
 * ADR 0027: a card's run is the sessions that *worked* it. A conductor that creates cards,
 * comments on them, asks about them and closes Land cards from its own session is not a worker
 * of any of them, and its transcript must not be what a card's Run block renders.
 */
import { describe, expect, test } from "bun:test";
import { Flock, type Actor } from "../src/index.ts";

const rob: Actor = { name: "rob", kind: "human" };

const conductorSession = "claude-code:ce8d433b-3632-400c-8a1d-6e4004fe62b5";
const conductor: Actor = { name: "conductor", kind: "agent", session: conductorSession };

/** The same Claude Code session, but the write came from a subagent, so the run key names the
 * subagent's own transcript. This is what `refineRunKey` produces at write time. */
const builderSession = `${conductorSession}#a9e6feec4e1969307`;
const builder: Actor = { name: "builder", kind: "agent", model: "opus", session: builderSession };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(rob, { title: "Attribution", body: "" });
  return { f, board };
}

describe("a card's run is its workers' sessions", () => {
  test("a card the conductor only created has no run at all", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Filed, not started" });
    expect(f.sessionsForCard(board.id, c.num)).toEqual([]);
  });

  test("commenting, asking and closing from the conductor's session never links it", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Land: some feature" });
    f.addComment(conductor, board.id, c.num, "PR is up for review");
    f.closeCard(conductor, board.id, c.num, { resolution: "merged" });
    expect(f.sessionsForCard(board.id, c.num)).toEqual([]);
  });

  test("the claimant's session is the run, and the conductor's is not, even sharing one card", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Do the work" });
    f.claimCard(builder, board.id, c.num);
    f.addComment(builder, board.id, c.num, "diagnosed");
    f.closeCard(builder, board.id, c.num, { resolution: "fixed" });

    const runs = f.sessionsForCard(board.id, c.num);
    expect(runs.map((r) => r.key)).toEqual([builderSession]);
    expect(runs[0]!.actor).toBe("builder");
    expect(runs[0]!.declaredModel).toBe("opus");
  });

  test("a conductor comment landing last no longer steals the run's actor and model", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Do the work" });
    f.claimCard(builder, board.id, c.num);
    f.closeCard(builder, board.id, c.num, { resolution: "fixed" });
    // The conductor reviews after the fact — the most recent write on the card by a long way.
    f.addComment(conductor, board.id, c.num, "reviewed, merging");

    const runs = f.sessionsForCard(board.id, c.num);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.actor).toBe("builder");
    expect(runs[0]!.declaredModel).toBe("opus");
  });

  test("the current assignee counts as a worker even with no claim event of its own", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Assigned by hand" });
    f.claimCard(builder, board.id, c.num);
    f.addComment(builder, board.id, c.num, "still mine");

    const runs = f.sessionsForCard(board.id, c.num);
    expect(runs.map((r) => r.key)).toEqual([builderSession]);
  });

  test("a released card keeps the session that worked it in its history", () => {
    const { f, board } = fresh();
    const c = f.createCard(conductor, board.id, { title: "Started then handed back" });
    f.claimCard(builder, board.id, c.num);
    f.releaseCard(builder, board.id, c.num);

    const runs = f.sessionsForCard(board.id, c.num);
    expect(runs.map((r) => r.key)).toEqual([builderSession]);
  });

  test("alsoWorked lists cards the session claimed, not cards it merely commented on", () => {
    const { f, board } = fresh();
    const worked = f.createCard(conductor, board.id, { title: "Worked" });
    const chattedOn = f.createCard(conductor, board.id, { title: "Chatted on" });
    const alsoWorked = f.createCard(conductor, board.id, { title: "Also worked" });

    f.claimCard(builder, board.id, worked.num);
    f.addComment(builder, board.id, chattedOn.num, "drive-by remark");
    f.claimCard(builder, board.id, alsoWorked.num);

    const [run] = f.sessionsForCard(board.id, worked.num);
    expect(run!.alsoWorked).toEqual([alsoWorked.num]);
    // The card it only commented on has no run of its own either.
    expect(f.sessionsForCard(board.id, chattedOn.num)).toEqual([]);
  });

  test("a conductor and a subagent sharing one Claude Code session are two different runs", () => {
    const { f, board } = fresh();
    const conductorCard = f.createCard(conductor, board.id, { title: "Conductor's own card" });
    f.claimCard(conductor, board.id, conductorCard.num);
    const builderCard = f.createCard(conductor, board.id, { title: "Builder's card" });
    f.claimCard(builder, board.id, builderCard.num);

    expect(f.sessionsForCard(board.id, conductorCard.num).map((r) => r.key)).toEqual([conductorSession]);
    expect(f.sessionsForCard(board.id, builderCard.num).map((r) => r.key)).toEqual([builderSession]);
  });
});

describe("an actor's own sessions", () => {
  test("a session still appears on the actor page, but only claimed cards count as worked", () => {
    const { f, board } = fresh();
    const filed = f.createCard(conductor, board.id, { title: "Filed" });
    f.claimCard(conductor, board.id, filed.num);
    const chattedOn = f.createCard(conductor, board.id, { title: "Chatted on" });
    f.addComment(conductor, board.id, chattedOn.num, "a note");

    const sessions = f.sessionsForActor(board.id, "conductor");
    expect(sessions.map((s) => s.key)).toEqual([conductorSession]);
    expect(sessions[0]!.alsoWorked).toEqual([filed.num]);
  });
});
