import type { Flock } from "./flock.ts";
import { CARD_STATUSES, CLOSED_STATUSES, type Actor, type CardStatus, type Decision } from "./types.ts";

const HEADINGS: Record<CardStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  "awaiting-human": "Awaiting human",
  done: "Done",
  wontfix: "Wontfix",
};
const STATUS_BY_HEADING = new Map(Object.entries(HEADINGS).map(([s, h]) => [h.toLowerCase(), s as CardStatus]));

/** Render a board as one markdown document: body, decisions, then a checklist per status. */
export function exportBoard(flock: Flock, boardRef: string): string {
  const snap = flock.snapshot(boardRef);
  const out: string[] = [`# ${snap.board.title}`, ""];
  if (snap.board.body.trim()) out.push(snap.board.body.trim(), "");
  function pushDecisions(heading: string, decisions: Decision[]): void {
    if (!decisions.length) return;
    out.push(`## ${heading}`, "");
    for (const d of decisions) out.push(d.cardNum ? `- #${d.cardNum}: ${d.gist}` : `- ${d.gist}`);
    out.push("");
  }
  pushDecisions("Decisions so far", snap.decisions);
  // Guarded on the count so an all-standing board never pays for the second query.
  if (snap.archivedDecisionCount > 0) pushDecisions("Decisions (archived)", flock.decisions(boardRef, { archived: true }));
  for (const status of CARD_STATUSES) {
    const cards = snap.cards.filter((c) => c.status === status);
    if (!cards.length && status !== "todo") continue;
    out.push(`## ${HEADINGS[status]}`, "");
    for (const c of cards) {
      const box = CLOSED_STATUSES.includes(c.status) ? "x" : " ";
      const bits = [`- [${box}] #${c.num} ${c.title}`];
      if (c.assignee) bits.push(`@${c.assignee}`);
      if (c.labels.length) bits.push(`[${c.labels.join(", ")}]`);
      if (c.blockedBy.length) bits.push(`(blocked by ${c.blockedBy.map((n) => `#${n}`).join(", ")})`);
      if (c.held) bits.push("(on hold)");
      out.push(bits.join(" "));
      if (c.question) out.push(`  > ? ${c.question.replace(/\n/g, "\n  > ")}`);
      if (c.held && c.holdReason) out.push(`  > ! ${c.holdReason.replace(/\n/g, "\n  > ")}`);
      if (c.body.trim()) for (const line of c.body.trim().split("\n")) out.push(`  ${line}`);
    }
    out.push("");
  }
  return out.join("\n");
}

interface ParsedCard {
  num: number | null;
  title: string;
  status: CardStatus;
  assignee: string | null;
  labels: string[];
  blockedBy: number[];
  body: string;
  question: string | null;
  held: boolean;
  holdReason: string | null;
}

export interface ParsedBoard {
  title: string;
  body: string;
  decisions: { cardNum: number | null; gist: string; archived: boolean }[];
  cards: ParsedCard[];
}

const CARD_RE = /^- \[( |x|X)\] (?:#(\d+) )?(.+)$/;

/** Parse the format written by exportBoard. Tolerant of hand edits. */
export function parseBoard(md: string): ParsedBoard {
  const lines = md.split(/\r?\n/);
  const result: ParsedBoard = { title: "Untitled", body: "", decisions: [], cards: [] };
  let section: "body" | "decisions" | "decisions-archived" | CardStatus = "body";
  const bodyLines: string[] = [];
  let current: ParsedCard | null = null;
  let openBlock: "question" | "hold" | null = null;

  for (const raw of lines) {
    if (raw.startsWith("# ") && result.title === "Untitled" && section === "body") {
      result.title = raw.slice(2).trim();
      continue;
    }
    if (raw.startsWith("## ")) {
      const h = raw.slice(3).trim().toLowerCase();
      const known =
        h === "decisions so far" || h === "decisions" ? "decisions"
        : h === "decisions (archived)" ? "decisions-archived"
        : STATUS_BY_HEADING.get(h);
      if (!known && section === "body") {
        // Sub-headings inside the freeform body (Destination, Notes, Fog...) belong to the body.
        bodyLines.push(raw);
        continue;
      }
      current = null;
      section = known ?? "todo";
      continue;
    }
    if (section === "body") {
      bodyLines.push(raw);
      continue;
    }
    if (section === "decisions" || section === "decisions-archived") {
      const m = raw.match(/^- (?:#(\d+): )?(.+)$/);
      if (m) result.decisions.push({ cardNum: m[1] ? Number(m[1]) : null, gist: m[2].trim(), archived: section === "decisions-archived" });
      continue;
    }
    const m = raw.match(CARD_RE);
    if (m) {
      let rest = m[3].trim();
      const blockedBy: number[] = [];
      rest = rest.replace(/\(blocked by ([^)]+)\)/i, (_, list: string) => {
        for (const n of list.matchAll(/#?(\d+)/g)) blockedBy.push(Number(n[1]));
        return "";
      });
      let held = false;
      rest = rest.replace(/\(on hold\)/i, () => { held = true; return ""; });
      let labels: string[] = [];
      rest = rest.replace(/\[([^\]]*)\]\s*$/, (_, list: string) => {
        labels = list.split(",").map((s) => s.trim()).filter(Boolean);
        return "";
      });
      let assignee: string | null = null;
      rest = rest.replace(/\s@([\w.-]+)\s*$/, (_, a: string) => {
        assignee = a;
        return "";
      });
      const checked = m[1] !== " ";
      let status = section as CardStatus;
      if (checked && !CLOSED_STATUSES.includes(status)) status = "done";
      if (!checked && CLOSED_STATUSES.includes(status)) status = "todo";
      current = { num: m[2] ? Number(m[2]) : null, title: rest.trim(), status, assignee, labels, blockedBy, body: "", question: null, held, holdReason: null };
      result.cards.push(current);
      openBlock = null;
      continue;
    }
    if (current && raw.startsWith("  ")) {
      const line = raw.slice(2);
      if (line.startsWith("> ? ")) { current.question = (current.question ? current.question + "\n" : "") + line.slice(4); openBlock = "question"; }
      else if (line.startsWith("> ! ")) { current.holdReason = (current.holdReason ? current.holdReason + "\n" : "") + line.slice(4); openBlock = "hold"; }
      else if (line.startsWith("> ") && openBlock === "question") current.question += "\n" + line.slice(2);
      else if (line.startsWith("> ") && openBlock === "hold") current.holdReason += "\n" + line.slice(2);
      else { openBlock = null; current.body += (current.body ? "\n" : "") + line; }
    }
  }
  result.body = bodyLines.join("\n").trim();
  return result;
}

/**
 * Create a new board from a markdown document. Card numbers in the file are preserved when unique.
 * `opts.warnings`, if given, is pushed to with soft issues that were skipped rather than aborting the import.
 */
export function importBoard(
  flock: Flock,
  actor: Actor,
  md: string,
  opts: { slug?: string; title?: string; project?: string | null; warnings?: string[] } = {},
) {
  const parsed = parseBoard(md);
  const board = flock.createBoard(actor, { title: opts.title ?? parsed.title, slug: opts.slug, body: parsed.body, project: opts.project });
  // Assign nums: keep file nums when present and unique, otherwise take the next free.
  const used = new Set<number>();
  const order = parsed.cards.map((c) => {
    let num = c.num;
    if (num == null || used.has(num)) {
      num = 1;
      while (used.has(num) || parsed.cards.some((o) => o.num === num && o !== c)) num++;
    }
    used.add(num);
    return { ...c, num };
  });
  // Cards must be inserted in num order so the per-board counter lines up; fill gaps with nothing.
  order.sort((a, b) => a.num - b.num);
  const numMap = new Map<number, number>();
  for (const c of order) {
    const created = flock.createCard(actor, board.id, { title: c.title, body: c.body, labels: c.labels, assignee: c.assignee, status: c.status });
    numMap.set(c.num, created.num);
    if (c.question) flock.db.query("UPDATE cards SET question = ?, question_by = ? WHERE id = ?").run(c.question, c.assignee ?? actor.name, created.id);
    if (c.held) {
      // A closed card can never legitimately hold flock's own exporter, but a hand-written or
      // third-party file can say so; holdCard would throw on a closed card and abort the import
      // mid-loop. Closing already clears a hold (see decision vutsf1m5), so skip it here too.
      if (CLOSED_STATUSES.includes(c.status)) {
        opts.warnings?.push(`#${created.num} ${c.title}: ignored "(on hold)" on a closed card`);
      } else {
        flock.holdCard(actor, board.id, created.num, { reason: c.holdReason ?? undefined });
      }
    }
  }
  for (const c of order) {
    for (const b of c.blockedBy) {
      const target = numMap.get(b);
      if (target) flock.addBlocker(actor, board.id, numMap.get(c.num)!, target);
    }
  }
  const toArchive: number[] = [];
  for (const d of parsed.decisions) {
    const decision = flock.decide(actor, board.id, d.gist, d.cardNum ? numMap.get(d.cardNum) ?? null : null);
    if (d.archived) toArchive.push(decision.num);
  }
  if (toArchive.length) {
    flock.archiveDecisions(actor, board.id, { nums: toArchive }, { reason: "imported as archived" });
  }
  return flock.board(board.id);
}
