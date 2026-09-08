import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Flock, FlockError, MAX_ATTACHMENT_BYTES, type Actor } from "../src/index.ts";

const ada: Actor = { name: "ada", kind: "human" };
const scout: Actor = { name: "scout", kind: "agent" };

function fresh() {
  const f = new Flock(":memory:");
  const board = f.createBoard(ada, { title: "Flock v1" });
  return { f, board };
}

/** A syntactically valid-enough PNG for magic-byte sniffing: header + arbitrary padding. */
function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function jpegBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
}

describe("attach", () => {
  test("stores and returns meta with correct size/sha256/mime/dims", () => {
    const { f, board } = fresh();
    const bytes = pngBytes(128);
    const att = f.attach(scout, board.id, { mime: "image/png", bytes, name: "shot.png", width: 100, height: 50 });
    expect(att.id).toHaveLength(8);
    expect(att.mime).toBe("image/png");
    expect(att.size).toBe(128);
    expect(att.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(att.width).toBe(100);
    expect(att.height).toBe(50);
    expect(att.messageId).toBeNull();
  });

  test("attachment() round-trips exact bytes", () => {
    const { f, board } = fresh();
    const bytes = pngBytes(256);
    const att = f.attach(scout, board.id, { mime: "image/png", bytes });
    const { meta, bytes: got } = f.attachment(board.id, att.id);
    expect(meta.id).toBe(att.id);
    expect([...got]).toEqual([...bytes]);
  });

  test("filename is sanitized: control chars (incl. CRLF), quotes and backslashes stripped, length capped", () => {
    const { f, board } = fresh();
    const att = f.attach(scout, board.id, {
      mime: "image/png",
      bytes: pngBytes(),
      name: 'evil\r\nX-Injected: 1"\\.png' + "x".repeat(250),
    });
    expect(att.name).not.toMatch(/[\r\n"\\]/);
    expect(att.name!.length).toBeLessThanOrEqual(200);

    const blank = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes(), name: '"\\' });
    expect(blank.name).toBe("attachment");
  });

  test("another board's id is not_found", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });
    const att = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    expect(() => f.attachment(other.id, att.id)).toThrow(FlockError);
    try {
      f.attachment(other.id, att.id);
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
    }
  });

  test("unsupported mime is invalid", () => {
    const { f, board } = fresh();
    expect(() => f.attach(scout, board.id, { mime: "application/pdf", bytes: pngBytes() })).toThrow(FlockError);
  });

  test("declared png with jpeg bytes is invalid", () => {
    const { f, board } = fresh();
    expect(() => f.attach(scout, board.id, { mime: "image/png", bytes: jpegBytes() })).toThrow(/not a valid/);
  });

  test("empty bytes is invalid", () => {
    const { f, board } = fresh();
    expect(() => f.attach(scout, board.id, { mime: "image/png", bytes: new Uint8Array(0) })).toThrow(/empty/);
  });

  test("over 5 MiB is invalid with status 413", () => {
    const { f, board } = fresh();
    const bytes = pngBytes(MAX_ATTACHMENT_BYTES + 1);
    try {
      f.attach(scout, board.id, { mime: "image/png", bytes });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlockError);
      expect((e as FlockError).status).toBe(413);
    }
  });
});

describe("say with attachments", () => {
  test("binds ids and preserves order", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const b = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes(32) });
    const m = f.say(scout, board.id, "two shots", { attachments: [b.id, a.id] });
    expect(m.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  test("messages() and snapshot() return them", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "one shot", { attachments: [a.id] });
    const msgs = f.messages(board.id);
    expect(msgs[msgs.length - 1]!.attachments.map((x) => x.id)).toEqual([a.id]);
    const snap = f.snapshot(board.id);
    expect(snap.messages[snap.messages.length - 1]!.attachments.map((x) => x.id)).toEqual([a.id]);
  });

  test("unknown id is not_found", () => {
    const { f, board } = fresh();
    expect(() => f.say(scout, board.id, "hi", { attachments: ["nosuchid1"] })).toThrow(FlockError);
    try {
      f.say(scout, board.id, "hi", { attachments: ["nosuchid1"] });
    } catch (e) {
      expect((e as FlockError).code).toBe("not_found");
    }
  });

  test("already-bound id is a conflict", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "first", { attachments: [a.id] });
    try {
      f.say(scout, board.id, "second", { attachments: [a.id] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlockError);
      expect((e as FlockError).code).toBe("conflict");
    }
  });

  test("more than 10 attachments is invalid", () => {
    const { f, board } = fresh();
    const ids = Array.from({ length: 11 }, () => f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() }).id);
    expect(() => f.say(scout, board.id, "many", { attachments: ids })).toThrow(FlockError);
  });

  test("duplicate ids in the list is invalid", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    expect(() => f.say(scout, board.id, "dup", { attachments: [a.id, a.id] })).toThrow(FlockError);
  });

  test("empty body with no attachments is invalid", () => {
    const { f, board } = fresh();
    expect(() => f.say(scout, board.id, "   ", {})).toThrow(FlockError);
  });

  test("empty body with one attachment is ok", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const m = f.say(scout, board.id, "", { attachments: [a.id] });
    expect(m.body).toBe("");
    expect(m.attachments).toHaveLength(1);
  });

  test("message.posted event data carries the attachments count plus an attachmentList", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes(), name: "shot.png" });
    f.say(scout, board.id, "shot", { attachments: [a.id] });
    const events = f.events({ boardId: board.id });
    const posted = events.find((e) => e.type === "message.posted")!;
    expect(posted.data.attachments).toBe(1);
    expect(posted.data).not.toHaveProperty("bytes");
    const list = posted.data.attachmentList as { id: string; mime: string; name: string | null; size: number }[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(a.id);
    expect(list[0].mime).toBe("image/png");
    expect(list[0].name).toBe("shot.png");
  });

  test("message.posted event data carries an empty attachmentList when there are no attachments", () => {
    const { f, board } = fresh();
    f.say(scout, board.id, "no pics here");
    const events = f.events({ boardId: board.id });
    const posted = events.find((e) => e.type === "message.posted")!;
    expect(posted.data.attachments).toBe(0);
    expect(posted.data.attachmentList).toEqual([]);
  });

  test("orphan sweep deletes an unbound attachment older than 1h, spares bound / recent / other-board orphans", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });

    const old = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const bound = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "keep this one bound", { attachments: [bound.id] });
    const recent = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const otherOld = f.attach(scout, other.id, { mime: "image/png", bytes: pngBytes() });

    // Backdate `old` and `otherOld` past the 1h TTL directly in the db (attach() always stamps "now").
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    f.db.query("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)").run(twoHoursAgo, old.id, otherOld.id);

    // A fresh say() on `board` sweeps board-scoped orphans older than 1h.
    f.say(scout, board.id, "trigger sweep");

    expect(() => f.attachmentMeta(board.id, old.id)).toThrow(FlockError);
    expect(f.attachmentMeta(board.id, bound.id).id).toBe(bound.id);
    expect(f.attachmentMeta(board.id, recent.id).id).toBe(recent.id);
    expect(f.attachmentMeta(other.id, otherOld.id).id).toBe(otherOld.id);
  });

  test("orphan sweep never deletes an attachment being bound by this same say()", () => {
    const { f, board } = fresh();
    const stale = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    f.db.query("UPDATE attachments SET created_at = ? WHERE id = ?").run(twoHoursAgo, stale.id);

    const msg = f.say(scout, board.id, "", { attachments: [stale.id] });

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.id).toBe(stale.id);
    expect(f.attachmentMeta(board.id, stale.id).messageId).toBe(msg.id);
    expect(f.messages(board.id)[0]!.attachments).toHaveLength(1);
  });

  test("binding an id that cannot be bound (missing, wrong board, already bound, or stolen mid-transaction) throws and rolls back", () => {
    const { f, board } = fresh();
    const other = f.createBoard(ada, { title: "Other" });
    const already = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "first", { attachments: [already.id] });

    const beforeCount = f.messages(board.id).length;
    expect(() => f.say(scout, board.id, "second", { attachments: [already.id] })).toThrow(FlockError);
    expect(() => f.say(scout, board.id, "missing", { attachments: ["nope0000"] })).toThrow(FlockError);
    const otherAtt = f.attach(scout, other.id, { mime: "image/png", bytes: pngBytes() });
    expect(() => f.say(scout, board.id, "cross-board", { attachments: [otherAtt.id] })).toThrow(FlockError);
    expect(f.messages(board.id)).toHaveLength(beforeCount);

    // The bind itself re-guards on `message_id IS NULL` (not just the pre-check), so an id
    // stolen between validation and the transaction's UPDATE still fails safe: throw and
    // roll back the whole say(), rather than silently posting with fewer attachments.
    const racey = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const stealer = f.say(scout, board.id, "steals it first");
    f.db.query("UPDATE attachments SET message_id = ? WHERE id = ?").run(stealer.id, racey.id);
    const countBefore = f.messages(board.id).length;
    expect(() => f.say(scout, board.id, "raced", { attachments: [racey.id] })).toThrow(FlockError);
    expect(f.messages(board.id)).toHaveLength(countBefore);
  });

  test("messages()[0].attachments[0] never carries bytes", () => {
    const { f, board } = fresh();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "shot", { attachments: [a.id] });
    const msg = f.messages(board.id)[0]!;
    expect(msg.attachments[0]).not.toHaveProperty("bytes");
  });
});

describe("comment with attachments", () => {
  function withCard() {
    const { f, board } = fresh();
    const card = f.createCard(ada, board.id, { title: "Ship it" });
    return { f, board, card };
  }

  test("binds ids and preserves order; comments() returns them", () => {
    const { f, board, card } = withCard();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const b = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes(32) });
    const cm = f.addComment(scout, board.id, card.num, "two shots", "comment", { attachments: [b.id, a.id] });
    expect(cm.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
    const read = f.comments(board.id, card.num);
    expect(read[0]!.attachments.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(f.attachmentMeta(board.id, a.id).commentId).toBe(cm.id);
    expect(f.attachmentMeta(board.id, a.id).messageId).toBeNull();
  });

  test("a comment without attachments has an empty list", () => {
    const { f, board, card } = withCard();
    const cm = f.addComment(scout, board.id, card.num, "just words");
    expect(cm.attachments).toEqual([]);
    expect(f.comments(board.id, card.num)[0]!.attachments).toEqual([]);
  });

  test("empty body with one attachment is ok; empty with none is invalid", () => {
    const { f, board, card } = withCard();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const cm = f.addComment(scout, board.id, card.num, "", "comment", { attachments: [a.id] });
    expect(cm.body).toBe("");
    expect(cm.attachments).toHaveLength(1);
    expect(() => f.addComment(scout, board.id, card.num, "  ")).toThrow(FlockError);
  });

  test("comment.posted event data carries the attachments count plus an attachmentList", () => {
    const { f, board, card } = withCard();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes(), name: "shot.png" });
    f.addComment(scout, board.id, card.num, "shot", "comment", { attachments: [a.id] });
    const posted = f.events({ boardId: board.id }).find((e) => e.type === "comment.posted")!;
    expect(posted.data.attachments).toBe(1);
    expect(posted.data).not.toHaveProperty("bytes");
    const list = posted.data.attachmentList as { id: string; mime: string; name: string | null; size: number }[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(a.id);
    expect(list[0].name).toBe("shot.png");
    expect(list[0].mime).toBe("image/png");
  });

  test("comment.posted carries an empty attachmentList when there are none", () => {
    const { f, board, card } = withCard();
    f.addComment(scout, board.id, card.num, "no pics here");
    const posted = f.events({ boardId: board.id }).find((e) => e.type === "comment.posted")!;
    expect(posted.data.attachments).toBe(0);
    expect(posted.data.attachmentList).toEqual([]);
  });

  test("unknown, cross-board, already-bound and message-bound ids all fail and roll back", () => {
    const { f, board, card } = withCard();
    const other = f.createBoard(ada, { title: "Other" });
    const before = f.comments(board.id, card.num).length;

    expect(() => f.addComment(scout, board.id, card.num, "hi", "comment", { attachments: ["nosuchid1"] })).toThrow(FlockError);
    const otherAtt = f.attach(scout, other.id, { mime: "image/png", bytes: pngBytes() });
    expect(() => f.addComment(scout, board.id, card.num, "hi", "comment", { attachments: [otherAtt.id] })).toThrow(FlockError);

    const bound = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.addComment(scout, board.id, card.num, "first", "comment", { attachments: [bound.id] });
    expect(() => f.addComment(scout, board.id, card.num, "second", "comment", { attachments: [bound.id] })).toThrow(FlockError);

    const onMessage = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.say(scout, board.id, "in the channel", { attachments: [onMessage.id] });
    expect(() => f.addComment(scout, board.id, card.num, "steal", "comment", { attachments: [onMessage.id] })).toThrow(FlockError);

    expect(f.comments(board.id, card.num)).toHaveLength(before + 1);
  });

  test("more than 10, or duplicate ids, is invalid", () => {
    const { f, board, card } = withCard();
    const ids = Array.from({ length: 11 }, () => f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() }).id);
    expect(() => f.addComment(scout, board.id, card.num, "many", "comment", { attachments: ids })).toThrow(FlockError);
    expect(() => f.addComment(scout, board.id, card.num, "dupes", "comment", { attachments: [ids[0]!, ids[0]!] })).toThrow(FlockError);
  });

  test("a comment's orphan sweep spares an attachment being bound by the same call, and clears stale ones", () => {
    const { f, board, card } = withCard();
    const stale = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const bindMe = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    f.db.query("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)").run(twoHoursAgo, stale.id, bindMe.id);

    const cm = f.addComment(scout, board.id, card.num, "", "comment", { attachments: [bindMe.id] });
    expect(cm.attachments.map((a) => a.id)).toEqual([bindMe.id]);
    expect(() => f.attachmentMeta(board.id, stale.id)).toThrow(FlockError);
  });

  test("comment attachments never carry bytes", () => {
    const { f, board, card } = withCard();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.addComment(scout, board.id, card.num, "shot", "comment", { attachments: [a.id] });
    expect(f.comments(board.id, card.num)[0]!.attachments[0]).not.toHaveProperty("bytes");
  });

  test("deleting the card removes its comment attachments", () => {
    const { f, board, card } = withCard();
    const a = f.attach(scout, board.id, { mime: "image/png", bytes: pngBytes() });
    f.addComment(scout, board.id, card.num, "shot", "comment", { attachments: [a.id] });
    f.db.query("DELETE FROM cards WHERE id = ?").run(card.id);
    expect(() => f.attachmentMeta(board.id, a.id)).toThrow(FlockError);
  });
});
