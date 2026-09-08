import { describe, expect, it } from "bun:test";
import { topBarShape } from "./TopBar.tsx";

describe("topBarShape", () => {
  it("is home with no board at all", () => {
    expect(topBarShape(false, false, false)).toBe("home");
    // A card slot held with no board on the route is not a real state, but the route wins.
    expect(topBarShape(false, true, true)).toBe("home");
  });

  it("is board on a board route with no card", () => {
    expect(topBarShape(true, false, false)).toBe("board");
    expect(topBarShape(true, false, true)).toBe("board");
  });

  it("is card while the route names a card and the card slot is held", () => {
    expect(topBarShape(true, true, true)).toBe("card");
  });

  it("falls back to board the instant the card slot is released, even before the route catches up", () => {
    // This is the close case: BoardView holds `route.card` for the length of the exit
    // animation, but CardPage yields its slot the moment `closing` goes true.
    expect(topBarShape(true, true, false)).toBe("board");
  });
});
