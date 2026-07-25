/**
 * Server-side allowlist sanitizer for inbound email HTML (security review M6).
 *
 * `inbound_emails.body_html` is raw HTML written by arbitrary — usually spoofed — external senders, and
 * it was stored verbatim and served verbatim in the admin console's DTO. The only mitigation was a code
 * comment asking clients not to render it. That is not a control: any console surface that ever renders
 * it (now or after a refactor) gives an external attacker script execution in an operator's browser,
 * and because the CSRF cookie is JS-readable (L3), console XSS is a complete authorization bypass.
 *
 * DESIGN. No HTML parser is vendored — the repo's dependency posture keeps the inbound path minimal and
 * `pnpm audit --prod` already flags the mail stack (H13). This is a conservative, DENY-BY-DEFAULT
 * tokenizer instead:
 *
 *   - Dangerous ELEMENTS (script/style/iframe/object/embed/svg/math/link/meta/base/form/…) are removed
 *     ALONG WITH THEIR CONTENT, so `<script>` bodies never survive as text that a later innerHTML would
 *     re-parse.
 *   - Every remaining tag is checked against a small allowlist of inert formatting elements. A tag not
 *     on the list is dropped, but its inner TEXT is kept (an email in a `<table>` layout stays legible).
 *   - Every attribute is dropped except `href`/`title` on `<a>` and `alt`/`title` on `<img>`, and `href`
 *     must be http/https/mailto. That kills `on*=` handlers, `javascript:`/`data:` URIs, `style=`
 *     (CSS-based exfiltration and clickjacking overlays), and `srcset`.
 *   - HTML comments (including the `<!--[if IE]>` conditional-comment trick) are removed entirely.
 *   - `<img src>` is deliberately NOT preserved: a remote image is a tracking pixel that also leaks the
 *     operator's IP and read-time to the sender. The alt text survives.
 *
 * Because this is a tokenizer rather than a full parser, it is intentionally BLUNT: anything it cannot
 * confidently classify is dropped. Losing formatting on an exotic message is an acceptable trade for a
 * control that cannot be forgotten by a downstream renderer. `bodyText` remains the preferred surface.
 */

/** Elements removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "template",
  "noscript",
  "form",
  "button",
  "select",
  "textarea",
  "option",
  "title",
  "head",
])

/**
 * Dangerous elements that are VOID — the parser never expects a closing tag, so there is no content
 * span to swallow.
 *
 * Keeping these in DROP_WITH_CONTENT was a silent data-loss bug: that regex ends with `(?:</tag>|$)`,
 * and since `</meta>` never exists the alternation fell through to `$` and deleted everything from the
 * tag to the end of the document. Practically every MIME HTML email opens with `<meta charset>` or
 * `<meta http-equiv>`, so `sanitizeInboundHtml('<meta charset="utf-8"><p>body</p>')` returned `""` —
 * and because sanitization happens at WRITE time, the body was discarded permanently.
 */
const DROP_VOID = new Set(["input", "link", "meta", "base", "embed", "source", "track", "param"])

/** Inert formatting elements that may survive. Everything else is unwrapped (text kept, tag dropped). */
const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "ul",
])

/** Void elements that must not be emitted with a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img"])

/** Per-tag attribute allowlist. Any attribute not listed here for its tag is dropped. */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["alt", "title"]),
}

/** URL schemes permitted in `href`. Anything else (javascript:, data:, vbscript:, file:) is dropped. */
const SAFE_URL_RE = /^(?:https?:|mailto:)/i

/**
 * Hard cap on the HTML we will sanitize + store. Well above a normal email body; a message over the cap
 * keeps no HTML at all (bodyText still carries the content). Bounds worst-case tokenizer work on an
 * unauthenticated path, matching the posture of INBOUND_OBJECT_MAX_BYTES upstream.
 */
export const INBOUND_HTML_MAX_CHARS = 512 * 1024

/**
 * Start-of-tag matcher, applied STICKY at the character after a `<`.
 *
 * The name run is `[^\s/>]*`, NOT `[a-zA-Z0-9]*\b`. `_` is a regex word character, so the old `\b`
 * could never match a name like `div_`: that tag matched nothing at all, fell through the rewrite as raw
 * text, and carried its `on*=` handlers into the stored body. Browsers parse `<div_>` as
 * HTMLUnknownElement, which extends HTMLElement and therefore honours every GlobalEventHandlers content
 * attribute plus `style` and `autofocus` — so `<div_ onmouseover="…">` fired in an operator's browser,
 * and with a JS-readable CSRF cookie that is a full admin authorization bypass. Consuming the whole run
 * means `div_` is matched, tested against ALLOWED_TAGS, and dropped.
 */
const TAG_NAME_RE = /\/?([a-zA-Z][^\s/>]*)/y

/**
 * Sanitize inbound HTML. Returns null for null/undefined/empty input or input over the size cap, so the
 * caller stores NULL rather than a partially-processed body.
 */
export function sanitizeInboundHtml(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null
  if (html.length === 0) return null
  if (html.length > INBOUND_HTML_MAX_CHARS) return null

  // 1. Strip comments first. A conditional comment (`<!--[if mso]> <script> …`) would otherwise hide a
  //    dangerous element from the tag scan while still being parsed by some renderers.
  let working = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
  // 2. Strip CDATA and doctype/processing-instruction constructs.
  working = working.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, "").replace(/<![^>]*>/g, "")

  // 3. Remove drop-with-content elements and everything between them, INCLUDING an unclosed one (an
  //    unterminated `<script>` must swallow the remainder rather than leaking its source as text).
  for (const tag of DROP_WITH_CONTENT) {
    working = working.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:</${tag}\\s*>|$)`, "gi"), "")
  }
  // 3b. Void dangerous elements: drop the single tag only. Swallowing to `$` here would delete the rest
  //     of the document, since these never have a closing tag (see DROP_VOID).
  for (const tag of DROP_VOID) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "")
  }

  // 4. Rewrite the remaining tags: allowlisted ones keep allowlisted attributes; everything else is
  //    unwrapped (dropped, contents preserved). DENY BY DEFAULT — every `<` in the input is consumed by
  //    this pass and either rewritten as a known-good tag (see TAG_NAME_RE) or neutralized to `&lt;`.
  //    Nothing reaches the output as a raw `<`.
  //
  //    Hand-rolled rather than one global regex replace: the obvious pattern
  //    (`<\/?([a-zA-Z][^\s/>]*)([^>]*)>|<`) is QUADRATIC on adversarial input, because for every `<` in
  //    a body with no `>` after it, `[^>]*` scans the whole remainder before failing. Measured at 7.6s on
  //    a 512 KB `"<a "`-repeated body — a DoS on an unauthenticated intake path. This scan visits each
  //    character a bounded number of times: `gt` is cached so each `>` is located once, and a `<` that
  //    does not begin a tag is settled with a sticky O(1) match instead of a slice.
  let out = ""
  let i = 0
  let gt = -2 // cached position of the next `>`; only recomputed once it falls behind the cursor
  for (;;) {
    const lt = working.indexOf("<", i)
    if (lt === -1) {
      out += working.slice(i)
      break
    }
    out += working.slice(i, lt)

    // Does a tag name start immediately after the `<`? Matched STICKY against the source so a `<` that
    // does not begin a tag costs O(1) instead of a slice. No leading whitespace is tolerated, matching
    // browsers: `< div>` is text, not a tag.
    TAG_NAME_RE.lastIndex = lt + 1
    const m = TAG_NAME_RE.exec(working)
    if (m === null) {
      // Not a tag start (`3 < 5`). Escape this one `<` and RESCAN from the next character — crucially
      // not from the next `>`, or a real tag sitting inside the skipped span (`3 < 5 and <div onclick=…>`)
      // would be swallowed into escaped text with its own `<` still raw, which is a bypass.
      out += "&lt;"
      i = lt + 1
      continue
    }

    if (gt < lt) gt = working.indexOf(">", lt + 1)
    if (gt === -1) {
      // No `>` remains anywhere, so nothing in the tail can close a tag. Neutralize every `<` at once.
      out += working.slice(lt).replace(/</g, "&lt;")
      break
    }

    const name = (m[1] ?? "").toLowerCase()
    if (!ALLOWED_TAGS.has(name)) {
      out += "" // unwrap: tag dropped, contents preserved
    } else if (working[lt + 1] === "/") {
      out += VOID_TAGS.has(name) ? "" : `</${name}>`
    } else {
      out += `<${name}${sanitizeAttributes(name, working.slice(TAG_NAME_RE.lastIndex, gt))}>`
    }
    i = gt + 1
  }
  return out
}

/** Rebuild an element's attribute string from the per-tag allowlist. Values are re-quoted and escaped. */
function sanitizeAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag]
  if (!allowed || raw.trim().length === 0) return ""

  const out: string[] = []
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(raw)) !== null) {
    const name = (m[1] ?? "").toLowerCase()
    if (!allowed.has(name)) continue
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")
    if (name === "href" && !SAFE_URL_RE.test(value.trim())) continue
    out.push(`${name}="${escapeAttr(value)}"`)
  }
  return out.length > 0 ? ` ${out.join(" ")}` : ""
}

/**
 * Decode the entity forms an attacker uses to hide a scheme from a naive prefix check
 * (`&#106;avascript:`, `&#x6a;avascript:`, `&Tab;`). Decoding BEFORE the scheme test is what makes the
 * test meaningful; the value is re-escaped on output.
 */
function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
        safeFromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);?/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
      .replace(/&(?:tab|newline);/gi, "")
      .replace(/&amp;/gi, "&")
      // Control characters and whitespace are stripped so `java\tscript:` / `java\nscript:` — which
      // browsers tolerate inside a URL scheme — cannot slip past SAFE_URL_RE.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0020]/g, "")
  )
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
  try {
    return String.fromCodePoint(code)
  } catch {
    return ""
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
