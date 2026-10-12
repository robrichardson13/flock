import { expect, test } from "bun:test";
import { Flock, type Actor, type Agent, type NewAgent } from "@flock/core";
import { deliverUnread, gateOpenUrl } from "./agents.ts";

const rob: Actor = { name: "rob", kind: "human" };
const builder: Actor = { name: "builder", kind: "agent" };

function boardWith(...agents: Partial<NewAgent>[]) {
  const f = new Flock(":memory:");
  const board = f.createBoard(rob, { title: "Team" });
  const card = f.createCard(rob, board.slug, { title: "Parser" });
  for (const a of agents) {
    f.registerAgent(rob, board.slug, {
      name: "scout", cardNum: card.num, harness: "codex", model: "gpt-6", effort: null, sessionKey: "codex:t1",
      openUrl: null, cwd: "/repos/app", pid: null, launcher: "/bin/launch", ...a,
    });
  }
  return { f, slug: board.slug };
}

function recorder(reply = true) {
  const sent: { name: string; message: string }[] = [];
  const deliver = async (agent: Agent, _board: string, message: string) => {
    sent.push({ name: agent.name, message });
    return reply;
  };
  return { sent, deliver };
}

test("a push-only worker gets its unread inbox once, as one message", async () => {
  const { f, slug } = boardWith({});
  f.say(builder, slug, "@scout schema is in");
  f.decide(rob, slug, "no new dependencies");
  const { sent, deliver } = recorder();
  await deliverUnread(f, deliver);
  await deliverUnread(f, deliver);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message).toContain("builder in the channel (m1): @scout schema is in");
  expect(sent[0]!.message).toContain("rob decided (d1): no new dependencies");
  expect(f.agents(slug)[0]!.unread).toBe(0);
});

test("an undelivered inbox stays unread for the next tick", async () => {
  const { f, slug } = boardWith({});
  f.say(builder, slug, "@scout ping");
  await deliverUnread(f, recorder(false).deliver);
  expect(f.agents(slug)[0]!.unread).toBe(1);
});

test("Claude Code workers and exited workers are left to pull", async () => {
  const { f, slug } = boardWith({ harness: "claude-code" }, { name: "gone" });
  f.updateAgent(slug, "gone", { status: "exited" });
  f.say(builder, slug, "@all standup");
  const { sent, deliver } = recorder();
  await deliverUnread(f, deliver);
  expect(sent).toEqual([]);
});

test("a non-web openUrl is shown to loopback only", () => {
  expect(gateOpenUrl({ openUrl: "x-ide://tab/1" }, false).openUrl).toBeNull();
  expect(gateOpenUrl({ openUrl: "x-ide://tab/1" }, true).openUrl).toBe("x-ide://tab/1");
  expect(gateOpenUrl({ openUrl: "https://host/s/1" }, false).openUrl).toBe("https://host/s/1");
});
