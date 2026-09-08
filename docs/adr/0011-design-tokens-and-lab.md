# ADR 0011: A design token layer, iOS-native type, a human/agent colour axis, and one theme chosen in the app

**Status:** accepted, 2026-09-06 (amended the same day: the theme was chosen and the variants removed — see *The choice*)

## Context

The web app grew screen by screen. Every rule named its own numbers — fifteen distinct font sizes between 10.5px and 28px, eight radii, spacing literals of 10 and 14 alongside the 4/8/12/16 scale, durations from 140ms to 260ms, and colour written as hexes at the point of use. Nothing was wrong in isolation and nothing agreed with anything else. The audit on card #1 put the two costs plainly: the phone reads as a web page rather than an iOS app, mostly because the type is a size or two small and metadata is everywhere; and a change to any of it means finding every literal by hand.

Two things were also genuinely undecided. The palette: the maintainer asked to see the candidate directions in the running app rather than pick from a static page. And the brand mark: three candidates, same problem.

## Decision

**One token layer, and no literal below it.** `styles.css` opens with the tokens and every rule after it reads them.

- **Type** — `--t-large/title/head/body/sub/foot/cap` (28/22/17/17/15/13/12) each with a line-height token. Sizes are the iOS ones: body is 17, not 14. 11px and 10.5px are gone; 12 is the floor, and the tab-bar label at 10 is the single exception. Mono (`--mono`) is for `code` and nothing else — not card numbers, paths, timestamps or labels. Numbers are tabular.
- **Spacing, radius, elevation** — `--s1..--s6` (4/8/12/16/24/32), `--r-sm/md/lg/full` (6/12/20/999), `--elev-1` for a card on a grouped background and `--elev-2` for sheets. `--tap` is 44 on the phone.
- **Motion** — `--ease-out` and `--ease-spring`, `--d-fast/base/slow` (150/220/320ms). The JS timers that must outlive a CSS animation mirror them as `D_FAST/D_BASE/D_SLOW` rather than hardcoding a second copy.
- **Colour** — two layers. The theme (a neutral ramp, the hues, and the ink that sits on a filled hue) declared once for dark and once for light; the semantics — identity tints, derived surfaces, `--ink-*` / `--status-*` / `--bar-*` / `--name-*` — derived on top and shared by both schemes. A rule below the token block never names a hex. While the choice was open this was five layers, with the palettes and the dials underneath the semantics; collapsing it did not move a single computed value.

**Colour's primary axis is human versus agent, not status.** Flock is a board humans watch and agents work. So the identity tints are two families: five warm ones for people, five cool ones for machines, hashed from the actor's name. Anything that needs a human reads warm — `awaiting-human` moved off amber onto the human hue. Status keeps the conventional greens and reds but sits second. Each family is spread across a wide arc of hue rather than clustered, because the common view is four avatars side by side in a header stack; near-identical hues make that stack unreadable. All twenty tints clear 4.5:1 behind white initials.

**Contrast is a gate, not a review.** `scripts/contrast.ts` parses the tokens out of `styles.css` — the stylesheet, not a copy of its values — and asserts 4.5:1 for every foreground on every surface it can land on, in both schemes. It exists because a hex is easy to nudge and `--muted` on the recessed surface is not a pair anyone looks at on purpose. While the dials were up it replayed each of them the way the cascade does and checked 13030 pairs; against the single theme it checks 124. It runs inside `bun test` either way.

**The Lab was a dev-only tool for deciding in the running app.** Whatever was undecided shipped as a runtime dial, switchable from a floating pill and a sheet, persisted in `localStorage` by `lab.ts` and mirrored onto `<html>` as `data-*` so the stylesheet keyed off it and no component subscribed. `?lab=<value>` overrode for one visit without writing. This existed so the maintainer could dial a choice in on the device, against real boards, instead of judging a mockup — and so the answer arrived as a screenshot of the app rather than as an argument. It was removed once the choice was made (see *The choice*).

## The choice

Six palettes and four dials went through it. A Dusk and B Slate first (card #4), then C Moss and D Ink (#9), then E Fog and F Linen alongside a colour-reach dial — minimal, quiet, full — that decides how far hue travels into the app independently of which palette is on (#12), then a re-tune of quiet and a contrast dial, normal and high (#17). With warmth and tint that is 13030 painted combinations, which is exactly why nobody could have picked from a page of swatches.

The maintainer picked by living with them on the phone: **B Slate · Formation · warmth 0 · tint 0 · colour full · contrast normal**, dark by default and light when the system asks for it. A neutral ramp with no cast, no accent leaking into the surfaces, teal for the machines and amber for the people, and the mark that still reads as three birds at 16px.

Card #18 collapsed that combination into the base tokens and deleted everything it beat: five palettes in both schemes, the three neutral ramps, all four dial layers, the two unused marks with their icons and manifests, and every `data-*` attribute that no longer meant anything. The check was mechanical rather than visual — the computed value of every custom property on `<html>` was dumped for the chosen combination before and after, resolved through a probe element so a `color-mix` and a literal compare as colours: 134 tokens, zero differences in either scheme.

**The Lab has since gone too.** Card #18 collapsed the winning combination into the base tokens and the Lab kept running for one more round of dials (surface, density, type, edge inset, headings); commit `4c5e9bc` then baked those last picks into `:root` and deleted `Lab.tsx`, `lab.ts` and `lab.test.ts`, moving `syncThemeColor` into `theme-color.ts`. The token layer is what survived the exercise; the switcher was scaffolding.

## Consequences

- A type or spacing change is one token edit, and the desktop block inherits it.
- Reading `--bg` is one hop again. While the dials were up it meant reading a ramp, a warmth rule, a contrast rule and a semantic rule; that indirection was the price of deciding in the app, and it was paid off the moment the decision was made.
- The semantic layer stays even though there is only one theme to map onto it. A rule asks for `--status-blocked`, not for amber, which is what made collapsing five layers into two a change with no visible effect — and what would make a second theme cheap if there is ever a reason for one.
- Light is still implemented and still follows the system. Locking the app to dark would be a separate decision.
- The app icon's tile was still the Dusk indigo gradient when this was written; the five PNGs and the favicon were re-rendered in Slate teal shortly after (`2c9d3a7`), so nothing of the losing palette survives.
- `.webmanifest` needed a MIME entry in the server; without one no browser will install the app.
