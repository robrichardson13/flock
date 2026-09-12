import { describe, expect, it } from "bun:test";
import { boardPrefixOf, notificationsToClose } from "./notifGroups.ts";

describe("boardPrefixOf", () => {
  it("extracts the board prefix from a channel route", () => {
    expect(boardPrefixOf("#/b/flock/channel")).toBe("#/b/flock/");
  });

  it("extracts the board prefix from a card route", () => {
    expect(boardPrefixOf("#/b/flock/c/12")).toBe("#/b/flock/");
  });

  it("is null for a non-board route", () => {
    expect(boardPrefixOf("#/")).toBeNull();
  });

  it("is null for a board route with no trailing segment", () => {
    expect(boardPrefixOf("#/b/flock")).toBeNull();
  });

  it("is null for null, undefined and non-strings", () => {
    expect(boardPrefixOf(null)).toBeNull();
    expect(boardPrefixOf(undefined)).toBeNull();
  });

  it("distinguishes boards with a shared prefix", () => {
    expect(boardPrefixOf("#/b/flock-2/channel")).toBe("#/b/flock-2/");
    expect(boardPrefixOf("#/b/flock-2/channel")).not.toBe(boardPrefixOf("#/b/flock/channel"));
  });
});

describe("notificationsToClose", () => {
  const tags = ["#/b/flock/channel", "#/b/flock/c/1", "#/b/other/channel", "#/"];

  it("keeps only tags for the given board", () => {
    expect(notificationsToClose(tags, "flock", 50)).toEqual(["#/b/flock/channel", "#/b/flock/c/1"]);
  });

  it("returns every tag when boardSlug is null", () => {
    expect(notificationsToClose(tags, null, 50)).toEqual(tags);
  });

  it("bounds the result to limit", () => {
    expect(notificationsToClose(tags, "flock", 1)).toEqual(["#/b/flock/channel"]);
    expect(notificationsToClose(tags, null, 2)).toEqual(tags.slice(0, 2));
  });

  it("never returns more than the available tags", () => {
    expect(notificationsToClose(["#/b/flock/channel"], "flock", 50)).toEqual(["#/b/flock/channel"]);
  });

  it("treats a negative limit as zero", () => {
    expect(notificationsToClose(tags, "flock", -1)).toEqual([]);
  });

  it("matches nothing for a board with no open notifications", () => {
    expect(notificationsToClose(tags, "nope", 50)).toEqual([]);
  });
});
