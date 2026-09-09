import { describe, expect, test } from "bun:test";
import { hasHighlight, highlightDraft, type DraftLine } from "./draftHighlight.ts";

/** What the mirror layer will actually paint on a line, for readability in the assertions. */
const shown = (l: DraftLine) => l.spans.filter((s) => s.kind === "shown").map((s) => s.value).join("");
const whole = (l: DraftLine) => l.spans.map((s) => s.value).join("");

describe("highlightDraft", () => {
  test("one entry per line, including the empty line a trailing newline leaves", () => {
    expect(highlightDraft("a\nb\n").map((l) => whole(l))).toEqual(["a", "b", ""]);
  });

  test("an empty draft is one empty, unquoted line", () => {
    const lines = highlightDraft("");
    expect(lines).toHaveLength(1);
    expect(lines[0].quote).toBe(false);
  });

  test("a line whose trimmed start is `>` is a quote; plain text is not", () => {
    expect(highlightDraft("> quoted\nplain\n  > indented").map((l) => l.quote)).toEqual([true, false, true]);
  });

  test("a `>` in the middle of a line is not a quote", () => {
    expect(highlightDraft("2 > 1").map((l) => l.quote)).toEqual([false]);
  });

  test("every span concatenates back to the exact line — the mirror never changes the text", () => {
    const text = "> **ada** said:\n> hello\n\nmy reply";
    for (const [i, line] of highlightDraft(text).entries()) {
      expect(whole(line)).toBe(text.split("\n")[i]);
    }
  });

  test("the `> ` marker is hidden, so the quote reads as an indent", () => {
    const [line] = highlightDraft("> hello");
    expect(line.spans[0]).toEqual({ kind: "hidden", value: "> " });
    expect(shown(line)).toBe("hello");
  });

  test("a bare `>` is all marker and shows nothing", () => {
    const [line] = highlightDraft(">");
    expect(shown(line)).toBe("");
    expect(whole(line)).toBe(">");
  });

  test("only one space after the marker is swallowed, so extra indentation survives", () => {
    const [line] = highlightDraft(">   indented");
    expect(shown(line)).toBe("  indented");
  });

  test("the `**` around an author is hidden and the name is not", () => {
    const [line] = highlightDraft("> **robrichardson** said:");
    expect(shown(line)).toBe("robrichardson said:");
    expect(line.spans.filter((s) => s.kind === "hidden").map((s) => s.value)).toEqual(["> ", "**", "**"]);
  });

  test("`**` on a plain line is left alone — only quotes are treated", () => {
    const [line] = highlightDraft("**bold** reply");
    expect(shown(line)).toBe("**bold** reply");
  });

  test("start and end mark the ends of a run, so a band can round its outer corners", () => {
    const lines = highlightDraft("> one\n> two\nreply\n> three");
    expect(lines.map((l) => [l.quote, l.start, l.end])).toEqual([
      [true, true, false],
      [true, false, true],
      [false, false, false],
      [true, true, true],
    ]);
  });

  test("two quotes separated by a typed line are two runs, each with its own ends", () => {
    const lines = highlightDraft("> **ada** said:\n> first\n\nin between\n\n> **bob** said:\n> second\n\n");
    expect(lines.filter((l) => l.start)).toHaveLength(2);
    expect(lines.filter((l) => l.end)).toHaveLength(2);
  });
});

describe("hasHighlight", () => {
  test("false for a draft with nothing quoted — the overlay does not engage", () => {
    expect(hasHighlight(highlightDraft("just typing\nand more"))).toBe(false);
    expect(hasHighlight(highlightDraft(""))).toBe(false);
  });

  test("true as soon as one line is quoted", () => {
    expect(hasHighlight(highlightDraft("reply\n> quoted"))).toBe(true);
  });
});
