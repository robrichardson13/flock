import { describe, expect, test } from "bun:test";
import { defaultScanLimits } from "./limits.ts";
import { scanTranscript } from "./claude-code-parse.ts";

const PROJ = new URL("../fixtures/claude-code/projects/-Users-test-project/", import.meta.url).pathname;
const ENDED = `${PROJ}8ea8caf2-d288-4e0a-89de-04c45158535c.jsonl`;
const SUBAGENT = `${PROJ}8ea8caf2-d288-4e0a-89de-04c45158535c/subagents/agent-6f2c0001.jsonl`;
const LIVE = `${PROJ}11111111-1111-1111-1111-111111111111.jsonl`;
const MALFORMED = `${PROJ}33333333-3333-3333-3333-333333333333.jsonl`;

describe("scanTranscript — ended session", () => {
  test("finds the last cost-state line when there are duplicates", async () => {
    const scan = await scanTranscript(ENDED);
    expect(scan?.costState?.totalCostUSD).toBeCloseTo(4.342646999999999);
    expect(scan?.costState?.totalDuration).toBe(1301269);
    expect(scan?.costState?.hasUnknownModelCost).toBe(false);
  });

  test("builds the tool-call histogram over every assistant line, not just the last", async () => {
    const scan = await scanTranscript(ENDED);
    expect(scan?.tools).toEqual({ Bash: 2, Edit: 1 });
    expect(scan?.toolCalls).toBe(3);
  });

  test("reads the last assistant line's model and usage", async () => {
    const scan = await scanTranscript(ENDED);
    expect(scan?.lastAssistant?.model).toBe("claude-opus-5");
    expect(scan?.lastAssistant?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 41029,
      cacheReadTokens: 147167,
      cacheWriteTokens: 1022,
    });
  });

  test("captures the first line's timestamp as startedAt", async () => {
    const scan = await scanTranscript(ENDED);
    expect(scan?.startedAt).toBe("2026-09-11T19:06:20.000Z");
  });

  test("is not partial for a small, well-formed file", async () => {
    const scan = await scanTranscript(ENDED);
    expect(scan?.partial).toBe(false);
  });
});

describe("scanTranscript — live session (no cost-state)", () => {
  test("costState is absent", async () => {
    const scan = await scanTranscript(LIVE);
    expect(scan?.costState).toBeUndefined();
  });

  test("still reports the last assistant usage and tool histogram", async () => {
    const scan = await scanTranscript(LIVE);
    expect(scan?.lastAssistant?.model).toBe("claude-sonnet-5");
    expect(scan?.tools).toEqual({ Bash: 1 });
  });
});

describe("scanTranscript — subagent transcript", () => {
  test("reads the subagent's own model, distinct from any parent model", async () => {
    const scan = await scanTranscript(SUBAGENT);
    expect(scan?.lastAssistant?.model).toBe("claude-sonnet-5");
    expect(scan?.tools).toEqual({ Read: 1 });
  });
});

describe("scanTranscript — malformed lines", () => {
  test("skips unparsable lines and still reads the well-formed ones around them", async () => {
    const scan = await scanTranscript(MALFORMED);
    expect(scan?.lastAssistant?.model).toBe("claude-sonnet-5");
    expect(scan?.toolCalls).toBe(1);
  });
});

describe("scanTranscript — missing or unreadable file", () => {
  test("returns null rather than throwing", async () => {
    expect(await scanTranscript(`${PROJ}does-not-exist.jsonl`)).toBeNull();
  });
});

describe("scanTranscript — bounded reads", () => {
  test("marks partial when the head scan byte cap is smaller than the file", async () => {
    const tinyLimits = defaultScanLimits({ headScanBytes: 10, tailScanBytes: 10_000 });
    const scan = await scanTranscript(ENDED, tinyLimits);
    expect(scan?.partial).toBe(true);
  });

  test("marks partial when the tool histogram hits its distinct-name cap", async () => {
    const cappedLimits = defaultScanLimits({ maxToolHistogramEntries: 1 });
    const scan = await scanTranscript(ENDED, cappedLimits);
    expect(scan?.partial).toBe(true);
    expect(Object.keys(scan?.tools ?? {}).length).toBe(1);
  });

  test("marks partial when the line count cap is smaller than the file", async () => {
    const fewLines = defaultScanLimits({ maxLines: 1 });
    const scan = await scanTranscript(ENDED, fewLines);
    expect(scan?.partial).toBe(true);
  });
});
