import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Shared by every composer (channel, decisions, card comments): a textarea that grows
 * with its content, one line at a time, up to whatever `max-height` its CSS class sets
 * (see `.line-composer-input` / `.composer-input` in styles.css), then scrolls inside
 * itself rather than growing the page further.
 *
 * Returns a ref to attach to the textarea and a `resize` function to call manually —
 * a caller that clears the field after sending needs to collapse it back to one row
 * on the same frame, rather than wait for the effect below to catch up.
 */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    // #6: published alongside the inline height so the mobile line-quantized peek (styles.css,
    // `.composer-open:not(.composer-focused) .line-composer-input`) can interpolate its ceiling
    // *from* the grown height instead of only ever clamping down to a fixed endpoint.
    el.style.setProperty("--composer-grown-h", `${el.scrollHeight}px`);
  }, []);
  // Layout, not passive (#43): a restored multi-line draft is in the field on the first
  // paint, so a resize that waits for the next frame paints it one row tall and then grows
  // it, pushing the pane and the tab bar. Measuring before the frame is shown makes the
  // composer's height part of that first frame.
  useLayoutEffect(resize, [value, resize]);
  return { ref, resize };
}
