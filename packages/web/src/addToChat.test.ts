import { describe, expect, test } from "bun:test";
import { joinDraft, quoteBlock, tipPlacement } from "./addToChat.tsx";

describe("quoteBlock", () => {
  test("prefixes each line with `> ` and ends with a blank line", () => {
    expect(quoteBlock("first\nsecond", null)).toBe("> first\n> second\n\n");
  });

  test("CRLF and lone CR normalise to LF before quoting", () => {
    expect(quoteBlock("first\r\nsecond\rthird", null)).toBe("> first\n> second\n> third\n\n");
  });

  test("drops leading and trailing blank lines but keeps a blank interior line as a bare `>`", () => {
    expect(quoteBlock("\n\nfirst\n\nsecond\n\n", null)).toBe("> first\n>\n> second\n\n");
  });

  test("empty text quotes to null", () => {
    expect(quoteBlock("", null)).toBeNull();
  });

  test("whitespace-only text quotes to null", () => {
    expect(quoteBlock("   \n\t\n  ", null)).toBeNull();
  });

  test("an author adds a leading attribution line", () => {
    expect(quoteBlock("hello", "ada")).toBe("> ada said:\n> hello\n\n");
  });

  test("no author omits the attribution line entirely", () => {
    expect(quoteBlock("hello", null)).not.toContain("said:");
  });

  test("truncates at a line boundary under the limit and marks it", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = quoteBlock(text, null, 20);
    expect(result).toContain("> …(truncated)");
    expect(result).not.toContain("line 9");
    // Only whole lines before the cut are kept.
    expect(result!.split("\n").filter((l) => l.startsWith("> line"))[0]).toBe("> line 0");
  });

  test("keeps at least one line even if it alone exceeds the limit", () => {
    const result = quoteBlock("a very long single line that is over the limit", null, 5);
    expect(result).toContain("> a very long single line that is over the limit");
    expect(result).toContain("> …(truncated)");
  });

  test("under the limit, nothing is truncated", () => {
    const result = quoteBlock("short", null, 4000);
    expect(result).not.toContain("truncated");
  });
});

describe("joinDraft", () => {
  test("an empty draft becomes exactly the quote, no extra newline", () => {
    expect(joinDraft("", "> quoted\n\n")).toBe("> quoted\n\n");
  });

  test("a draft not ending in a newline gets a blank line before the quote", () => {
    expect(joinDraft("half a thought", "> quoted\n\n")).toBe("half a thought\n\n> quoted\n\n");
  });

  test("a draft ending in one newline gets the second, so there is still a blank line", () => {
    expect(joinDraft("half a thought\n", "> quoted\n\n")).toBe("half a thought\n\n> quoted\n\n");
  });

  test("a draft already ending in a blank line gets no extra separator", () => {
    expect(joinDraft("half a thought\n\n", "> quoted\n\n")).toBe("half a thought\n\n> quoted\n\n");
  });

  test("quoting the same text twice appends it twice", () => {
    const once = joinDraft("", "> x\n\n");
    const twice = joinDraft(once, "> x\n\n");
    expect(twice).toBe("> x\n\n> x\n\n");
  });
});

describe("tipPlacement", () => {
  const viewport = { w: 1000, h: 800 };
  const tip = { w: 120, h: 32 };

  test("sits above the selection by the margin when there is room", () => {
    const rect = { top: 200, left: 100, right: 200, bottom: 220, width: 100, height: 20 };
    const pos = tipPlacement(rect, tip, viewport, 6);
    expect(pos.top).toBe(200 - 32 - 6);
  });

  test("flips below the selection when there is no room above", () => {
    const rect = { top: 10, left: 100, right: 200, bottom: 30, width: 100, height: 20 };
    const pos = tipPlacement(rect, tip, viewport, 6);
    expect(pos.top).toBe(30 + 6);
  });

  test("clamps the left edge so the tip never renders off the left of the viewport", () => {
    const rect = { top: 200, left: -50, right: 10, bottom: 220, width: 60, height: 20 };
    const pos = tipPlacement(rect, tip, viewport, 6);
    expect(pos.left).toBe(6);
  });

  test("clamps the right edge so the tip never renders off the right of the viewport", () => {
    const rect = { top: 200, left: 950, right: 1050, bottom: 220, width: 100, height: 20 };
    const pos = tipPlacement(rect, tip, viewport, 6);
    expect(pos.left).toBe(viewport.w - tip.w - 6);
  });

  test("clamps the bottom edge when flipping below would run off the viewport", () => {
    // No room above (top - tip.h - margin < margin) forces the flip, and the flipped
    // position (bottom + margin) itself runs past the viewport, so it clamps.
    const rect = { top: 2, left: 100, right: 200, bottom: 790, width: 100, height: 788 };
    const pos = tipPlacement(rect, tip, viewport, 6);
    expect(pos.top).toBe(viewport.h - tip.h - 6);
  });
});
