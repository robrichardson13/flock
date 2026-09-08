import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installNoScrollFocus } from "./focus.ts";
import "./styles.css";
import "./board-desktop.css";
import "./brand.css";
import "./compose.css";
import "./viewer.css";
// Importing this syncs the theme-color meta to the app's chrome colour, before the first
// paint.
import "./theme-color.ts";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/*
 * Keyboard handling on iOS Safari.
 *
 * The phone shell is a fixed element sized to the visual viewport (`--vvh`), so a
 * composer pinned to its bottom edge already sits above the keyboard. Safari does not
 * know that: on focus it scrolls the layout viewport to reveal the input anyway, and
 * that scroll takes the whole shell off screen and leaves it there. Undo it — on focus
 * and blur, and whenever the visual viewport moves or resizes while a field is focused.
 * Nothing is ever hidden by snapping back, because the shell fits the visible area.
 */
const isField = (el: EventTarget | Element | null) =>
  el instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(el.tagName);
const phone = () => window.matchMedia("(max-width: 899px)").matches;
const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;

const snapBack = () => {
  if (!phone() || zoomed()) return;
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
};
/*
 * Snapping the shell back is enough for anything pinned to its edges, but not for a
 * field that lives inside one of the shell's scrollers: the scroller shrinks with the
 * shell, and the field can end up below its new bottom edge with nothing to move it.
 * So after the shell is back, walk up to the nearest scrolling ancestor and scroll the
 * focused field into it. Generic on purpose — it covers the new-card sheet, the
 * Needs-you answer box, and any inline field added later, without per-form wiring.
 */
const SCROLL_MARGIN = 12;

const scrollerOf = (el: HTMLElement) => {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY;
    if (/^(auto|scroll|overlay)$/.test(overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
};

const revealField = () => {
  if (!phone() || zoomed()) return;
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !isField(field)) return;
  const scroller = scrollerOf(field);
  if (!scroller) return;
  const f = field.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (f.bottom > box.bottom - SCROLL_MARGIN) scroller.scrollTop += f.bottom - (box.bottom - SCROLL_MARGIN);
  else if (f.top < box.top + SCROLL_MARGIN) scroller.scrollTop -= box.top + SCROLL_MARGIN - f.top;
};

const settle = () => { snapBack(); revealField(); };

// The keyboard animates in, and Safari's own scroll lands somewhere in the middle of
// that; one snap is not enough, so keep snapping until it has settled.
const snapBackWhileSettling = () => {
  settle();
  requestAnimationFrame(settle);
  for (const delay of [50, 150, 300, 600]) setTimeout(settle, delay);
};

/*
 * #34: in a home-screen app, iOS can leave the layout viewport shrunk after the keyboard
 * has been up once — every height API drops by the status bar's height and stays there
 * until the app is force-quit, which is a fixed shell that ends short and a band of bare
 * canvas under it. Forcing the full-height shell through a display flip after the field
 * blurs makes WebKit re-measure the viewport. A no-op whenever nothing shrank.
 */
let tallest = window.innerHeight;
window.addEventListener("resize", () => { tallest = Math.max(tallest, window.innerHeight); });
const healViewport = () => {
  if (!phone() || isField(document.activeElement) || tallest - window.innerHeight <= 4) return;
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) return;
  app.style.display = "none";
  void app.offsetHeight;
  app.style.display = "";
};

/*
 * #34: iOS 26 samples the status bar colour from the top of the page when the home-screen
 * app comes back from the switcher, and has been seen landing on the wrong colour there.
 * A fresh paint of the shell at that moment is the one lever there is.
 */
const repaintShell = () => {
  if (!phone()) return;
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) return;
  app.style.display = "none";
  void app.offsetHeight;
  app.style.display = "";
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestAnimationFrame(repaintShell); });
window.addEventListener("pageshow", () => requestAnimationFrame(repaintShell));

/*
 * #10: the layout viewport, clamped synchronously.
 *
 * Everything above snaps the page back to 0 on focus, on blur, on a visualViewport event and
 * on four timers — every one of which is a *sample* of an animation WebKit is running on the
 * compositor. iOS scrolls the layout viewport on focus to reveal a field it thinks the
 * keyboard will cover (it does this even with `overflow: hidden` here, because the keyboard
 * opens scrollable room where there was none), and a `position: fixed` shell is laid out
 * against that viewport: it goes with the scroll, and comes back only when the next sample
 * lands. The scroll event is the one notice that arrives *with* the movement rather than
 * after it, and nothing was listening for it. Undo it in the handler, before the frame is
 * painted, so the shell is never off its mark for a frame it could have been on it.
 */
window.addEventListener("scroll", snapBack, { passive: true });
document.addEventListener("scroll", snapBack, { capture: true, passive: true });

/*
 * #13: stop the reveal instead of undoing it. Every snap above is a *sample* of a scroll
 * WebKit has already started; `preventScroll` on a scripted focus stops it being started at
 * all (WebKit 236584, Safari 15.5), and a tap only reaches `focus()` if the tap is
 * intercepted. The snapping stays as the guard it always was — WebKit deliberately allows
 * the document to scroll while the visual viewport is smaller than the layout one (WebKit
 * 240860), so nothing here can be a guarantee on its own.
 */
installNoScrollFocus();

document.addEventListener("focusin", (e) => {
  if (!isField(e.target)) return;
  // #13: while a field holds focus its own chin is a scroll container with real range, so a
  // reveal that happens anyway lands there instead of escalating to the document. Only then:
  // at rest the chin must not be draggable. See `.pane-foot` in styles.css.
  document.documentElement.dataset.fieldFocus = "";
  snapBackWhileSettling();
});
document.addEventListener("focusout", (e) => {
  if (!isField(e.target)) return;
  delete document.documentElement.dataset.fieldFocus;
  // Whatever the chin — or, #15, the sheet body — scrolled to during the focus goes back,
  // so it cannot be left holding the composer half off its own bottom edge.
  for (const foot of document.querySelectorAll<HTMLElement>(".pane-foot, .sheet:not(.sheet-compose) .sheet-body")) foot.scrollTop = 0;
  snapBackWhileSettling();
  setTimeout(healViewport, 200);
});
window.visualViewport?.addEventListener("resize", snapBackWhileSettling);
window.visualViewport?.addEventListener("scroll", () => { if (isField(document.activeElement)) settle(); });
