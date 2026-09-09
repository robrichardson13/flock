import { Fragment, type ReactNode } from "react";
import { taskItems } from "@flock/core/tasks";
import { tokenizeInline, type InlineToken } from "./inline.ts";

/** One rendered list item: plain bullet, or a GFM task item with its body-wide index. */
type Item = { text: string; indent: number; task: { index: number; checked: boolean } | null };

export type DocumentBlock =
  | { t: "heading"; level: number; text: string }
  | { t: "list"; items: Item[] }
  | { t: "code"; value: string }
  | { t: "para"; lines: string[] };

/**
 * Splits **document mode** text into blocks: headings, GFM task lists, bullet lists,
 * fenced code, and paragraphs. A blank line separates paragraphs; within a paragraph
 * each source line is kept distinct (rendered as a line break, not joined with a
 * space) so a single newline in a card body or brief still reads as a line break.
 * Exported as a pure function so block splitting is testable without rendering React.
 */
export function splitDocumentBlocks(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const lines = text.split("\n");
  const tasksByLine = new Map(taskItems(text).map((t) => [t.line, t]));
  let list: Item[] = [];
  let para: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  const flush = () => {
    if (list.length) {
      blocks.push({ t: "list", items: list });
      list = [];
    }
    if (para.length) {
      blocks.push({ t: "para", lines: para });
      para = [];
    }
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const f = raw.match(/^\s*(```+|~~~+)(.*)$/);
    if (f) {
      if (fence && f[1][0] === fence.marker) {
        blocks.push({ t: "code", value: fence.lines.join("\n") });
        fence = null;
      } else if (!fence) {
        flush();
        fence = { marker: f[1][0], lines: [] };
      } else fence.lines.push(raw);
      continue;
    }
    if (fence) {
      fence.lines.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ t: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const task = tasksByLine.get(n);
    if (task) {
      if (para.length) flush();
      list.push({ text: task.text, indent: task.indent, task: { index: task.index, checked: task.checked } });
      continue;
    }
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      if (para.length) flush();
      list.push({ text: li[2], indent: li[1].replace(/\t/g, "    ").length, task: null });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list.length) flush();
    para.push(line);
  }
  if (fence) blocks.push({ t: "code", value: fence.lines.join("\n") });
  flush();
  return blocks;
}

/**
 * Enough markdown for briefs and card bodies: headings, lists, GFM task lists, code
 * spans, fenced code, paragraphs. This is **document mode**: blank lines separate
 * paragraphs, a single newline inside a paragraph is a line break.
 *
 * Task-item indices come from `taskItems` in core, the same enumeration the toggle
 * rule uses, so the index a click sends addresses the line the server rewrites.
 * Pass `onToggleTask` to make the checkboxes live; without it they render read-only.
 */
export function Markdownish({ text, onToggleTask }: { text: string; onToggleTask?: (index: number, checked: boolean) => void }) {
  const blocks = splitDocumentBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.t === "code") return <pre key={i}><code>{b.value}</code></pre>;
        if (b.t === "heading") {
          const Tag = (`h${Math.min(4, b.level + 1)}`) as keyof JSX.IntrinsicElements;
          return <Tag key={i}>{inline(b.text)}</Tag>;
        }
        if (b.t === "list") {
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j} className={it.task ? "md-task" : undefined} style={{ marginLeft: `${indentPx(it)}px` }}>
                  {it.task ? <TaskItem item={it} onToggle={onToggleTask} /> : inline(it.text)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/**
 * How far a list item sits from the list's own indent. A task item reclaims the 20px
 * bullet gutter it does not use; nesting adds 18px a level, capped at three.
 */
function indentPx(it: Item): number {
  return (it.task ? -20 : 0) + Math.min(3, Math.floor(it.indent / 2)) * 18;
}

/**
 * A task item's checkbox and label. The label is the whole hit area, so the target
 * clears 24px on a phone; the handler stops the click there rather than letting it
 * reach a card tile or row that navigates on click.
 */
function TaskItem({ item, onToggle }: { item: Item; onToggle?: (index: number, checked: boolean) => void }) {
  const task = item.task!;
  const live = !!onToggle;
  return (
    <label
      className={`md-task-label${task.checked ? " is-checked" : ""}${live ? " is-live" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!live) e.preventDefault();
      }}
    >
      <input
        type="checkbox"
        className="md-task-box"
        checked={task.checked}
        disabled={!live}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onToggle?.(task.index, e.currentTarget.checked)}
      />
      <span>{inline(item.text)}</span>
    </label>
  );
}

function renderTokens(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.t) {
      case "text":
        return t.v;
      case "code":
        return <code key={i}>{t.v}</code>;
      case "strong":
        return <strong key={i}>{renderTokens(t.kids)}</strong>;
      case "em":
        return <em key={i}>{renderTokens(t.kids)}</em>;
      case "del":
        return <del key={i}>{renderTokens(t.kids)}</del>;
      case "link":
        return (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer">
            {renderTokens(t.kids)}
          </a>
        );
    }
  });
}

/** The inline subset — bold, italic, strikethrough, code, links — as React nodes. */
function inline(s: string): ReactNode {
  return renderTokens(tokenizeInline(s));
}

/**
 * A block in **message mode**: every newline in the source is preserved (there is no
 * paragraph reflow), only bullet lines and fenced code get block treatment, and
 * everything else is a run of inline nodes rendered as-is, newlines included, so the
 * surrounding `white-space: pre-wrap` container does the line-break work. Exported as a
 * pure function so the block shape is testable without rendering React.
 */
type MessageListItem = { text: string; task: { index: number; checked: boolean } | null };

export type MessageBlock =
  | { t: "text"; value: string }
  | { t: "list"; items: MessageListItem[] }
  | { t: "code"; value: string }
  | { t: "heading"; level: number; text: string }
  | { t: "quote"; lines: string[] };

/** `#` through `######` at line start, one or more spaces, then the heading text. A `#`
 * with no following space, or one that isn't the first character on the line, is not a
 * heading and falls through to plain text. */
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

export function splitMessageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const lines = text.split("\n");
  const tasksByLine = new Map(taskItems(text).map((t) => [t.line, t]));
  let textLines: string[] = [];
  let list: MessageListItem[] = [];
  let quote: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  const flushText = () => {
    if (textLines.length) {
      blocks.push({ t: "text", value: textLines.join("\n") });
      textLines = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ t: "list", items: list });
      list = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ t: "quote", lines: quote });
      quote = [];
    }
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const f = raw.match(/^\s*(```+|~~~+)(.*)$/);
    if (f) {
      if (fence && f[1][0] === fence.marker) {
        blocks.push({ t: "code", value: fence.lines.join("\n") });
        fence = null;
      } else if (!fence) {
        flushText();
        flushList();
        flushQuote();
        fence = { marker: f[1][0], lines: [] };
      } else fence.lines.push(raw);
      continue;
    }
    if (fence) {
      fence.lines.push(raw);
      continue;
    }
    // Checked ahead of tasks and lists: a bare `>`-prefixed line can never match either of
    // their regexes (both anchor on optional whitespace then the marker), so this only ever
    // steals lines nothing else wanted.
    const q = raw.match(/^>\s?(.*)$/);
    if (q) {
      flushText();
      flushList();
      quote.push(q[1]);
      continue;
    }
    flushQuote();
    const task = tasksByLine.get(n);
    if (task) {
      flushText();
      list.push({ text: task.text, task: { index: task.index, checked: task.checked } });
      continue;
    }
    const li = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      flushText();
      list.push({ text: li[2], task: null });
      continue;
    }
    const h = raw.match(ATX_HEADING);
    if (h) {
      flushText();
      flushList();
      blocks.push({ t: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    flushList();
    textLines.push(raw);
  }
  if (fence) blocks.push({ t: "code", value: fence.lines.join("\n") });
  flushText();
  flushList();
  flushQuote();
  return blocks;
}

/** A quote's attribution line: one bare word (an actor name is a slug) and `said:`. */
const CITE = /^(\S+) said:$/;

/**
 * Channel messages, comments, resolutions, asks, answers, and decision gists: **message
 * mode**. No paragraph wrapping, every newline preserved. Bullet lines still become a
 * `<ul>`, `#` lines a heading, `> ` lines a `<blockquote>`, and fenced code still works
 * (agents paste commands into the channel); everything else is inline nodes in document
 * order. Task items render read-only: there
 * is no toggle target for a checkbox typed into a message.
 */
export function MessageBody({ text }: { text: string }) {
  const blocks = splitMessageBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "code") return <pre key={i}><code>{b.value}</code></pre>;
        if (b.t === "heading") {
          const Tag = (`h${Math.min(4, b.level + 1)}`) as keyof JSX.IntrinsicElements;
          return <Tag key={i}>{inline(b.text)}</Tag>;
        }
        if (b.t === "list") {
          return (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j} className={it.task ? "md-task" : undefined}>
                  {it.task ? <TaskItem item={{ text: it.text, indent: 0, task: it.task }} /> : inline(it.text)}
                </li>
              ))}
            </ul>
          );
        }
        if (b.t === "quote") {
          // "Add to chat" leads a quote with `<author> said:` (ADR 0014, and no `**` on the
          // name since card #7 — every hidden character is dead space in the composer's own
          // highlight of the same text). The renderer is what makes that line read as an
          // attribution: matched only as the *first* line of a quote, and only as a bare
          // name, so an ordinary quote that happens to contain "someone said:" further down
          // is untouched.
          const cite = b.lines.length > 1 ? CITE.exec(b.lines[0]) : null;
          const lines = cite ? b.lines.slice(1) : b.lines;
          return (
            <blockquote key={i}>
              {cite && <cite className="quote-cite">{cite[1]}</cite>}
              {lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  {inline(l)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        return <span key={i}>{inline(b.value)}</span>;
      })}
    </>
  );
}
