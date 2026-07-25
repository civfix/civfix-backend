/**
 * The ONE preview policy for every mail surface: the admin inbox list, the mail thread list, and the
 * thread DTO's `preview` field. Pure, no I/O.
 *
 * The inbox list already truncated to 140 chars while the mail thread list shipped the latest message's
 * FULL body per row (tens of KB per inbound municipal reply, times a 25-row page). One collapse + one
 * length now serves both; the repositories additionally SELECT only a bounded prefix of the body, so the
 * bytes never leave Postgres.
 */

/** Preview length in characters (post-whitespace-collapse). */
export const PREVIEW_LEN = 140

/**
 * How much body text a repository needs to SELECT to build a full-length preview. Generous over
 * PREVIEW_LEN because collapsing runs of whitespace shortens the source.
 */
export const PREVIEW_SOURCE_CHARS = 400

/**
 * How much body HTML a repository needs to SELECT for the HTML fallback: tags, comments and (on legacy
 * rows stored before server-side sanitization) style blocks are dropped before the text is measured, so
 * the source has to be substantially longer than the text case.
 */
export const HTML_PREVIEW_SOURCE_CHARS = 4096

/**
 * Collapse a body to a single-line preview, truncated to PREVIEW_LEN. `html` is a fallback for the
 * text-less message: mailparser produces no `text` part for an HTML-only email, which used to render an
 * empty preview in the inbox even though the message had content.
 */
export function toPreview(body: string | null | undefined, html?: string | null): string {
  const fromText = collapse(body ?? "")
  if (fromText.length > 0) return truncate(fromText)
  if (html === undefined || html === null || html.length === 0) return ""
  return truncate(collapse(htmlToText(html)))
}

/**
 * Strip HTML down to legible text for a preview. NOT a sanitizer (see inbound-html-sanitizer.ts for the
 * write-time control) — the output is plain text with every tag removed, so it is inert by construction.
 *
 * Scanning is deliberately linear: the obvious `/<[^>]*>/g` is quadratic on a body full of unclosed `<`,
 * which is attacker-controlled input on the inbound path.
 */
export function htmlToText(html: string): string {
  // Elements whose CONTENT is not body text. Only reachable on rows stored before the write-time
  // sanitizer (it removes these outright), but a legacy row must not preview as a wall of CSS.
  let working = html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
  working = working.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")

  let out = ""
  let i = 0
  for (;;) {
    const lt = working.indexOf("<", i)
    if (lt === -1) {
      out += working.slice(i)
      break
    }
    out += working.slice(i, lt)
    const gt = working.indexOf(">", lt + 1)
    // An unterminated tag runs to the end of the (truncated) source: nothing legible follows.
    if (gt === -1) break
    out += " "
    i = gt + 1
  }
  return decodeTextEntities(out)
}

/** The handful of entities worth decoding for a preview; anything else survives as its escape. */
function decodeTextEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncate(value: string): string {
  return value.length > PREVIEW_LEN ? value.slice(0, PREVIEW_LEN) : value
}
