import { describe, expect, test } from "bun:test";
import { splitDocumentBlocks, splitMessageBlocks } from "./markdown.tsx";

describe("splitDocumentBlocks: document mode block splitting", () => {
  test("a single newline inside a paragraph keeps both lines in one para block, not joined", () => {
    expect(splitDocumentBlocks("line one\nline two")).toEqual([
      { t: "para", lines: ["line one", "line two"] },
    ]);
  });

  test("a blank line splits into two separate paragraph blocks", () => {
    expect(splitDocumentBlocks("first\n\nsecond")).toEqual([
      { t: "para", lines: ["first"] },
      { t: "para", lines: ["second"] },
    ]);
  });

  test("a multi-line paragraph followed by a blank-line paragraph keeps each para's lines distinct", () => {
    expect(splitDocumentBlocks("line one\nline two\n\nparagraph two")).toEqual([
      { t: "para", lines: ["line one", "line two"] },
      { t: "para", lines: ["paragraph two"] },
    ]);
  });

  test("a `- ` line still becomes a list block, ending the paragraph", () => {
    expect(splitDocumentBlocks("intro\n- one\n- two")).toEqual([
      { t: "para", lines: ["intro"] },
      {
        t: "list",
        items: [
          { text: "one", indent: 0, task: null },
          { text: "two", indent: 0, task: null },
        ],
      },
    ]);
  });

  test("a `# ` line is a heading block", () => {
    expect(splitDocumentBlocks("# Title\nbody")).toEqual([
      { t: "heading", level: 1, text: "Title" },
      { t: "para", lines: ["body"] },
    ]);
  });

  test("a fenced code block's lines are not split into paragraph lines", () => {
    expect(splitDocumentBlocks("run:\n```\nflock cards\n```")).toEqual([
      { t: "para", lines: ["run:"] },
      { t: "code", value: "flock cards" },
    ]);
  });
});

describe("splitMessageBlocks: message mode block splitting", () => {
  test("a two-line message keeps both lines as one text block, newlines intact", () => {
    expect(splitMessageBlocks("line one\nline two")).toEqual([{ t: "text", value: "line one\nline two" }]);
  });

  test("plain text with no markers is a single text block", () => {
    expect(splitMessageBlocks("just a status update")).toEqual([{ t: "text", value: "just a status update" }]);
  });

  test("a `- ` line becomes a list block", () => {
    expect(
      splitMessageBlocks("findings:\n- one\n- two"),
    ).toEqual([
      { t: "text", value: "findings:" },
      {
        t: "list",
        items: [
          { text: "one", task: null },
          { text: "two", task: null },
        ],
      },
    ]);
  });

  test("a task-list line renders as a task item, read-only in message mode", () => {
    expect(splitMessageBlocks("- [ ] todo\n- [x] done")).toEqual([
      {
        t: "list",
        items: [
          { text: "todo", task: { index: 0, checked: false } },
          { text: "done", task: { index: 1, checked: true } },
        ],
      },
    ]);
  });

  test("a fenced code block is its own block, and text resumes after it", () => {
    expect(splitMessageBlocks("run this:\n```\nflock cards\n```\nthanks")).toEqual([
      { t: "text", value: "run this:" },
      { t: "code", value: "flock cards" },
      { t: "text", value: "thanks" },
    ]);
  });

  test("bullets inside a fenced code block stay literal code, not a list", () => {
    expect(splitMessageBlocks("```\n- not a bullet\n```")).toEqual([{ t: "code", value: "- not a bullet" }]);
  });

  test("blank lines inside a run of text are preserved (no paragraph splitting)", () => {
    expect(splitMessageBlocks("first\n\nsecond")).toEqual([{ t: "text", value: "first\n\nsecond" }]);
  });

  test("a `# ` line is a level-1 heading block", () => {
    expect(splitMessageBlocks("# Title")).toEqual([{ t: "heading", level: 1, text: "Title" }]);
  });

  test("a `## ` line is a level-2 heading block", () => {
    expect(splitMessageBlocks("## Section")).toEqual([{ t: "heading", level: 2, text: "Section" }]);
  });

  test("a `### ` line is a level-3 heading block", () => {
    expect(splitMessageBlocks("### Subsection")).toEqual([{ t: "heading", level: 3, text: "Subsection" }]);
  });

  test("`####`, `#####`, and `######` lines are level 4, 5, and 6 heading blocks", () => {
    expect(splitMessageBlocks("#### Four")).toEqual([{ t: "heading", level: 4, text: "Four" }]);
    expect(splitMessageBlocks("##### Five")).toEqual([{ t: "heading", level: 5, text: "Five" }]);
    expect(splitMessageBlocks("###### Six")).toEqual([{ t: "heading", level: 6, text: "Six" }]);
  });

  test("a `#` with no following space stays literal text", () => {
    expect(splitMessageBlocks("#no-space")).toEqual([{ t: "text", value: "#no-space" }]);
  });

  test("a `#` not at line start stays literal text", () => {
    expect(splitMessageBlocks("see issue #42 for details")).toEqual([
      { t: "text", value: "see issue #42 for details" },
    ]);
  });

  test("seven hashes is one heading marker too many, so it stays literal text", () => {
    expect(splitMessageBlocks("####### Seven")).toEqual([{ t: "text", value: "####### Seven" }]);
  });

  test("a heading line surrounded by plain text splits into three blocks", () => {
    expect(splitMessageBlocks("before\n## Heading\nafter")).toEqual([
      { t: "text", value: "before" },
      { t: "heading", level: 2, text: "Heading" },
      { t: "text", value: "after" },
    ]);
  });

  test("a heading followed directly by a bullet list splits into heading then list blocks", () => {
    expect(splitMessageBlocks("# Findings\n- one\n- two")).toEqual([
      { t: "heading", level: 1, text: "Findings" },
      {
        t: "list",
        items: [
          { text: "one", task: null },
          { text: "two", task: null },
        ],
      },
    ]);
  });

  test("a heading's text still carries inline markers, resolved by the inline tokenizer at render time", () => {
    expect(splitMessageBlocks("## **bold** and _italic_ and `code`")).toEqual([
      { t: "heading", level: 2, text: "**bold** and _italic_ and `code`" },
    ]);
  });

  test("a `#` line inside a fenced code block stays literal code, not a heading", () => {
    expect(splitMessageBlocks("```\n# not a heading\n```")).toEqual([
      { t: "code", value: "# not a heading" },
    ]);
  });

  test("a run of `> ` lines becomes one quote block", () => {
    expect(splitMessageBlocks("> **ada** said:\n> first\n> second")).toEqual([
      { t: "quote", lines: ["**ada** said:", "first", "second"] },
    ]);
  });

  test("a quote block is followed by ordinary text once the `>` lines end", () => {
    expect(splitMessageBlocks("> quoted\n\nmy reply")).toEqual([
      { t: "quote", lines: ["quoted"] },
      { t: "text", value: "\nmy reply" },
    ]);
  });

  test("a `> - x` line stays inside the quote block, not a list", () => {
    expect(splitMessageBlocks("> - not a bullet")).toEqual([
      { t: "quote", lines: ["- not a bullet"] },
    ]);
  });

  test("a `>` inside a fenced code block is literal, not a quote", () => {
    expect(splitMessageBlocks("```\n> not a quote\n```")).toEqual([
      { t: "code", value: "> not a quote" },
    ]);
  });

  test("a bare `>` with no space becomes an empty quoted line", () => {
    expect(splitMessageBlocks(">")).toEqual([{ t: "quote", lines: [""] }]);
  });

  test("`>` that is not at line start is not a quote", () => {
    expect(splitMessageBlocks("5 > 3 is true")).toEqual([{ t: "text", value: "5 > 3 is true" }]);
  });

  // The shape "Add to chat" produces when the composer already had text in it: the human's
  // own line, a blank line, then the quote. The quote must be its own block either way —
  // this also pins the no-blank-line case, since a lazy paragraph continuation (what
  // CommonMark would do) would swallow the `>` lines into the text above them.
  test("a `> ` run directly under a text line is still its own quote block", () => {
    expect(splitMessageBlocks("my reply\n> quoted")).toEqual([
      { t: "text", value: "my reply" },
      { t: "quote", lines: ["quoted"] },
    ]);
  });

  test("a `> ` run under a text line and a blank line is its own quote block", () => {
    expect(splitMessageBlocks("my reply\n\n> quoted")).toEqual([
      { t: "text", value: "my reply\n" },
      { t: "quote", lines: ["quoted"] },
    ]);
  });
});
