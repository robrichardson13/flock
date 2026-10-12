import { describe, expect, test } from "bun:test";
import { addressTo, Flock, mentionsActor, parseMentions, type Actor } from "../src/index.ts";

const rob: Actor = { name: "rob", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };
const builder: Actor = { name: "builder", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(rob, { title: "Team" });
  return { f, slug: board.slug };
}

const inboxTypes = (f: Flock, slug: string, actor: string) => f.inbox(slug, actor).events.map((e) => e.type);

describe("parseMentions", () => {
  test("finds names and @all, lowercased, once each", () => {
    expect(parseMentions("@Scout can you look? cc @builder @scout and @all")).toEqual(["scout", "builder", "all"]);
  });

  test("an email address is not a mention, trailing punctuation is not part of the name", () => {
    expect(parseMentions("mail rob@example.com")).toEqual([]);
    expect(parseMentions("thanks @scout. And @builder-2, @a.b")).toEqual(["scout", "builder-2", "a.b"]);
  });

  test("mentionsActor honours @all", () => {
    expect(mentionsActor("@all standup", "scout")).toBe(true);
    expect(mentionsActor("@scouting", "scout")).toBe(false);
  });
});

describe("addressTo", () => {
  test("prefixes recipients the body does not already mention", () => {
    expect(addressTo("ready for review", ["scout", "@builder"])).toBe("@scout @builder ready for review");
    expect(addressTo("@Scout ready", ["scout"])).toBe("@Scout ready");
  });
});

describe("inbox", () => {
  test("a channel message reaches only the actors it mentions", () => {
    const { f, slug } = fresh();
    f.say(builder, slug, "@scout the schema is in");
    f.say(builder, slug, "general update, no mention");
    expect(inboxTypes(f, slug, "scout")).toEqual(["message.posted"]);
    expect(inboxTypes(f, slug, "rob")).toEqual([]);
  });

  test("@all reaches everyone but the author", () => {
    const { f, slug } = fresh();
    f.say(builder, slug, "@all rebase on main");
    expect(inboxTypes(f, slug, "scout")).toEqual(["message.posted"]);
    expect(inboxTypes(f, slug, "builder")).toEqual([]);
  });

  test("others' comments on a card I hold reach me, my own do not", () => {
    const { f, slug } = fresh();
    const card = f.createCard(rob, slug, { title: "Parser" });
    f.claimCard(scout, slug, card.num);
    f.addComment(scout, slug, card.num, "started");
    f.addComment(builder, slug, card.num, "heads up: the lexer moved");
    const inbox = f.inbox(slug, "scout").events;
    expect(inbox.map((e) => e.actor)).toEqual(["builder"]);
  });

  test("a comment on a card I no longer hold does not reach me unless it mentions me", () => {
    const { f, slug } = fresh();
    const card = f.createCard(rob, slug, { title: "Parser" });
    f.claimCard(scout, slug, card.num);
    f.releaseCard(scout, slug, card.num);
    f.addComment(builder, slug, card.num, "picked this up");
    f.addComment(builder, slug, card.num, "@scout why did you stop?");
    expect(f.inbox(slug, "scout").events.map((e) => e.data.body)).toEqual(["@scout why did you stop?"]);
  });

  test("the answer to my question reaches me", () => {
    const { f, slug } = fresh();
    const card = f.createCard(rob, slug, { title: "Parser" });
    f.claimCard(scout, slug, card.num);
    f.askHuman(scout, slug, card.num, "LL or LR?");
    f.answerHuman(rob, slug, card.num, "LL");
    expect(inboxTypes(f, slug, "scout")).toEqual(["card.answered"]);
    expect(inboxTypes(f, slug, "builder")).toEqual([]);
  });

  test("a new decision reaches everyone but its author", () => {
    const { f, slug } = fresh();
    f.decide(rob, slug, "no new dependencies");
    expect(inboxTypes(f, slug, "scout")).toEqual(["decision.recorded"]);
    expect(inboxTypes(f, slug, "rob")).toEqual([]);
  });

  test("since and through let a follower resume without repeats", () => {
    const { f, slug } = fresh();
    f.say(builder, slug, "@scout one");
    const first = f.inbox(slug, "scout");
    f.say(builder, slug, "not for scout");
    f.say(builder, slug, "@scout two");
    const next = f.inbox(slug, "scout", { since: first.through });
    expect(next.events.map((e) => e.data.body)).toEqual(["@scout two"]);
    expect(next.through).toBeGreaterThan(first.through);
  });
});

describe("inbox through", () => {
  test("advances past events that are not inbox candidates, so a follower does not spin", () => {
    const { f, slug } = fresh();
    const card = f.createCard(rob, slug, { title: "Parser" });
    f.claimCard(builder, slug, card.num);
    const { events, through } = f.inbox(slug, "scout");
    expect(events).toEqual([]);
    expect(through).toBe(f.lastSeq(f.board(slug).id));
  });

  test("a full page resumes from its last row, not from the head", () => {
    const { f, slug } = fresh();
    for (const n of [1, 2, 3]) f.say(builder, slug, `@scout ${n}`);
    const page = f.inbox(slug, "scout", { limit: 2 });
    expect(page.events.map((e) => e.data.body)).toEqual(["@scout 1", "@scout 2"]);
    expect(f.inbox(slug, "scout", { since: page.through }).events.map((e) => e.data.body)).toEqual(["@scout 3"]);
  });
});
