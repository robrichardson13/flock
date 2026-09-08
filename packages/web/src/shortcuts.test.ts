import { describe, expect, it } from "bun:test";
import { hasModifier, isTypingTarget, matchShortcut, SHORTCUT_HINT } from "./shortcuts.ts";

const key = (k: string, extra: Partial<Parameters<typeof matchShortcut>[0]> = {}) => ({ key: k, ...extra });

describe("matchShortcut", () => {
  it("maps the four verbs", () => {
    expect(matchShortcut(key("n"))).toEqual({ kind: "new-card" });
    expect(matchShortcut(key("/"))).toEqual({ kind: "focus-composer" });
    expect(matchShortcut(key("1"))).toEqual({ kind: "pane", pane: "channel" });
    expect(matchShortcut(key("2"))).toEqual({ kind: "pane", pane: "activity" });
    expect(matchShortcut(key("3"))).toEqual({ kind: "pane", pane: "decisions" });
  });

  it("takes a capital N, since Caps Lock is not a chord", () => {
    // Shift-n is a different keystroke and stays out — see the shiftKey test below.
    expect(matchShortcut(key("N"))).toEqual({ kind: "new-card" });
  });

  it("ignores every other key", () => {
    for (const k of ["a", "4", "0", "Enter", "Escape", "Tab", "?", " ", "ArrowDown"]) {
      expect(matchShortcut(key(k))).toBeNull();
    }
  });

  it("stands down for any modifier, so ⌘1 stays a browser tab", () => {
    expect(matchShortcut(key("1", { metaKey: true }))).toBeNull();
    expect(matchShortcut(key("1", { ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key("/", { altKey: true }))).toBeNull();
    expect(matchShortcut(key("n", { metaKey: true }))).toBeNull();
  });

  it("stands down for Shift, so ? is not /", () => {
    expect(matchShortcut(key("/", { shiftKey: true }))).toBeNull();
    expect(matchShortcut(key("?", { shiftKey: true }))).toBeNull();
  });

  it("stands down while the reader is typing", () => {
    expect(matchShortcut(key("n", { target: { tagName: "INPUT" } }))).toBeNull();
    expect(matchShortcut(key("/", { target: { tagName: "TEXTAREA" } }))).toBeNull();
    expect(matchShortcut(key("1", { target: { tagName: "SELECT" } }))).toBeNull();
    expect(matchShortcut(key("n", { target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
  });

  it("still fires when the keystroke lands on a button or a link", () => {
    expect(matchShortcut(key("n", { target: { tagName: "BUTTON" } }))).toEqual({ kind: "new-card" });
    expect(matchShortcut(key("2", { target: { tagName: "A" } }))).toEqual({ kind: "pane", pane: "activity" });
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing at all", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });

  it("reads the contenteditable attribute when the live property is absent", () => {
    expect(isTypingTarget({ tagName: "DIV", getAttribute: () => "true" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: () => "" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: () => "false" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: () => null })).toBe(false);
  });

  it("is case-insensitive about the tag name", () => {
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
  });
});

describe("hasModifier", () => {
  it("counts ctrl, meta and alt but not shift", () => {
    expect(hasModifier({ key: "n" })).toBe(false);
    expect(hasModifier({ key: "n", shiftKey: true })).toBe(false);
    expect(hasModifier({ key: "n", ctrlKey: true })).toBe(true);
    expect(hasModifier({ key: "n", metaKey: true })).toBe(true);
    expect(hasModifier({ key: "n", altKey: true })).toBe(true);
  });
});

describe("SHORTCUT_HINT", () => {
  it("names every shortcut the dispatcher answers to", () => {
    expect(SHORTCUT_HINT).toContain("n");
    expect(SHORTCUT_HINT).toContain("/");
    expect(SHORTCUT_HINT).toContain("1-3");
  });
});
