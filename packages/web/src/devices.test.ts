import { describe, expect, it } from "bun:test";
import { deviceLabel } from "./devices.ts";

const UA = {
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iPad:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  mac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

describe("deviceLabel", () => {
  it("labels an iPhone, Safari assumed and not appended", () => {
    expect(deviceLabel(UA.iPhone)).toBe("iPhone");
  });

  it("labels an iPad, Safari assumed and not appended", () => {
    expect(deviceLabel(UA.iPad)).toBe("iPad");
  });

  it("labels a Mac, Safari assumed and not appended", () => {
    expect(deviceLabel(UA.mac)).toBe("Mac");
  });

  it("labels a Mac running Chrome", () => {
    expect(deviceLabel(UA.macChrome)).toBe("Mac · Chrome");
  });

  it("labels Windows running Edge (checked before the bare Chrome match)", () => {
    expect(deviceLabel(UA.windowsEdge)).toBe("Windows · Edge");
  });

  it("labels Windows running Firefox", () => {
    expect(deviceLabel(UA.windowsFirefox)).toBe("Windows · Firefox");
  });

  it("labels Android", () => {
    expect(deviceLabel(UA.android)).toBe("Android · Chrome");
  });

  it("labels Linux", () => {
    expect(deviceLabel(UA.linux)).toBe("Linux · Chrome");
  });

  it("falls back to Unknown device for null", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
  });

  it("falls back to Unknown device for an unrecognized platform", () => {
    expect(deviceLabel("SomeBot/1.0")).toBe("Unknown device");
  });

  it("is case-insensitive", () => {
    expect(deviceLabel("mozilla iphone chrome/1")).toBe("iPhone · Chrome");
  });

  it("caps the output at 40 characters", () => {
    expect(deviceLabel(UA.windowsEdge).length).toBeLessThanOrEqual(40);
  });
});
