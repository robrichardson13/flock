import { describe, expect, test } from "bun:test";
import { planImage } from "./images.ts";

describe("planImage", () => {
  test("gif is always as-is, never re-encoded", () => {
    expect(planImage({ mime: "image/gif", width: 4000, height: 4000, size: 10 * 1024 * 1024 })).toEqual({
      action: "as-is",
      mime: "image/gif",
      maxEdge: 1568,
    });
  });

  test("small png under the edge and size cap is as-is", () => {
    expect(planImage({ mime: "image/png", width: 800, height: 600, size: 100 * 1024 })).toEqual({
      action: "as-is",
      mime: "image/png",
      maxEdge: 1568,
    });
  });

  test("large png (over the byte cap) is reencoded to jpeg", () => {
    expect(planImage({ mime: "image/png", width: 800, height: 600, size: 1024 * 1024 })).toEqual({
      action: "reencode",
      mime: "image/jpeg",
      maxEdge: 1568,
    });
  });

  test("oversized jpeg is reencoded", () => {
    expect(planImage({ mime: "image/jpeg", width: 4000, height: 3000, size: 6 * 1024 * 1024 })).toEqual({
      action: "reencode",
      mime: "image/jpeg",
      maxEdge: 1568,
    });
  });

  test("2000px png (over the edge cap) is reencoded", () => {
    expect(planImage({ mime: "image/png", width: 2000, height: 1200, size: 200 * 1024 })).toEqual({
      action: "reencode",
      mime: "image/jpeg",
      maxEdge: 1568,
    });
  });

  test("unsupported mime throws", () => {
    expect(() => planImage({ mime: "application/pdf", width: 10, height: 10, size: 10 })).toThrow();
  });
});
