/**
 * Syntax highlighting for a composer draft — today, that means quoted lines (ADR 0014).
 *
 * A quote put into the composer by "Add to chat" is ordinary text in the textarea, so it can
 * be edited, split, and have a reply typed between two of them. What it must not look like
 * is the markdown it is: `> **robrichardson** said:` above `> ive me a l` is what Rob saw
 * and what card #6 is about. nib has the same arrangement and answers it the same way — its
 * `NSTextView` paints every line whose trimmed start is `>` in the secondary label colour
 * (`applyHighlighting` in `AgentComposerView.swift`), leaving the markers themselves alone
 * because they are what the engine receives.
 *
 * A `<textarea>` cannot colour one of its lines, so the treatment is painted by a mirror
 * layer behind a field whose own glyphs are transparent (`.composer-hl` in styles.css). That
 * only works while the mirror is glyph-for-glyph aligned with the real text, which is the
 * constraint this module's output shape exists to respect: a line is split into spans that
 * are *shown* or *hidden*, and a hidden span is hidden by colour alone — the characters keep
 * their columns. Nothing here may lead a caller to change a glyph's position: no padding, no
 * font weight, no letter spacing, and never a different string than the draft holds.
 */

/** A run of characters within one line. `hidden` is drawn in a transparent ink: the `> `
 *  marker and the `**` around an author's name are noise once the line is visibly a quote,
 *  but they still take up their columns. */
export interface DraftSpan {
  kind: "shown" | "hidden";
  value: string;
}

export interface DraftLine {
  /** A quoted line, i.e. one nib would dim: trimmed, it starts with `>`. */
  quote: boolean;
  /** First / last line of a run of quoted lines, so the band can round its outer corners. */
  start: boolean;
  end: boolean;
  spans: DraftSpan[];
}

/** nib's own test: the trimmed line starts with `>`. Leading whitespace is tolerated because
 *  a quote pasted into an indented context is still a quote. */
function isQuoteLine(line: string): boolean {
  return line.trimStart().startsWith(">");
}

/**
 * The draft, line by line, ready to mirror. One entry per line of `text` — including the
 * empty last line a trailing newline leaves, which the textarea also renders, so the mirror
 * has to as well.
 */
export function highlightDraft(text: string): DraftLine[] {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const quote = isQuoteLine(line);
    return {
      quote,
      start: quote && !(i > 0 && isQuoteLine(lines[i - 1])),
      end: quote && !(i + 1 < lines.length && isQuoteLine(lines[i + 1])),
      spans: quote ? quoteSpans(line) : [{ kind: "shown" as const, value: line }],
    };
  });
}

/** True when anything in the draft is worth mirroring. Below this, the composer renders no
 *  overlay at all and keeps its own visible text — the ordinary case pays nothing, and the
 *  transparent-text trick (with its `::selection` caveat) is only ever in play on a draft
 *  that actually holds a quote. */
export function hasHighlight(lines: DraftLine[]): boolean {
  return lines.some((l) => l.quote);
}

const MARKER = /^(\s*>\s?)/;

/** A quoted line's spans: the `> ` marker hidden, then the body with any `**` hidden so an
 *  attribution line reads as `robrichardson said:` rather than as bold markdown. Only the
 *  delimiters are hidden — never the name, and never with a bolder or narrower font, which
 *  would shift every glyph after it out from under the real one. */
function quoteSpans(line: string): DraftSpan[] {
  const marker = MARKER.exec(line);
  const prefix = marker ? marker[1] : "";
  const body = line.slice(prefix.length);
  const spans: DraftSpan[] = prefix ? [{ kind: "hidden", value: prefix }] : [];
  for (const part of body.split(/(\*\*)/)) {
    if (part === "") continue;
    spans.push({ kind: part === "**" ? "hidden" : "shown", value: part });
  }
  return spans;
}
