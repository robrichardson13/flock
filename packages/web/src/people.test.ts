import { describe, expect, test } from "bun:test";
import { ACTIVE_WINDOW_MS, avatarColor, avatarTintIndex, groupActorCards, groupRoster, hashName, heldCard, initialsOf, isActive, isWorking, presenceOf, rolesCaption, rosterCaption, rosterCounts, rosterGroupOf, SEEN_WINDOW_MS, sharedRoles, shortAge } from "./people.ts";
import { movedIds } from "./live.ts";

describe("avatar identity", () => {
  test("initials come from word boundaries, or the first two letters of one word", () => {
    expect(initialsOf("scroll-fix")).toBe("SF");
    expect(initialsOf("rob")).toBe("RO");
    expect(initialsOf("Matt Pocock")).toBe("MP");
    expect(initialsOf("alive-board-agent")).toBe("AB");
    expect(initialsOf("x")).toBe("X");
    expect(initialsOf("!!")).toBe("?");
  });

  test("colour is a pure function of the name and the kind", () => {
    expect(avatarColor("scout")).toBe(avatarColor("scout"));
    expect(hashName("scout")).toBe(hashName("scout"));
    // A palette token, not a free HSL chip: the palette owns the hue, the name owns the slot.
    expect(avatarColor("anything")).toMatch(/^var\(--id-agent-[1-5]\)$/);
    expect(avatarColor("anything", "human")).toMatch(/^var\(--id-human-[1-5]\)$/);
  });

  test("kind decides the family, so cool is a machine and warm is a person", () => {
    for (const n of ["conductor", "rob", "auditor", "matt pocock", "scout"]) {
      expect(avatarColor(n, "agent")).toContain("--id-agent-");
      expect(avatarColor(n, "human")).toContain("--id-human-");
    }
  });

  test("the five slots are all reachable, so a board of agents is not one colour", () => {
    const names = ["conductor", "auditor", "colorist", "designer", "scout", "builder", "router", "tester", "worker-1", "worker-2", "dev-5", "writer-flow"];
    expect(new Set(names.map((n) => avatarTintIndex(n))).size).toBeGreaterThan(1);
    expect(names.every((n) => avatarTintIndex(n) >= 1 && avatarTintIndex(n) <= 5)).toBe(true);
  });
});

describe("recency", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test("ages read in one or two characters", () => {
    expect(shortAge(ago(5_000), now)).toBe("now");
    expect(shortAge(ago(3 * 60_000), now)).toBe("3m");
    expect(shortAge(ago(2 * 3_600_000), now)).toBe("2h");
    expect(shortAge(ago(4 * 86_400_000), now)).toBe("4d");
  });

  test("active means a write inside the window", () => {
    expect(isActive(ago(ACTIVE_WINDOW_MS - 1000), now)).toBe(true);
    expect(isActive(ago(ACTIVE_WINDOW_MS + 1000), now)).toBe(false);
  });
});

describe("section moves", () => {
  const map = (o: Record<string, string>) => new Map(Object.entries(o));

  test("only a card present on both sides in a different section counts as a move", () => {
    const before = map({ a: "todo", b: "doing", c: "todo" });
    const after = map({ a: "doing", b: "doing", d: "todo" });
    expect([...movedIds(before, after)]).toEqual(["a"]);
  });

  test("the first commit moves nothing, so a cold load never animates", () => {
    expect(movedIds(null, map({ a: "todo", b: "doing" })).size).toBe(0);
  });

  test("a card that leaves the board is not a move", () => {
    expect(movedIds(map({ a: "todo" }), map({})).size).toBe(0);
  });
});

describe("working vs idle presence", () => {
  const cards = [
    { assignee: "scout", status: "doing" },
    { assignee: "rob", status: "todo" },
    { assignee: "scroll", status: "done" },
  ];

  test("holding a doing card is working", () => {
    expect(isWorking("scout", cards)).toBe(true);
  });

  test("holding a card that isn't doing, or holding nothing, is idle", () => {
    expect(isWorking("rob", cards)).toBe(false);
    expect(isWorking("scroll", cards)).toBe(false);
    expect(isWorking("nobody", cards)).toBe(false);
  });
});

describe("presenceOf", () => {
  const NOW = Date.parse("2026-09-06T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const cards = [
    { assignee: "scout", status: "doing" },
    { assignee: "rob", status: "todo" },
  ];

  test("holding a doing card is working, however long ago they last wrote", () => {
    expect(presenceOf({ name: "scout", lastSeen: ago(9 * 24 * 60 * 60 * 1000) }, cards, NOW)).toBe("working");
  });

  test("holding nothing but seen inside the window is idle", () => {
    expect(presenceOf({ name: "rob", lastSeen: ago(30 * 60 * 1000) }, cards, NOW)).toBe("idle");
  });

  test("idle reaches well past the 'here right now' window the stack orders by", () => {
    const lastSeen = ago(ACTIVE_WINDOW_MS + 60_000);
    expect(isActive(lastSeen, NOW)).toBe(false);
    expect(presenceOf({ name: "rob", lastSeen }, cards, NOW)).toBe("idle");
  });

  test("not seen inside the window gets no dot at all", () => {
    expect(presenceOf({ name: "rob", lastSeen: ago(SEEN_WINDOW_MS + 1) }, cards, NOW)).toBeUndefined();
  });

  test("the boundary is exclusive, so the dot goes out rather than lingering", () => {
    expect(presenceOf({ name: "rob", lastSeen: ago(SEEN_WINDOW_MS) }, cards, NOW)).toBeUndefined();
    expect(presenceOf({ name: "rob", lastSeen: ago(SEEN_WINDOW_MS - 1) }, cards, NOW)).toBe("idle");
  });

  test("a card assigned to someone else does not make you working", () => {
    expect(presenceOf({ name: "someone-else", lastSeen: ago(1000) }, cards, NOW)).toBe("idle");
  });
});

describe("actor card groups", () => {
  test("doing holds what is still in their hands, done what is finished", () => {
    const cards = [
      { num: 1, status: "doing" },
      { num: 2, status: "awaiting-human" },
      { num: 3, status: "done" },
      { num: 4, status: "wontfix" },
      { num: 5, status: "todo" },
    ];
    const g = groupActorCards(cards);
    expect(g.doing.map((c) => c.num)).toEqual([1, 2]);
    expect(g.done.map((c) => c.num)).toEqual([3, 4]);
    expect(g.other.map((c) => c.num)).toEqual([5]);
  });

  test("the caption says why the card is listed, never that they hold it", () => {
    expect(rolesCaption(["holding", "claimed"])).toBe("claimed");
    expect(rolesCaption(["claimed", "commented", "resolved"])).toBe("claimed · commented · resolved");
    expect(rolesCaption(["holding"])).toBe("");
  });
});

/* ---------- the roster (#31) ---------- */

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const CARDS = [
  { num: 31, title: "Roster and actor view", assignee: "builder-31", status: "doing" },
  { num: 12, title: "Board view feels busy", assignee: "rob", status: "awaiting-human" },
  { num: 9, title: "Kanban clips at 1440", assignee: "builder-9", status: "done" },
  { num: 32, title: "No fold on mobile", assignee: null, status: "todo" },
];

describe("roster grouping", () => {
  test("working holds a doing card, waiting an awaiting-human one, idle neither", () => {
    expect(rosterGroupOf("builder-31", CARDS)).toBe("working");
    expect(rosterGroupOf("rob", CARDS)).toBe("waiting");
    // A closed card is not something anyone is on.
    expect(rosterGroupOf("builder-9", CARDS)).toBe("idle");
    expect(rosterGroupOf("nobody", CARDS)).toBe("idle");
  });

  test("a doing claim outranks an awaiting-human one for the row's caption", () => {
    const cards = [
      { num: 1, title: "parked", assignee: "a", status: "awaiting-human" },
      { num: 2, title: "moving", assignee: "a", status: "doing" },
    ];
    expect(heldCard("a", cards)?.num).toBe(2);
    expect(rosterGroupOf("a", cards)).toBe("working");
  });

  test("every member lands in exactly one group, in the team's own order", () => {
    const team = [
      { name: "builder-31", kind: "agent", lastSeen: iso(2), events: 1 },
      { name: "rob", kind: "human", lastSeen: iso(1), events: 20 },
      { name: "builder-9", kind: "agent", lastSeen: iso(400), events: 5 },
    ];
    const g = groupRoster(team, CARDS);
    expect(g.working.map((m) => m.name)).toEqual(["builder-31"]);
    expect(g.waiting.map((m) => m.name)).toEqual(["rob"]);
    expect(g.idle.map((m) => m.name)).toEqual(["builder-9"]);
    expect(g.working.length + g.waiting.length + g.idle.length).toBe(team.length);
  });

  test("the head counts only the groups that exist", () => {
    expect(rosterCounts({ working: [{ name: "a" }], waiting: [], idle: [{ name: "b" }, { name: "c" }] }))
      .toBe("1 working · 2 idle");
    expect(rosterCounts({ working: [], waiting: [{ name: "a" }], idle: [] })).toBe("1 waiting on you");
    expect(rosterCounts({ working: [], waiting: [], idle: [] })).toBe("");
  });
});

describe("roster caption", () => {
  const age = () => "3h";

  test("someone on a card is named by that card, not by their runtime", () => {
    const m = { name: "builder-31", kind: "agent", lastSeen: iso(2), model: "opus" };
    expect(rosterCaption(m, CARDS, age)).toBe("#31 Roster and actor view");
  });

  test("idle says what ran and how long ago — not the kind, not the write count", () => {
    const m = { name: "builder-9", kind: "agent", lastSeen: iso(400), model: "sonnet" };
    expect(rosterCaption(m, CARDS, age)).toBe("sonnet · 3h");
  });

  test("no model falls back to the kind, so a row is never captionless", () => {
    const m = { name: "rob", kind: "human", lastSeen: iso(400) };
    expect(rosterCaption(m, [], age)).toBe("human · 3h");
  });

  test("someone writing right now drops the age rather than saying 'now'", () => {
    const m = { name: "x", kind: "agent", lastSeen: iso(0), model: "opus" };
    expect(rosterCaption(m, [], () => "now")).toBe("opus");
  });
});

describe("sharedRoles (#31)", () => {
  test("a role on every card is dropped from the caption; one on some of them stays", () => {
    const cards = [
      { roles: ["created", "commented"] },
      { roles: ["created"] },
      { roles: ["created", "claimed", "resolved"] },
    ];
    const shared = sharedRoles(cards);
    expect([...shared]).toEqual(["created"]);
    expect(rolesCaption(["created", "commented"], shared)).toBe("commented");
    expect(rolesCaption(["created"], shared)).toBe("");
  });

  test("a single card keeps its caption: there is nothing for it to be shared with", () => {
    expect([...sharedRoles([{ roles: ["created"] }])]).toEqual([]);
    expect(rolesCaption(["created"], sharedRoles([{ roles: ["created"] }]))).toBe("created");
  });

  test("nothing in common leaves every caption alone, and holding still goes", () => {
    const cards = [{ roles: ["created"] }, { roles: ["claimed", "holding"] }];
    const shared = sharedRoles(cards);
    expect(shared.size).toBe(0);
    expect(rolesCaption(["claimed", "holding"], shared)).toBe("claimed");
  });

  test("an empty list has no shared roles", () => {
    expect(sharedRoles([]).size).toBe(0);
  });
});
