/**
 * The inline grammar for light message formatting: a pure, one-pass tokenizer with no
 * JSX and no DOM, so the renderer (`markdown.tsx`) can stay a thin layer over it and this
 * file can be unit tested directly.
 *
 * Precedence, first match wins at any given scan position: code, bold, strike, italic
 * (`*` then `_`), link, bare URL. Text between matches is a literal text token. Emphasis
 * recurses into its own contents (so `**bold with `code`**` works); recursion depth is
 * capped so adversarial input cannot blow the stack.
 *
 * The scan is character-by-character with `indexOf` for each delimiter's close, not one
 * big backtracking regex: a long run of bare `*` or `_` (adversarial or just a shell glob)
 * is then linear work, not exponential.
 */

export type InlineToken =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; kids: InlineToken[] }
  | { t: "link"; href: string; kids: InlineToken[] };

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** An allowlisted, absolute URL, or null. `javascript:`, `data:`, relative paths, and the like are rejected. */
export function safeHref(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
}

const MAX_DEPTH = 4;
const WORD_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;
// Parens are allowed in the run itself (wikipedia-style URLs use them); `trimBareUrl`
// strips a trailing one that has no matching open inside the match.
const BARE_URL_RE = /^(https?:\/\/[^\s<>[\]]+|mailto:[^\s<>[\]]+)/;

/**
 * Find a `delim ... delim` pair starting at `start` (which must point at the opening
 * delimiter), where the content hugs non-space on both sides. `afterCloseOk`, when given,
 * additionally gates the character immediately following the close (used for `_`'s word-
 * boundary rule); a close that fails it is skipped in favour of a later one. `beforeCloseOk`
 * does the same for the character immediately preceding the close (used to keep `_` from
 * closing right after another `_`, so a run like `__init__` doesn't produce nested `<em>`).
 *
 * `onNoClose` fires when the delimiter does not occur again anywhere ahead, which the
 * caller memoises: see `tokenizeInline`.
 */
function matchHug(
  s: string,
  start: number,
  delim: string,
  afterCloseOk?: (after: string) => boolean,
  beforeCloseOk?: (before: string) => boolean,
  onNoClose?: () => void,
): { content: string; end: number } | null {
  const contentStart = start + delim.length;
  if (contentStart >= s.length || WHITESPACE.test(s[contentStart]!)) return null;
  let searchFrom = contentStart + 1;
  while (true) {
    const close = s.indexOf(delim, searchFrom);
    if (close === -1) {
      onNoClose?.();
      return null;
    }
    if (WHITESPACE.test(s[close - 1]!)) {
      searchFrom = close + delim.length;
      continue;
    }
    if (beforeCloseOk && !beforeCloseOk(s[close - 1]!)) {
      searchFrom = close + delim.length;
      continue;
    }
    if (afterCloseOk) {
      const after = close + delim.length < s.length ? s[close + delim.length]! : "";
      if (!afterCloseOk(after)) {
        searchFrom = close + delim.length;
        continue;
      }
    }
    return { content: s.slice(contentStart, close), end: close + delim.length };
  }
}

/**
 * `[text](url)` starting at `s[i] === "["`. Null if the bracket/paren shape isn't there at
 * all. The url's closing paren is found by balance, not the first `)`, so a url containing
 * its own parens (`javascript:alert(1)`, a wikipedia-style path) is captured whole.
 */
function matchLink(s: string, i: number): { text: string; href: string | null; raw: string; end: number } | null {
  const closeBracket = s.indexOf("]", i + 1);
  if (closeBracket === -1 || s[closeBracket + 1] !== "(") return null;
  let depth = 1;
  let j = closeBracket + 2;
  while (j < s.length && depth > 0) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") depth--;
    if (depth === 0) break;
    j++;
  }
  if (depth !== 0) return null;
  const text = s.slice(i + 1, closeBracket);
  const url = s.slice(closeBracket + 2, j);
  const end = j + 1;
  return { text, href: safeHref(url), raw: s.slice(i, end), end };
}

/** Trim trailing sentence punctuation and an unmatched closing paren off a bare-URL match. */
function trimBareUrl(raw: string): { url: string; trailer: string } {
  let url = raw;
  let trailer = "";
  for (;;) {
    if (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        trailer = ")" + trailer;
        continue;
      }
    }
    const m = url.match(/[.,;:!?'"]+$/);
    if (m) {
      url = url.slice(0, -m[0].length);
      trailer = m[0] + trailer;
      continue;
    }
    break;
  }
  return { url, trailer };
}

function matchBareUrl(s: string, i: number): { tokens: InlineToken[]; end: number } | null {
  const m = BARE_URL_RE.exec(s.slice(i));
  if (!m) return null;
  const raw = m[1]!;
  const { url, trailer } = trimBareUrl(raw);
  const end = i + raw.length;
  const href = safeHref(url);
  if (!href) return { tokens: [{ t: "text", v: raw }], end };
  const tokens: InlineToken[] = [{ t: "link", href, kids: [{ t: "text", v: url }] }];
  if (trailer) tokens.push({ t: "text", v: trailer });
  return { tokens, end };
}

/**
 * Link text is re-parsed inline, so a bare URL or a second `[...]()` inside `[...]` would
 * produce an anchor nested in an anchor: invalid markup, and a click target with no defined
 * behaviour. Keep the inner link's own content, drop its anchor.
 */
function flattenLinks(tokens: InlineToken[]): InlineToken[] {
  const out: InlineToken[] = [];
  for (const t of tokens) {
    if (t.t === "link") out.push(...flattenLinks(t.kids));
    else if (t.t === "strong" || t.t === "em" || t.t === "del") out.push({ t: t.t, kids: flattenLinks(t.kids) });
    else out.push(t);
  }
  return out;
}

export function tokenizeInline(s: string, depth = 0): InlineToken[] {
  if (depth > MAX_DEPTH) return s ? [{ t: "text", v: s }] : [];
  const out: InlineToken[] = [];
  let textStart = 0;
  let i = 0;
  // A delimiter with no further occurrence anywhere ahead cannot open at any later position
  // either, so remember that and stop trying. Without this memo a long run of unmatched
  // openers (`*a *a *a ...`, a shell transcript, a wall of underscores) rescans to the end
  // of the string from every one of them, which is quadratic: a 50KB message took over a
  // second. With it the same message is linear and takes single-digit milliseconds.
  const noClose = new Set<string>();
  const hug = (
    delim: string,
    afterCloseOk?: (after: string) => boolean,
    beforeCloseOk?: (before: string) => boolean,
  ) => (noClose.has(delim) ? null : matchHug(s, i, delim, afterCloseOk, beforeCloseOk, () => noClose.add(delim)));
  const flushText = (end: number) => {
    if (end > textStart) out.push({ t: "text", v: s.slice(textStart, end) });
  };
  while (i < s.length) {
    const c = s[i];

    if (c === "`") {
      const close = s.indexOf("`", i + 1);
      if (close !== -1 && close > i + 1) {
        flushText(i);
        out.push({ t: "code", v: s.slice(i + 1, close) });
        i = close + 1;
        textStart = i;
        continue;
      }
    } else if (c === "*" && s[i + 1] === "*") {
      const m = hug("**");
      if (m) {
        flushText(i);
        out.push({ t: "strong", kids: tokenizeInline(m.content, depth + 1) });
        i = m.end;
        textStart = i;
        continue;
      }
    } else if (c === "~" && s[i + 1] === "~") {
      const m = hug("~~");
      if (m) {
        flushText(i);
        out.push({ t: "del", kids: tokenizeInline(m.content, depth + 1) });
        i = m.end;
        textStart = i;
        continue;
      }
    } else if (c === "*") {
      const m = hug("*");
      if (m) {
        flushText(i);
        out.push({ t: "em", kids: tokenizeInline(m.content, depth + 1) });
        i = m.end;
        textStart = i;
        continue;
      }
    } else if (c === "_") {
      const before = i > 0 ? s[i - 1]! : "";
      // `_` also refuses to open when the next character is another `_` (so `__init__`,
      // `__all__` never even attempt to pair up), and refuses to close when the preceding
      // character is a `_` (so a run of three-or-more trailing underscores can't hand a
      // valid-looking pair back to the recursive call). `_init_` still italicises: single
      // underscores on both sides pass both gates.
      if (!WORD_CHAR.test(before) && s[i + 1] !== "_") {
        const m = hug(
          "_",
          (after) => !WORD_CHAR.test(after),
          (b) => b !== "_",
        );
        if (m) {
          flushText(i);
          out.push({ t: "em", kids: tokenizeInline(m.content, depth + 1) });
          i = m.end;
          textStart = i;
          continue;
        }
      }
    } else if (c === "[") {
      const m = matchLink(s, i);
      if (m) {
        flushText(i);
        if (m.href) out.push({ t: "link", href: m.href, kids: flattenLinks(tokenizeInline(m.text, depth + 1)) });
        else out.push({ t: "text", v: m.raw });
        i = m.end;
        textStart = i;
        continue;
      }
    } else if (c === "h" && (s.startsWith("http://", i) || s.startsWith("https://", i))) {
      const m = matchBareUrl(s, i);
      if (m) {
        flushText(i);
        out.push(...m.tokens);
        i = m.end;
        textStart = i;
        continue;
      }
    } else if (c === "m" && s.startsWith("mailto:", i)) {
      const m = matchBareUrl(s, i);
      if (m) {
        flushText(i);
        out.push(...m.tokens);
        i = m.end;
        textStart = i;
        continue;
      }
    }

    i++;
  }
  flushText(s.length);
  return out;
}
