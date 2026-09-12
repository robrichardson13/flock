import { describe, expect, test } from "bun:test";
import { latchSwapIn, sheetBackdropClass } from "./sheetSwap.ts";

describe("latchSwapIn", () => {
  test("a sheet that opened without a swap never claims one", () => {
    expect(latchSwapIn(false, true, true, false)).toBe(false);
  });

  test("a swap on arrival latches on", () => {
    expect(latchSwapIn(false, true, false, true)).toBe(true);
  });

  // The regression itself: `BoardView` clears `swapping` after D_BASE while the sheet it
  // dressed is still open and settled. Following the live flag there is what restarted the
  // sheet's base entry animation and read as the panel re-appearing.
  test("the latch survives the flag expiring under a sheet that is still open", () => {
    expect(latchSwapIn(true, true, true, false)).toBe(true);
  });

  test("it survives the closing beat too, so the exit does not change animation mid-flight", () => {
    expect(latchSwapIn(true, false, true, false)).toBe(true);
  });

  test("it clears once the sheet is neither open nor closing, so the next open is a fresh decision", () => {
    expect(latchSwapIn(true, false, false, false)).toBe(false);
    expect(latchSwapIn(true, false, false, true)).toBe(false);
  });
});

describe("sheetBackdropClass", () => {
  test("a plain sheet is just the backdrop", () => {
    expect(sheetBackdropClass({ closing: false, swappedIn: false, closeSwap: false })).toBe("sheet-backdrop");
  });

  test("a swapped-in sheet at rest carries only the entry latch", () => {
    expect(sheetBackdropClass({ closing: false, swappedIn: true, closeSwap: false })).toBe("sheet-backdrop sheet-swapped");
  });

  // The entry rule is `:not(.closing)`, so a swapped-in sheet closing for an unrelated reason
  // (the roster's own ✕, Escape, the scrim) still plays its ordinary exit rather than a fade.
  test("closing without a swap keeps the entry latch but asks for the ordinary exit", () => {
    expect(sheetBackdropClass({ closing: true, swappedIn: true, closeSwap: false })).toBe("sheet-backdrop closing sheet-swapped");
  });

  test("a swap-driven close carries the exit latch", () => {
    expect(sheetBackdropClass({ closing: true, swappedIn: true, closeSwap: true })).toBe("sheet-backdrop closing sheet-swapped sheet-swap-out");
  });
});
