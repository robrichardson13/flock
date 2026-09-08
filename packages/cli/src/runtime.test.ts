import { afterEach, describe, expect, test } from "bun:test";
import { embeddedAssets, isStandalone, installScriptPath, skillPath, version, versionLine } from "./runtime.ts";

describe("version", () => {
  test("a checkout reports dev, so `am I running a release?` is answerable", () => {
    expect(version()).toBe("dev");
  });

  test("the line carries the target triple and the Bun version", () => {
    const os = process.platform === "win32" ? "windows" : process.platform;
    expect(versionLine()).toBe(`flock dev (bun-${os}-${process.arch}, bun ${Bun.version})`);
  });
});

describe("isStandalone", () => {
  afterEach(() => {
    delete (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable;
  });

  test("false when running from source", () => {
    expect(isStandalone()).toBe(false);
  });

  test("defers to Bun.isStandaloneExecutable when a later Bun defines it", () => {
    (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable = true;
    expect(isStandalone()).toBe(true);
    (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable = false;
    expect(isStandalone()).toBe(false);
  });
});

describe("embeddedAssets", () => {
  test("resolves rather than throwing, whether or not the manifest was generated", async () => {
    const assets = await embeddedAssets();
    if (assets !== undefined) expect(assets["/index.html"]).toBeString();
  });
});

describe("static embeds", () => {
  test("install.sh and SKILL.md resolve to real paths on disk in a checkout", async () => {
    expect(await Bun.file(installScriptPath).exists()).toBe(true);
    expect(await Bun.file(skillPath).exists()).toBe(true);
  });
});
