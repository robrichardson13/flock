/**
 * Contrast gate for the colour system (cards #4, #9, #12, #17 and #18).
 *
 * While the Lab was up this checked six palettes against four dials — thirteen thousand
 * pairs, because a dial that moves a *background* invalidates every foreground checked
 * against the old one. Card #18 baked one theme in, so what is left is the theme itself in
 * its two schemes; the gate stays because the reason for it never was the dials. A hex is
 * still easy to nudge and hard to eyeball, and `--muted` on `--bg-3` is not a pair anyone
 * looks at on purpose.
 *
 * Reading the stylesheet rather than a copy of the values is the point — a hex edited there
 * and not here would pass a duplicated table and fail on the phone.
 *
 * Card #19 added the second half: token pairs are only the truth if the ink lands on the
 * page at the value the token says, and a container `opacity` moves every foreground under
 * it without touching a single pair. See *the opacity gate* below.
 *
 *   bun run scripts/contrast.ts          # table + exit 1 on any failure
 *   bun run scripts/contrast.ts --quiet  # failures only
 */

import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../packages/web/src/styles.css", import.meta.url), "utf8");
const DESKTOP_CSS = readFileSync(new URL("../packages/web/src/board-desktop.css", import.meta.url), "utf8");
const AA = 4.5;

/* ---------- colour ---------- */

type RGB = [number, number, number];

function hex(v: string): RGB {
  const h = v.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as RGB;
}

/** `color-mix(in srgb, a p%, b)`: a straight blend of the gamma-encoded sRGB coordinates. */
const mix = (a: RGB, p: number, b: RGB): RGB => a.map((c, i) => c * p + b[i] * (1 - p)) as RGB;

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function ratio(fg: RGB, bg: RGB): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/* ---------- parsing ---------- */

/**
 * Every `--token: #hex;` inside the `nth` rule whose opening matches `head`. A selector can
 * legitimately appear twice — `:root` opens the theme and, further down, the identity
 * tints — so which one is wanted has to be said.
 */
function body(head: string, nth = 0): string {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = CSS.indexOf(head, at + 1);
    if (at === -1) throw new Error(`styles.css has no rule ${nth} starting "${head}"`);
  }
  const rest = CSS.slice(at + head.length);
  // The rule ends at the first line that is nothing but a closing brace — which for a rule
  // nested inside the light media query is indented, so the brace cannot be anchored to
  // column zero or the match runs on into the next rule.
  const end = /\n *\}/.exec(rest);
  return rest.slice(0, end ? end.index : rest.length);
}

function block(head: string, nth = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, k, v] of body(head, nth).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[k] = v;
  return out;
}

/** The percentage in a `color-mix(in srgb, <a> P%, <b>)` declaration. */
function mixPct(ruleBody: string, token: string): number {
  const m = new RegExp(`--${token}:\\s*color-mix\\([^;]*?(\\d+(?:\\.\\d+)?)%`).exec(ruleBody);
  if (!m) throw new Error(`--${token} is not a color-mix in that rule`);
  return Number(m[1]) / 100;
}

/* The four top-level `:root` rules of the colour block, in the order the stylesheet
   declares them: the dark theme, the identity tints, the derived surfaces, the semantics.
   Anchored on a newline so the light theme — indented inside the media query, and fetched
   by its own head below — is not one of them. The assertions below are the guard: reorder
   or rename a block and the gate says so instead of silently checking the wrong rule. */
const DARK = block("\n:root {", 0);
const LIGHT = block("  :root {");
const IDS = block("\n:root {", 1);
const DERIVED = body("\n:root {", 2);
const SEMANTIC = body("\n:root {", 3);
for (const [name, has] of [["dark theme", "accent" in DARK], ["light theme", "accent" in LIGHT], ["identity tints", "id-ink" in IDS], ["derived surfaces", DERIVED.includes("--bg-me:")], ["semantics", SEMANTIC.includes("--status-doing:")]] as const) {
  if (!has) throw new Error(`styles.css: the ${name} rule is not where this script expects it`);
}

/** How much --human goes into your own message bubble, read from the stylesheet rather than
    retyped, because --text has to clear 4.5:1 on the surface that comes out. */
const TINT_ME = mixPct(DERIVED, "bg-me");

/** How much --accent goes into --accent-soft, which #38 made a surface: it is the tint behind
    the phone tab bar's active tab, so --ink-tab-active has to be legible on it. */
const TINT_ACCENT_SOFT = mixPct(DERIVED, "accent-soft");

/* ---------- the opacity gate (#19) ---------- */

/**
 * The second half of the gate, and the reason for it: the ratios above are only true if the
 * ink actually arrives on the page at the value the token says. A container `opacity` on an
 * ancestor multiplies every foreground under it and no token pair changes, so the table
 * above kept saying 4.5:1 while the desktop board rendered its titles at 2.49:1 — five
 * separate rules doing it, over most of the text on both main screens (#16 F1).
 *
 * So: a rule that carries text may not dim itself with an `opacity` between 0.3 and 0.95.
 * Below 0.3 is a scrim or a hidden thing, 0.95 and up is not a dimmer, 0 and 1 are the
 * reveal transitions — all fine. In between is the one gesture that lies to this file.
 *
 * Everything in both stylesheets is in scope, with two ways out and no third. A rule inside
 * a `@media (max-width: 899px)` block is the phone's own, and the phone pass has not
 * happened; that is why #19 moved `.board-row.state-complete`'s dimmer inside one instead of
 * leaving it unscoped, where it was quietly dimming six of Home's nine titles at 1920. The
 * four phone dimmers still declared at every width are named in `PHONE_DEBT` below — a list
 * that should only ever get shorter.
 */

/** A style rule, with the at-rules it is nested inside. */
type Rule = { file: string; selector: string; atRules: string[]; decls: string };

/** A small brace walker — enough CSS parser to know what a declaration is nested inside. */
export function rules(css: string, file: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let head = "";
  let decls = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") { i = css.indexOf("*/", i + 2) + 1; continue; }
    if (c === "{") {
      const sel = head.trim();
      head = "";
      if (sel.startsWith("@")) { stack.push(sel); decls = ""; continue; }
      // A style rule: take its declarations flat, up to the matching brace.
      let depth = 1;
      let bodyText = "";
      for (i++; i < css.length && depth > 0; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") { depth--; if (depth === 0) break; }
        bodyText += css[i];
      }
      out.push({ file, selector: sel, atRules: [...stack], decls: bodyText });
      continue;
    }
    if (c === "}") { stack.pop(); head = ""; decls = ""; continue; }
    head += c;
  }
  void decls;
  return out;
}

/** `--dial: 0.7;` anywhere in the sheet, so `opacity: var(--dial)` is not a blind spot. */
function numericTokens(...sheets: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const css of sheets) {
    for (const [, k, v] of css.matchAll(/--([a-z0-9-]+):\s*(\d*\.?\d+)\s*;/g)) out[k] = Number(v);
  }
  return out;
}

/** The opacity a rule declares, with one level of `var()` resolved. */
function declaredOpacity(decls: string, tokens: Record<string, number>): number | null {
  const m = /(?:^|[;{\s])opacity:\s*([^;}]+)/.exec(decls);
  if (!m) return null;
  const v = m[1].trim();
  if (/^\d*\.?\d+$/.test(v)) return Number(v);
  const ref = /^var\(\s*--([a-z0-9-]+)\s*\)$/.exec(v);
  return ref && ref[1] in tokens ? tokens[ref[1]] : null;
}

const PHONE_AT = /max-width:\s*(\d+)px/;

/** The phone's own dimmers, still declared at every width because the rules predate the
    desktop layout and moving them is a phone pass, not this one. Each is the same 2.5-3.5:1
    finding as the desktop ones #19 fixed, and each should leave this list by being fixed. */
const PHONE_DEBT = [
  ".card-row.blocked",
  ".card-row.status-done, .card-row.status-wontfix",
  ".section-count",
  ".actor-why",
];

/** Rules whose subtree is a glyph, an image or a scrim — nothing to read, nothing to gate.
    Kept short and literal on purpose: an entry here is a claim that the thing draws no text,
    and it should be as easy to challenge as it is to add. */
const NON_TEXT = [".chev", ".detail-chev", ".section-add", ".card-lock", ".card-check", ".avatar", "img", "::after", "::before", ".board-bar", ".sk-", ".scrim", ".backdrop"];

/** A disabled control is exempt from WCAG 1.4.3 and reads as disabled precisely by fading. */
const isDisabled = (sel: string) => sel.includes(":disabled") || sel.includes("[disabled]");

/** Rules that only exist when a developer asks for them by URL, and are never part of the app
    a reader is handed. The viewport readout (`?vv=1`) is the only one: it is a measuring
    instrument laid over the composer it is measuring, and its translucency is what lets the
    thing under test stay visible in a screenshot. Gating it would be gating the ruler. */
const DEV_ONLY = [".vv-readout"];

export type Dimmer = { file: string; selector: string; opacity: number };

export function findDimmers(sheets: { file: string; css: string; desktopOnly?: boolean }[]): Dimmer[] {
  const tokens = numericTokens(...sheets.map((s) => s.css));
  const out: Dimmer[] = [];
  for (const sheet of sheets) {
    for (const r of rules(sheet.css, sheet.file)) {
      if (r.atRules.some((a) => a.startsWith("@keyframes"))) continue;
      const phoneOnly = !sheet.desktopOnly
        && r.atRules.some((a) => { const m = PHONE_AT.exec(a); return !!m && Number(m[1]) < 900; });
      if (phoneOnly) continue;
      if (PHONE_DEBT.includes(r.selector.trim())) continue;
      if (isDisabled(r.selector)) continue;
      if (NON_TEXT.some((n) => r.selector.includes(n))) continue;
      if (DEV_ONLY.some((n) => r.selector.includes(n))) continue;
      const o = declaredOpacity(r.decls, tokens);
      if (o !== null && o > 0.3 && o < 0.95) out.push({ file: sheet.file, selector: r.selector, opacity: o });
    }
  }
  return out;
}

export const dimmers = findDimmers([
  { file: "styles.css", css: CSS },
  { file: "board-desktop.css", css: DESKTOP_CSS, desktopOnly: true },
]);

/* ---------- the check ---------- */

type Row = { combo: string; fg: string; bg: string; r: number };
const rows: Row[] = [];
const quiet = process.argv.includes("--quiet");

// Identity tints carry white initials and do not move with the scheme: checked once.
for (const [k, v] of Object.entries(IDS)) {
  if (k === "id-ink") continue;
  rows.push({ combo: "identity", fg: "id-ink", bg: k, r: ratio(hex(IDS["id-ink"]), hex(v)) });
}

for (const [scheme, t] of [["dark", DARK], ["light", LIGHT]] as const) {
  // The light block omits the tokens it inherits from the dark declaration; fold them in.
  const tok = { ...DARK, ...t };
  const accent = hex(tok.accent);
  const human = hex(tok.human);
  const text = hex(tok.text);
  const done = hex(tok.done);
  const surfaces: Record<string, RGB> = {
    bg: hex(tok.bg),
    "bg-2": hex(tok["bg-2"]),
    "bg-3": hex(tok["bg-3"]),
  };
  // --bg-chrome is --bg-2 today, and --bg-me is --bg-2 with a breath of --human in it.
  surfaces["bg-chrome"] = surfaces["bg-2"];
  surfaces["bg-me"] = mix(human, TINT_ME, surfaces["bg-2"]);
  // --accent-soft: the tinted pill behind the active tab on the phone's floating tab bar (#38).
  surfaces["accent-soft"] = mix(accent, TINT_ACCENT_SOFT, surfaces["bg-2"]);
  const combo = `Slate ${scheme}`;
  const on = (fg: string, colour: RGB, bgs: string[]) => {
    for (const b of bgs) rows.push({ combo, fg, bg: b, r: ratio(colour, surfaces[b]) });
  };
  // Where each foreground can actually land. --bg-3 is the recessed surface: pressed rows,
  // inline code, the segmented track and the image chips. Nothing coloured sits on it (the
  // chips moved up to --bg-2 for exactly this reason), so the hues are checked against the
  // three surfaces that do carry them, and the two neutrals — which a pressed row does put
  // on --bg-3 — against all four.
  const grounds = ["bg", "bg-2", "bg-chrome"];
  const all = [...grounds, "bg-3"];
  on("text", text, [...all, "bg-me", "accent-soft"]);
  on("muted", hex(tok.muted), all);
  // The dim ink (#19). It is what "finished", "blocked" and "empty" are painted with now
  // that they are not painted with an opacity, so it has to hold 4.5:1 everywhere --muted
  // does — including --bg-3, which every tile and row hovers to.
  on("muted-2", hex(tok["muted-2"]), all);
  on("accent", accent, grounds);
  on("human", human, grounds);
  on("done", done, grounds);
  on("warn", hex(tok.warn), grounds);
  on("danger", hex(tok.danger), grounds);
  // The semantic names the app actually paints with, checked as the colours they resolve to
  // rather than trusting that an alias cannot drift from what it aliases.
  on("ink-action", accent, grounds);
  on("ink-link", accent, grounds);
  on("ink-tab-active", accent, [...grounds, "accent-soft"]);
  on("status-doing", accent, grounds);
  on("status-await", human, grounds);
  on("status-done", done, grounds);
  on("status-blocked", hex(tok.warn), grounds);
  on("name-agent", accent, grounds);
  on("name-human", human, grounds);
  on("attention", human, grounds);
  // The inks that sit on a filled hue.
  rows.push({ combo, fg: "on-accent", bg: "accent", r: ratio(hex(tok["on-accent"]), accent) });
  rows.push({ combo, fg: "on-warn", bg: "warn", r: ratio(hex(tok["on-warn"]), hex(tok.warn)) });
  rows.push({ combo, fg: "on-human", bg: "human", r: ratio(hex(tok["on-human"]), human) });
}

export const failures = rows.filter((r) => r.r < AA);
export const pairsChecked = rows.length;
const fails = failures;

/** The readable summary: every foreground/background pair, per scheme, worst first. */
const groups = new Map<string, Map<string, number>>();
for (const r of rows) {
  const m = groups.get(r.combo) ?? new Map<string, number>();
  const key = `${r.fg} on ${r.bg}`;
  m.set(key, Math.min(m.get(key) ?? Infinity, r.r));
  groups.set(r.combo, m);
}

if (import.meta.main && !quiet) {
  for (const [g, m] of groups) {
    console.log(`\n## ${g}\n`);
    console.log("| pair | ratio | |");
    console.log("|---|---|---|");
    for (const [pair, r] of [...m].sort((a, b) => a[1] - b[1])) {
      console.log(`| ${pair} | ${r.toFixed(2)}:1 | ${r >= AA ? "pass" : "FAIL"} |`);
    }
  }
}

if (import.meta.main) {
  console.log(`\n${rows.length} pairs checked across one theme x 2 schemes. ${fails.length} below ${AA}:1.`);
  const bodyText = rows.filter((r) => r.fg === "text");
  const worst = bodyText.reduce((a, b) => (b.r < a.r ? b : a));
  console.log(`minimum body-text ratio: ${worst.r.toFixed(2)}:1  (${worst.combo}, ${worst.fg} on ${worst.bg})`);
  for (const f of fails) console.log(`  FAIL  ${f.combo}  ${f.fg} on ${f.bg}  ${f.r.toFixed(2)}:1`);
  console.log(`${dimmers.length} text-bearing rules dim themselves with an opacity in (0.3, 0.95).`);
  for (const d of dimmers) console.log(`  FAIL  ${d.file}  ${d.selector}  opacity: ${d.opacity}`);
  process.exit(fails.length || dimmers.length ? 1 : 0);
}
