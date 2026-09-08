/**
 * The `theme-color` meta, kept in step with the app's own chrome colour (#31).
 *
 * This lived in `lab.ts` while there was a lab — the dials could move the chrome colour, so
 * the sync had to run whenever one did. #50 removed the lab; the sync outlived it, because
 * the colour still changes when the system flips light and dark, and because the metas in
 * `index.html` are literals written before the app runs.
 *
 * `--bg-chrome`, not `--bg` (#31): where the platform paints a bar of its own from this
 * colour — the iOS home-screen app's status bar, Safari's chrome, Android's — the strip sits
 * directly against the app's top bar, and the page colour behind it read as a black band
 * above the nav bar on a home-screen install. The chrome colour makes the two one surface.
 */
export function syncThemeColor() {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return;
  // Resolved through an element: the computed value of an unregistered custom property is
  // the literal `var(--bg-2)` token chain, which iOS rejects and then paints the page colour.
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;background-color:var(--bg-chrome)";
  document.body.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (!bg || bg === "rgba(0, 0, 0, 0)") return;
  // One unqualified meta carrying the computed colour, which follows the scheme anyway;
  // a `media`-qualified one is not read everywhere.
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const [first, ...rest] = metas;
  if (!first) return;
  first.removeAttribute("media");
  first.content = bg;
  for (const meta of rest) meta.remove();
}

syncThemeColor();
// `--bg-chrome` also changes when the system flips light and dark, and nothing else fires
// then, so the meta has to follow the media query too.
try {
  globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => syncThemeColor());
} catch {
  /* Older Safari has no addEventListener on a MediaQueryList; the metas just stay put. */
}
