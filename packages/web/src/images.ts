/**
 * Pure planning for how an image should be sent, kept separate from the impure
 * `ImageBitmap` -> `<canvas>` -> `toBlob` work (which lives in the composer) so this is
 * testable without a canvas. See docs/adr/0007-image-attachments-on-messages.md.
 */

import { ATTACHMENT_MIMES } from "@flock/core/attachments";
export { ATTACHMENT_MIMES };

export const MAX_EDGE = 1568;
/** Below this, a PNG that already fits MAX_EDGE keeps its crisp text/alpha instead of re-encoding. */
const SMALL_PNG_BYTES = 512 * 1024;

export interface ImageInfo {
  mime: string;
  width: number;
  height: number;
  size: number;
}

export interface ImagePlan {
  action: "as-is" | "reencode";
  mime: string;
  maxEdge: typeof MAX_EDGE;
}

export function planImage(info: ImageInfo): ImagePlan {
  if (!(ATTACHMENT_MIMES as readonly string[]).includes(info.mime)) {
    throw new Error(`unsupported image type: ${info.mime}`);
  }
  // GIFs are never re-encoded: re-encoding would kill animation. They fail over the cap
  // rather than being resized.
  if (info.mime === "image/gif") return { action: "as-is", mime: info.mime, maxEdge: MAX_EDGE };

  const longEdge = Math.max(info.width, info.height);
  if (info.mime === "image/png" && longEdge <= MAX_EDGE && info.size < SMALL_PNG_BYTES) {
    return { action: "as-is", mime: info.mime, maxEdge: MAX_EDGE };
  }

  return { action: "reencode", mime: "image/jpeg", maxEdge: MAX_EDGE };
}
