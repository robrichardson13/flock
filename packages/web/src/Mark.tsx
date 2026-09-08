/**
 * The brand: the mark, the wordmark, and the two locked up.
 *
 * Three concepts shipped as runtime variants (design brief, card #2 section 6) so the choice
 * could be made by living with them; card #18 baked Formation in and the other two came out. The
 * geometry here is the same geometry the direction page showed and the same geometry the
 * favicons and app icons were rendered from — one source, every size, no drift.
 *
 * Everything draws in `currentColor`, so a mark inherits the colour of whatever it sits in:
 * the topbar's ink on a board screen, the accent on Home, white on the app-icon tile.
 */


/**
 * Formation: three chevrons in a rising V, the lead one ahead and larger. Rotated as a
 * group so the whole formation banks, which is what makes it read as flight rather than
 * as three carets. Stroked, so it stays open at 16px where a filled bird would clog.
 */
function Formation() {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      transform="translate(-0.6 -1.2) rotate(-12 16 16)"
    >
      <path d="M17.4 17.4 L23.4 13.3 L29.4 17.4" />
      <path d="M5.4 10.6 L10.4 7.2 L15.4 10.6" />
      <path d="M5.4 25.4 L10.4 22 L15.4 25.4" />
    </g>
  );
}

export function Mark({ size = 24, className, title }: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      className={className ? `mark ${className}` : "mark"}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <Formation />
    </svg>
  );
}

/** "flock", set in SF Rounded where there is one. Styling lives in brand.css. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={className ? `wordmark ${className}` : "wordmark"}>flock</span>;
}

/** Mark plus wordmark: the lockup Home wears in its topbar. */
export function Brand({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `brand-lockup ${className}` : "brand-lockup"}>
      <Mark size={size} />
      <Wordmark />
    </span>
  );
}
