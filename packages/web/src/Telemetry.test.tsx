import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessSessionTelemetry } from "./api.ts";
import { ActorTelemetryStrip, RunBlock } from "./Telemetry.tsx";

const session = (over: Partial<HarnessSessionTelemetry> = {}): HarnessSessionTelemetry => ({
  key: "claude-code:abc",
  actor: "harness-web",
  observedAt: "2026-09-12T00:00:00.000Z",
  alsoWorked: [],
  ...over,
});

describe("RunBlock absence (ADR 0026 §5: an unlinked board looks unchanged)", () => {
  it("renders nothing at all when telemetry is empty", () => {
    const html = renderToStaticMarkup(
      <RunBlock telemetry={[]} duration={{ claimedAt: null, closedAt: null, ms: null }} status="doing" />,
    );
    expect(html).toBe("");
  });

  it("renders the group once there is at least one session", () => {
    const html = renderToStaticMarkup(
      <RunBlock telemetry={[session()]} duration={{ claimedAt: null, closedAt: null, ms: null }} status="todo" />,
    );
    expect(html).toContain('aria-label="Run"');
  });
});

describe("RunBlock unknown readings", () => {
  it("never renders a live session's unknown cost as $0.00", () => {
    const html = renderToStaticMarkup(
      <RunBlock
        telemetry={[session({ model: "claude-opus-5", costUsd: undefined })]}
        duration={{ claimedAt: "2026-09-12T00:00:00.000Z", closedAt: null, ms: null }}
        status="doing"
      />,
    );
    expect(html).not.toContain("$0.00");
    expect(html).toContain("—");
  });

  it("renders a real zero cost as $0.00, not as unknown", () => {
    const html = renderToStaticMarkup(
      <RunBlock
        telemetry={[session({ model: "claude-opus-5", costUsd: 0 })]}
        duration={{ claimedAt: null, closedAt: "2026-09-12T00:00:00.000Z", ms: 60_000 }}
        status="done"
      />,
    );
    expect(html).toContain("$0.00");
  });

  it("falls back to the declared model, and still says unknown for context with neither half", () => {
    const html = renderToStaticMarkup(
      <RunBlock
        telemetry={[session({ declaredModel: "opus" })]}
        duration={{ claimedAt: null, closedAt: null, ms: null }}
        status="todo"
      />,
    );
    expect(html).toContain("opus");
    expect(html).not.toContain("undefined");
  });

  it("shows the also-worked note only when the session touched other cards", () => {
    const withOthers = renderToStaticMarkup(
      <RunBlock telemetry={[session({ alsoWorked: [6, 7] })]} duration={{ claimedAt: null, closedAt: null, ms: null }} status="todo" />,
    );
    expect(withOthers).toContain("also worked #6, #7");
    const withoutOthers = renderToStaticMarkup(
      <RunBlock telemetry={[session()]} duration={{ claimedAt: null, closedAt: null, ms: null }} status="todo" />,
    );
    expect(withoutOthers).not.toContain("also worked");
  });
});

describe("ActorTelemetryStrip", () => {
  it("renders nothing when the actor has no telemetry", () => {
    const html = renderToStaticMarkup(
      <ActorTelemetryStrip telemetry={[]} totals={{ sessions: 0, costUsd: null, costExact: true, toolCalls: null }} />,
    );
    expect(html).toBe("");
  });

  it("renders a dash for null totals rather than $0.00 or 0 tools", () => {
    const html = renderToStaticMarkup(
      <ActorTelemetryStrip telemetry={[session()]} totals={{ sessions: 1, costUsd: null, costExact: true, toolCalls: null }} />,
    );
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("0 tools");
  });

  it("marks an inexact total cost", () => {
    const html = renderToStaticMarkup(
      <ActorTelemetryStrip
        telemetry={[session(), session({ key: "claude-code:def" })]}
        totals={{ sessions: 2, costUsd: 4.5, costExact: false, toolCalls: 3 }}
      />,
    );
    expect(html).toContain("$4.50+");
  });
});

describe("card 16 polish (conductor's review of ADR 0026's web half)", () => {
  const duration = { claimedAt: null, closedAt: null, ms: null };

  it("says 'also worked' once for the block, not once per row", () => {
    const html = renderToStaticMarkup(
      <RunBlock
        telemetry={[
          session({ key: "claude-code:a", model: "claude-opus-5", alsoWorked: [2] }),
          session({ key: "claude-code:b", model: "claude-sonnet-5", alsoWorked: [2, 3] }),
        ]}
        duration={duration}
        status="doing"
      />,
    );
    expect(html.match(/also worked/g)?.length).toBe(1);
    expect(html).toContain("also worked #2, #3");
  });

  it("drops an all-dashes session row when a readable session is there to show", () => {
    const html = renderToStaticMarkup(
      <RunBlock
        telemetry={[session({ key: "claude-code:empty" }), session({ key: "claude-code:real", model: "claude-opus-5" })]}
        duration={duration}
        status="doing"
      />,
    );
    expect(html.match(/class="run-row"/g)?.length).toBe(1);
    expect(html).toContain("claude-opus-5");
  });

  it("keeps an all-dashes row when it is the only session", () => {
    const html = renderToStaticMarkup(
      <RunBlock telemetry={[session({ key: "claude-code:empty" })]} duration={duration} status="doing" />,
    );
    expect(html.match(/class="run-row"/g)?.length).toBe(1);
  });

  it("hides the actor totals strip for a single session and shows it for two", () => {
    const one = renderToStaticMarkup(
      <ActorTelemetryStrip telemetry={[session()]} totals={{ sessions: 1, costUsd: null, costExact: true, toolCalls: null }} />,
    );
    expect(one).not.toContain("actor-totals");
    const two = renderToStaticMarkup(
      <ActorTelemetryStrip
        telemetry={[session(), session({ key: "claude-code:def" })]}
        totals={{ sessions: 2, costUsd: null, costExact: true, toolCalls: null }}
      />,
    );
    expect(two).toContain("actor-totals");
  });
});
