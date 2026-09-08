import { expect, test } from "bun:test";

import { dimmers, failures, findDimmers, pairsChecked } from "./contrast.ts";

/**
 * The gate, wired into `bun test` so a hex edited in styles.css cannot quietly drop a
 * foreground under 4.5:1 on a surface nobody screenshots — `--muted` on the recessed
 * surface, say, or your own message bubble.
 * `bun run scripts/contrast.ts` prints the whole table.
 */
test("every foreground clears 4.5:1 on every surface it can land on", () => {
  expect(pairsChecked).toBeGreaterThan(100);
  expect(failures.map((f) => `${f.combo} ${f.fg} on ${f.bg} ${f.r.toFixed(2)}:1`)).toEqual([]);
});

/**
 * The other half of the gate (#19). The table above kept saying 4.5:1 while five rules put a
 * container `opacity` on top of `--muted` and rendered the desktop board's titles at
 * 2.49:1 — a token pair cannot see an opacity on an ancestor, so the guardrail the repo
 * advertises was being satisfied by a stylesheet that then quietly broke it. The fixture is
 * the code as it stood before the fix: every one of those five rules, and the gate has to
 * name all five.
 */
const BEFORE_STYLES = `
:root { --head-count-opacity: 0.7; }
.board-row.state-complete { opacity: 0.7; }
@media (max-width: 899px) {
  .phone-only-dimmer { opacity: 0.6; }
}
@media (min-width: 900px) {
  .column:has(.section-empty) .column-head { opacity: 0.6; }
  .column-head .muted { margin-left: auto; opacity: var(--head-count-opacity); }
  .card-tile.blocked { opacity: 0.65; }
  .card-tile.status-done, .card-tile.status-wontfix { opacity: 0.6; }
  .card-tile-meta .runtime { opacity: 0; }
  .btn:disabled { opacity: 0.45; }
  .chev { opacity: 0.6; }
}
@keyframes fade-in { from { opacity: 0.5; } to { opacity: 1; } }
`;
const BEFORE_DESKTOP = `
@media (min-width: 900px) {
  .board-link-rich.state-complete { opacity: 0.7; }
}
`;

test("the opacity gate names every dimmer the desktop pass left behind", () => {
  const found = findDimmers([
    { file: "styles.css", css: BEFORE_STYLES },
    { file: "board-desktop.css", css: BEFORE_DESKTOP, desktopOnly: true },
  ]);
  expect(found.map((d) => `${d.file} ${d.selector} ${d.opacity}`).sort()).toEqual([
    "board-desktop.css .board-link-rich.state-complete 0.7",
    "styles.css .board-row.state-complete 0.7",
    "styles.css .card-tile.blocked 0.65",
    "styles.css .card-tile.status-done, .card-tile.status-wontfix 0.6",
    "styles.css .column-head .muted 0.7",
    "styles.css .column:has(.section-empty) .column-head 0.6",
  ]);
});

test("no rule in the shipped stylesheets dims text with an opacity", () => {
  expect(dimmers.map((d) => `${d.file} ${d.selector} opacity: ${d.opacity}`)).toEqual([]);
});
