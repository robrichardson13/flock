import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamMember } from "@flock/core/types";
import { ActorLinks, TeamStack } from "./ui.tsx";

/**
 * Routing regression for #30: every click in the cluster, faces included, opens the roster.
 * Faces used to carry their own tap-to-actor behaviour (`role="button"`, an `About <name>`
 * aria-label, and on desktop a `tabindex`), which intercepted the click before it reached the
 * stack's own button. `TeamStack` now renders every avatar `plain`, so none of that survives
 * into markup and a click has nowhere to go but the stack's `onClick`. This is checked by
 * static markup rather than a simulated click: `onClick` itself never serializes, but the
 * `role`/`tabindex`/`aria-label` a tappable avatar would carry all do, and their absence here
 * is exactly what stops the click from being handled by the face instead of the stack.
 */
const team: TeamMember[] = [
  { name: "rob", kind: "human", lastSeen: new Date().toISOString(), events: 3 },
  { name: "builder-1", kind: "agent", lastSeen: new Date().toISOString(), events: 5, model: "sonnet" },
  { name: "builder-2", kind: "agent", lastSeen: new Date(Date.now() - 1000 * 60 * 60).toISOString(), events: 1 },
];

function renderStack() {
  return renderToStaticMarkup(
    <ActorLinks boardRef="demo">
      <TeamStack team={team} cards={[]} onOpen={() => {}} />
    </ActorLinks>,
  );
}

describe("TeamStack routing (#30)", () => {
  it("renders exactly one focusable, labelled control: the stack button itself", () => {
    const html = renderStack();
    // The stack is a single <button> with the roster's aria-label.
    expect(html).toContain('<button class="team-stack"');
    expect(html).toContain('aria-label="Team: rob, builder-1, builder-2"');
  });

  it("gives no face its own role, tab stop, or actor aria-label", () => {
    const html = renderStack();
    // A tappable avatar (see Avatar in ui.tsx) renders role="button", a tabindex, and an
    // "About <name>" aria-label. None of that should appear anywhere in the stack: every
    // face is `plain`, so a click always falls through to the stack's own button.
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain('aria-label="About rob"');
    expect(html).not.toContain('aria-label="About builder-1"');
    expect(html).not.toContain('aria-label="About builder-2"');
  });

  it("marks every face aria-hidden, so only the stack's own label reaches assistive tech", () => {
    const html = renderStack();
    const avatarCount = (html.match(/class="avatar /g) ?? []).length;
    const hiddenCount = (html.match(/aria-hidden="true"/g) ?? []).length;
    expect(avatarCount).toBeGreaterThan(0);
    expect(hiddenCount).toBe(avatarCount);
  });

  it("still renders with no actor link context (a click has nowhere to navigate a face to)", () => {
    const html = renderToStaticMarkup(<TeamStack team={team} cards={[]} onOpen={() => {}} />);
    expect(html).toContain('<button class="team-stack"');
    expect(html).not.toContain('role="button"');
  });
});
