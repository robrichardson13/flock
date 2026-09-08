/**
 * GFM task-list items in a markdown body: `- [ ] thing` / `- [x] thing`.
 *
 * The web renderer and the toggle rule both enumerate task items with this
 * function, so the index a click sends is the index core rewrites. Items inside
 * fenced code blocks are not task items; they are literal sample markdown.
 */

export interface TaskItem {
  /** Position among the task items of the body, in document order, from 0. */
  index: number;
  /** Zero-based line of the body this item occupies. */
  line: number;
  checked: boolean;
  /** Leading whitespace, expanded so a tab counts as four columns. */
  indent: number;
  /** The item text with the marker and the checkbox stripped. */
  text: string;
}

const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)/;

/** Every task-list item in `body`, in document order, skipping fenced code. */
export function taskItems(body: string): TaskItem[] {
  const out: TaskItem[] = [];
  const lines = body.split("\n");
  let fence: string | null = null;
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!;
    const f = raw.match(FENCE_RE);
    if (f) {
      const marker = f[1]![0]!;
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = raw.match(TASK_RE);
    if (!m) continue;
    out.push({
      index: out.length,
      line,
      checked: m[3] !== " ",
      indent: m[1]!.replace(/\t/g, "    ").length,
      text: m[4]!.trimEnd(),
    });
  }
  return out;
}

/**
 * Rewrite the `index`th task item of `body` to `checked`, leaving every other
 * character alone. Returns null when the body has no such item.
 */
export function setTaskChecked(body: string, index: number, checked: boolean): string | null {
  const items = taskItems(body);
  const item = items[index];
  if (!item) return null;
  const lines = body.split("\n");
  lines[item.line] = lines[item.line]!.replace(/\[([ xX])\]/, checked ? "[x]" : "[ ]");
  return lines.join("\n");
}
