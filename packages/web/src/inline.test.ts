import { describe, expect, test } from "bun:test";
import { safeHref, tokenizeInline, type InlineToken } from "./inline.ts";

/** Flatten to something easy to assert on: a list of {t, v|href} with kids recursively flattened. */
function flat(tokens: InlineToken[]): any[] {
  return tokens.map((t) => {
    if (t.t === "text" || t.t === "code") return { t: t.t, v: t.v };
    if (t.t === "link") return { t: t.t, href: t.href, kids: flat(t.kids) };
    return { t: t.t, kids: flat(t.kids) };
  });
}

describe("plain text round-trips", () => {
  const cases = [
    "just a normal sentence with nothing special in it",
    "the variable is snake_case_identifier, leave it alone",
    "2 * 3 * 4 = 24",
    "C:\\Users\\rob\\file_name.ts is a windows path",
    "call func(a, b) and check the result",
  ];
  for (const s of cases) {
    test(s, () => {
      expect(flat(tokenizeInline(s))).toEqual([{ t: "text", v: s }]);
    });
  }
});

describe("each construct in isolation", () => {
  test("code", () => {
    expect(flat(tokenizeInline("see `inline code` here"))).toEqual([
      { t: "text", v: "see " },
      { t: "code", v: "inline code" },
      { t: "text", v: " here" },
    ]);
  });

  test("bold", () => {
    expect(flat(tokenizeInline("**bold**"))).toEqual([{ t: "strong", kids: [{ t: "text", v: "bold" }] }]);
  });

  test("strike", () => {
    expect(flat(tokenizeInline("~~gone~~"))).toEqual([{ t: "del", kids: [{ t: "text", v: "gone" }] }]);
  });

  test("italic with *", () => {
    expect(flat(tokenizeInline("*italic*"))).toEqual([{ t: "em", kids: [{ t: "text", v: "italic" }] }]);
  });

  test("italic with _", () => {
    expect(flat(tokenizeInline("_italic_"))).toEqual([{ t: "em", kids: [{ t: "text", v: "italic" }] }]);
  });

  test("link", () => {
    expect(flat(tokenizeInline("[flock](https://example.com)"))).toEqual([
      { t: "link", href: "https://example.com/", kids: [{ t: "text", v: "flock" }] },
    ]);
  });

  test("nested: bold containing code", () => {
    expect(flat(tokenizeInline("**bold with `code`**"))).toEqual([
      {
        t: "strong",
        kids: [{ t: "text", v: "bold with " }, { t: "code", v: "code" }],
      },
    ]);
  });
});

describe("underscore word-boundary rule", () => {
  test("underscore at a word boundary emphasises", () => {
    expect(flat(tokenizeInline("please _emphasise_ this"))).toEqual([
      { t: "text", v: "please " },
      { t: "em", kids: [{ t: "text", v: "emphasise" }] },
      { t: "text", v: " this" },
    ]);
  });

  test("underscore inside a word stays literal", () => {
    expect(flat(tokenizeInline("snake_case_name"))).toEqual([{ t: "text", v: "snake_case_name" }]);
  });

  test("underscore touching a word on one side only stays literal", () => {
    expect(flat(tokenizeInline("file_name.ts"))).toEqual([{ t: "text", v: "file_name.ts" }]);
  });

  test("a dunder name stays literal", () => {
    expect(flat(tokenizeInline("__init__"))).toEqual([{ t: "text", v: "__init__" }]);
  });

  test("a dunder name at a word boundary stays literal", () => {
    expect(flat(tokenizeInline("__all__"))).toEqual([{ t: "text", v: "__all__" }]);
  });

  test("a dunder name surrounded by other words stays literal", () => {
    expect(flat(tokenizeInline("a __b__ c"))).toEqual([{ t: "text", v: "a __b__ c" }]);
  });

  test("single underscores at a word boundary still emphasise", () => {
    expect(flat(tokenizeInline("_init_"))).toEqual([{ t: "em", kids: [{ t: "text", v: "init" }] }]);
  });
});

describe("safeHref", () => {
  test("accepts http, https, mailto", () => {
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("https://example.com/path")).toBe("https://example.com/path");
    expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  test("rejects unsafe protocols and relative paths", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("/relative/path")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("link safety in the tokenizer", () => {
  test("a javascript: link renders as literal text, not a link", () => {
    expect(flat(tokenizeInline("[click me](javascript:alert(1))"))).toEqual([
      { t: "text", v: "[click me](javascript:alert(1))" },
    ]);
  });

  test("a data: link renders as literal text", () => {
    expect(flat(tokenizeInline("[x](data:text/html,hi)"))).toEqual([{ t: "text", v: "[x](data:text/html,hi)" }]);
  });
});

describe("bare URLs", () => {
  test("trailing sentence punctuation is not part of the link", () => {
    expect(flat(tokenizeInline("see https://example.com/a."))).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://example.com/a", kids: [{ t: "text", v: "https://example.com/a" }] },
      { t: "text", v: "." },
    ]);
  });

  test("a URL wrapped in parentheses does not swallow the closing paren", () => {
    expect(flat(tokenizeInline("see (https://example.com/a)"))).toEqual([
      { t: "text", v: "see (" },
      { t: "link", href: "https://example.com/a", kids: [{ t: "text", v: "https://example.com/a" }] },
      { t: "text", v: ")" },
    ]);
  });

  test("a balanced paren inside the URL is kept", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(flat(tokenizeInline(url))).toEqual([{ t: "link", href: url, kids: [{ t: "text", v: url }] }]);
  });

  test("mailto is linked", () => {
    expect(flat(tokenizeInline("mail me at mailto:a@b.com please"))).toEqual([
      { t: "text", v: "mail me at " },
      { t: "link", href: "mailto:a@b.com", kids: [{ t: "text", v: "mailto:a@b.com" }] },
      { t: "text", v: " please" },
    ]);
  });
});

describe("unclosed delimiters stay literal", () => {
  test("unclosed bold", () => {
    expect(flat(tokenizeInline("**bold with no close"))).toEqual([{ t: "text", v: "**bold with no close" }]);
  });

  test("unclosed code", () => {
    expect(flat(tokenizeInline("`code with no close"))).toEqual([{ t: "text", v: "`code with no close" }]);
  });
});

describe("deep nesting terminates", () => {
  test("adversarial nesting does not blow the stack and produces a token stream", () => {
    let s = "x";
    for (let i = 0; i < 500; i++) s = `**${s}**`;
    expect(() => tokenizeInline(s)).not.toThrow();
    const tokens = tokenizeInline(s);
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe("a long message tokenizes in linear time", () => {
  // A run of openers that never close (`*a *a *a ...`, a shell transcript, a wall of
  // underscores) used to make every opener rescan to the end of the string. A 48KB
  // message took over a second, on a component that re-renders on every board event.
  test.each([
    ["unmatched asterisks", "*a ".repeat(16000)],
    ["unmatched tildes", "~~a ".repeat(12000)],
    ["unmatched underscores", " _a".repeat(16000)],
    ["a wall of asterisks", "*".repeat(50000)],
    ["a wall of underscores", "_".repeat(50000)],
  ])("%s, ~50KB, under 100ms", (_name, text) => {
    const started = performance.now();
    tokenizeInline(text);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("link text never nests an anchor inside an anchor", () => {
  test("a bare URL used as link text keeps its text and loses its anchor", () => {
    expect(flat(tokenizeInline("[see https://a.com](https://b.com)"))).toEqual([
      {
        t: "link",
        href: "https://b.com/",
        kids: [
          { t: "text", v: "see " },
          { t: "text", v: "https://a.com" },
        ],
      },
    ]);
  });

  test("a nested link inside emphasis in link text is flattened too", () => {
    expect(flat(tokenizeInline("[**https://a.com**](https://b.com)"))).toEqual([
      {
        t: "link",
        href: "https://b.com/",
        kids: [{ t: "strong", kids: [{ t: "text", v: "https://a.com" }] }],
      },
    ]);
  });
});
