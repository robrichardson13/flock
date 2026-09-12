#!/usr/bin/env bun
/**
 * Generate the "chrome" app-icon set (flock board card #2, candidate A from card #1's
 * audit at `docs/adr` … see the card resolution for the full report) and write it into
 * `packages/web/public/`.
 *
 * One source shape — the three-chevron Formation mark from `packages/web/src/Mark.tsx`,
 * reproduced here as raw path data since this script runs outside the React tree — is
 * recomposed into every tile the app needs: favicon (svg + 32/16 raster, with a 16px
 * two-chevron optical variant), apple-touch-icon 180, manifest `any` 192/512, manifest
 * `maskable` 192/512 (56% scale, inside the 80% safe circle), and a white-on-transparent
 * push badge.
 *
 * Candidate A puts the mark on the app's own chrome surface: tile `#191919` (`--bg-chrome`),
 * mark `#33d0b0` (`--accent`), 6.2:1 contrast. Every raster is produced by screenshotting the
 * SVG in headless Chrome (ImageMagick's SVG delegate is unavailable in this environment —
 * no rsvg-convert) and measuring/trimming with ImageMagick, so the mark is optically centred
 * from its true rendered ink rather than a guessed transform.
 *
 * Deterministic and bounded: every size list, colour and fraction below is a fixed constant,
 * there is no network access, and the whole run does a fixed ~20 renders. Re-run with
 * `bun run scripts/gen-icons.ts` after touching this file; the outputs are committed, not
 * generated at build time.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((p): p is string => !!p);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error("gen-icons: no Chrome/Chromium found; set CHROME_BIN to a headless-capable binary");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, "..");
const publicDir = join(repoRoot, "packages/web/public");

const TILE = "#191919"; // --bg-chrome
const MARK = "#33d0b0"; // --accent
const WHITE = "#ffffff";

// Formation mark path data (packages/web/src/Mark.tsx), under the shared "bank" transform.
const LEAD = `<path d="M17.4 17.4 L23.4 13.3 L29.4 17.4"/>`;
const TRAIL = `<path d="M5.4 10.6 L10.4 7.2 L15.4 10.6"/><path d="M5.4 25.4 L10.4 22 L15.4 25.4"/>`;
const bank = (paths: string, color: string, sw: number) =>
  `<g fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" transform="translate(-0.6 -1.2) rotate(-12 16 16)">${paths}</g>`;

const work = await mkdtemp(join(tmpdir(), "flock-icons-"));
const MAX_RENDERS = 40;
let renders = 0;

async function shot(html: string, dest: string, px: number) {
  if (++renders > MAX_RENDERS) throw new Error("gen-icons: render budget exceeded");
  const src = join(work, `w-${renders}.html`);
  await Bun.write(src, html);
  await $`${CHROME} --headless --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --screenshot=${dest} --window-size=${px},${px} ${"file://" + src}`
    .quiet()
    .nothrow();
}

/** Render an SVG as an <img> at exact pixel size — reliable at small sizes, unlike screenshotting the SVG file directly. */
async function renderSvg(svg: string, dest: string, px: number) {
  const src = join(work, `s-${renders}.svg`);
  await Bun.write(src, svg);
  await shot(
    `<style>html,body{margin:0;background:transparent}img{display:block;width:${px}px;height:${px}px}</style><img src="file://${src}">`,
    dest,
    px,
  );
}

/** Render the bare mark large and read its true ink bounding box out of the pixels. */
async function measure(body: string): Promise<{ cx: number; cy: number; w: number }> {
  const dest = join(work, `probe-${renders}.png`);
  await renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 32 32">${body}</svg>`, dest, 1024);
  const info = await $`magick ${dest} -fuzz 1% -trim -format "%w %h %X %Y" info:`.text();
  const [w, h, x, y] = info.trim().split(/\s+/).map((v) => Number(v.replace("+", "")));
  return { cx: (x! + w! / 2) / 32, cy: (y! + h! / 2) / 32, w: w! / 32 };
}

/** A 32x32-viewBox tile SVG with the mark scaled to `frac` of tile width, dead centre. */
async function tileSvg(opts: { tileFill: string | null; body: string; frac: number; rx?: number }) {
  const m = await measure(opts.body);
  const s = (opts.frac * 32) / m.w;
  const tx = 16 - m.cx * s;
  const ty = 16 - m.cy * s;
  const bg =
    opts.tileFill === null
      ? ""
      : `<rect width="32" height="32"${opts.rx !== undefined ? ` rx="${opts.rx}"` : ""} fill="${opts.tileFill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${bg}<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(4)})">${opts.body}</g></svg>`;
}

async function writePublic(name: string, svg: string) {
  await Bun.write(join(publicDir, name), svg);
}

// ---- favicon.svg (also the source-of-truth tile shape) ----
const faviconBody = bank(LEAD + TRAIL, MARK, 3.0);
const faviconSvg = await tileSvg({ tileFill: TILE, rx: 6, body: faviconBody, frac: 0.72 });
await writePublic("favicon-v2.svg", faviconSvg);

// ---- favicon-32 / favicon-16 (16px gets the two-chevron optical variant, §6.2 of the audit) ----
const favicon32Body = bank(LEAD + TRAIL, MARK, 3.4);
const favicon32Svg = await tileSvg({ tileFill: TILE, rx: 6, body: favicon32Body, frac: 0.74 });
await renderSvg(favicon32Svg, join(publicDir, "favicon-v2-32.png"), 32);

const favicon16Body = bank(LEAD + `<path d="M5.4 10.6 L10.4 7.2 L15.4 10.6"/>`, MARK, 4.0);
const favicon16Svg = await tileSvg({ tileFill: TILE, rx: 6, body: favicon16Body, frac: 0.78 });
await renderSvg(favicon16Svg, join(publicDir, "favicon-v2-16.png"), 16);

// ---- apple-touch-icon 180 (full bleed, opaque; iOS applies its own squircle mask) ----
const appleBody = bank(LEAD + TRAIL, MARK, 3.0);
const appleSvg = await tileSvg({ tileFill: TILE, body: appleBody, frac: 0.68 });
const appleRaw = join(work, "apple-touch-raw.png");
await renderSvg(appleSvg, appleRaw, 180);
await $`magick ${appleRaw} -background ${TILE} -alpha remove -alpha off ${join(publicDir, "apple-touch-icon-v2.png")}`.quiet();

// ---- manifest icons, purpose:any (192/512, modest opaque corner radius) ----
const anyBody = bank(LEAD + TRAIL, MARK, 3.0);
const anySvg = await tileSvg({ tileFill: TILE, rx: 6, body: anyBody, frac: 0.7 });
for (const px of [192, 512] as const) {
  const raw = join(work, `icon-any-${px}.png`);
  await renderSvg(anySvg, raw, px);
  await $`magick ${raw} -background ${TILE} -alpha remove -alpha off ${join(publicDir, `icon-v2-${px}.png`)}`.quiet();
}

// ---- manifest icons, purpose:maskable (56% scale => bbox diagonal 0.71, inside the 80% safe circle) ----
const maskableBody = bank(LEAD + TRAIL, MARK, 3.0);
const maskableSvg = await tileSvg({ tileFill: TILE, body: maskableBody, frac: 0.56 });
for (const px of [192, 512] as const) {
  const raw = join(work, `icon-maskable-${px}.png`);
  await renderSvg(maskableSvg, raw, px);
  await $`magick ${raw} -background ${TILE} -alpha remove -alpha off ${join(publicDir, `icon-v2-${px}-maskable.png`)}`.quiet();
}

// ---- push badge: white silhouette on transparent, no tile (Chrome renders `badge` as a monochrome alpha mask) ----
const badgeBody = bank(LEAD + TRAIL, WHITE, 3.4);
const badgeSvg = await tileSvg({ tileFill: null, body: badgeBody, frac: 0.86 });
await renderSvg(badgeSvg, join(publicDir, "badge-v2-96.png"), 96);

await rm(work, { recursive: true, force: true });
console.log(`gen-icons: wrote ${renders} render(s) worth of assets to ${publicDir}`);
