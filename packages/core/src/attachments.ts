/** Image attachments on messages. See docs/adr/0007-image-attachments-on-messages.md. */

export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const ORPHAN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_ATTACHMENT_NAME_LENGTH = 200;
export const DEFAULT_ATTACHMENT_NAME = "attachment";

/**
 * Sanitize a client-supplied attachment filename before it is stored: strip control
 * characters (including CR/LF), strip quotes and backslashes that could break a
 * `content-disposition` header, and cap the length. Falls back to a default name if
 * nothing usable remains.
 */
export function sanitizeAttachmentName(name: string | null | undefined): string | null {
  if (name == null) return null;
  // eslint-disable-next-line no-control-regex
  const stripped = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/["'\\]/g, "")
    .trim();
  if (!stripped) return DEFAULT_ATTACHMENT_NAME;
  return stripped.slice(0, MAX_ATTACHMENT_NAME_LENGTH);
}

/** Lowercase, drop `;` parameters, and map the common `image/jpg` typo to `image/jpeg`. */
export function normalizeMime(s: string): string {
  const base = s.split(";")[0]!.trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

/** Sniff the real image type from magic bytes, independent of what was declared. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}
