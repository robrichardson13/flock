import { describe, expect, it } from "bun:test";
import { keyboardShrunk, readoutRequested, shellHeight, summarizeTrace, traceHead, traceText, type VVFrame } from "./vv.ts";

const f = (t: number, bar: number, offsetTop = 0, height = 800, scrollY = 0, slotOpacity = 1): VVFrame =>
  ({ t, bar, screen: bar - offsetTop, offsetTop, height, scrollY, slotOpacity });

describe("readoutRequested", () => {
  it("takes ?vv=1 before the hash", () => {
    expect(readoutRequested("http://x:5173/?vv=1")).toBe(true);
    expect(readoutRequested("http://x:5173/?vv=1#/b/slug")).toBe(true);
  });
  it("takes it inside the hash too", () => {
    expect(readoutRequested("http://x:5173/#/b/slug?vv=1")).toBe(true);
    expect(readoutRequested("http://x:5173/#vv")).toBe(true);
  });
  it("is off otherwise", () => {
    expect(readoutRequested("http://x:5173/")).toBe(false);
    expect(readoutRequested("http://x:5173/#/b/slug")).toBe(false);
    expect(readoutRequested("http://x:5173/?vv=0")).toBe(false);
    // A board whose slug merely starts with the letters is not a request.
    expect(readoutRequested("http://x:5173/#/b/vvtest")).toBe(false);
  });
});

describe("summarizeTrace", () => {
  it("is null with no frames", () => expect(summarizeTrace([])).toBeNull());
  it("separates a bar that rides a rising offset from one that moves on the glass", () => {
    // offsetTop climbs and the bar rides it exactly: it travels in the document and is
    // perfectly still on screen, which is the whole distinction the trace has to make.
    const rides = summarizeTrace([f(0, 0, 0), f(16, 20, 20), f(33, 40, 40), f(50, 0, 0)])!;
    expect(rides.barMax).toBe(40);
    expect(rides.screenMin).toBe(0);
    expect(rides.screenMax).toBe(0);
    expect(rides.barChanged).toBe(0);
  });
  it("reports the excursion and how many frames moved", () => {
    const s = summarizeTrace([f(0, 0), f(16, -19), f(33, -19), f(50, 12), f(66, 0)])!;
    expect(s.frames).toBe(5);
    expect(s.barMin).toBe(-19);
    expect(s.barMax).toBe(12);
    expect(s.barFinal).toBe(0);
    // -19, 12 and 0 are moves; the repeated -19 is not.
    expect(s.barChanged).toBe(3);
  });
  it("reports the lowest the bar's contents faded to (#13)", () => {
    // 1 everywhere is the healthy case: nothing animates the bar on focus.
    expect(summarizeTrace([f(0, 0), f(16, 0), f(33, 0)])!.slotOpacityMin).toBe(1);
    // What #12 measured before the fix: the slot restarting its fade from 0 on focus.
    const faded = summarizeTrace([f(0, 0, 0, 800, 0, 1), f(16, 0, 0, 800, 0, 0.31), f(33, 0, 0, 800, 0, 0.78)])!;
    expect(faded.slotOpacityMin).toBe(0.31);
  });
  it("carries the viewport extremes", () => {
    const s = summarizeTrace([f(0, 0, 0, 844, 0), f(16, 0, 59, 508, 120)])!;
    expect(s.offsetMax).toBe(59);
    expect(s.scrollMax).toBe(120);
    expect(s.heightMin).toBe(508);
    expect(s.heightMax).toBe(844);
  });
});

describe("traceHead / traceText", () => {
  it("keeps the head to a line, and reports the on-screen top", () => {
    expect(traceHead([f(0, 0), f(16, -19, 8), f(33, -15, 31), f(50, 0), f(66, 0)])).toBe("0:0/0 16:-27/8 33:-46/31 50:0/0");
  });
  it("puts the meta, the summary and every frame in the clipboard text", () => {
    const text = traceText([f(0, 0), f(16, -19, 8)], { mode: "standalone" });
    expect(text.startsWith("mode=standalone")).toBe(true);
    expect(text).toContain("\"barMin\":-19");
    expect(text.trim().split("\n")).toHaveLength(5);
  });
});

/**
 * #16: the standalone shell's height. The condition every previous harness missed is the
 * 793-vs-852 split — the home-screen app reports `innerHeight` with the top safe-area inset
 * already taken off while the layout viewport `position: fixed` uses stays the full display —
 * so it is written out here as the numbers off the human's own phone.
 */
describe("shellHeight", () => {
  const base = { raw: 793, innerHeight: 793, clientHeight: 793, rest: 793, screenHeight: 852, standalone: true, keyboard: false };

  it("fills the glass in standalone with no keyboard: innerHeight 793, layout viewport 852", () => {
    expect(shellHeight({ ...base, clientHeight: 852 })).toBe(852);
  });

  it("changes nothing where the three readings already agree", () => {
    expect(shellHeight(base)).toBe(793);
  });

  it("still corrects the status bar and the accessory pill under a real keyboard", () => {
    // The device's shrunk reading with a field focused: 417 - (852 - 793) - 37.
    expect(shellHeight({ ...base, raw: 417, clientHeight: 852, keyboard: true })).toBe(321);
  });

  it("does not take that correction from a short viewport alone — the #10 misfire", () => {
    // Same numbers, nothing focused. The old inference read `raw < rest - 1` as a keyboard and
    // put the whole app in the top 40% of the glass.
    expect(shellHeight({ ...base, raw: 417, clientHeight: 852, keyboard: false })).toBe(852);
  });

  it("leaves a Safari tab alone: a short visual viewport there is Safari's own toolbar", () => {
    expect(shellHeight({ ...base, raw: 743, innerHeight: 852, clientHeight: 852, rest: 852, standalone: false })).toBe(743);
    expect(shellHeight({ ...base, raw: 743, innerHeight: 852, clientHeight: 852, rest: 852, standalone: false, keyboard: true })).toBe(743);
  });

  it("never floors below what is actually visible", () => {
    // A visual viewport taller than either layout reading (pinch-out) still wins.
    expect(shellHeight({ ...base, raw: 900, clientHeight: 852 })).toBe(900);
  });
});

describe("keyboardShrunk", () => {
  it("needs both the focus evidence and the shortfall", () => {
    expect(keyboardShrunk({ raw: 417, rest: 793, keyboard: true })).toBe(true);
    expect(keyboardShrunk({ raw: 417, rest: 793, keyboard: false })).toBe(false);
    expect(keyboardShrunk({ raw: 793, rest: 793, keyboard: true })).toBe(false);
  });
});
