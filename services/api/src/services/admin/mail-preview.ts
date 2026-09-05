
export const PREVIEW_LEN = 140

export const PREVIEW_SOURCE_CHARS = 400

export const HTML_PREVIEW_SOURCE_CHARS = 4096

export function toPreview(body: string | null | undefined, html?: string | null): string {
  const fromText = collapse(body ?? "")
  if (fromText.length > 0) return truncate(fromText)
  if (html === undefined || html === null || html.length === 0) return ""
  return truncate(collapse(htmlToText(html)))
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style"])

const HTML_TAG_NAME_RE = /[a-zA-Z][^\s/>]{0,16}/y

function tagNameAt(html: string, at: number): { name: string; end: number } | null {
  HTML_TAG_NAME_RE.lastIndex = at
  const m = HTML_TAG_NAME_RE.exec(html)
  return m === null ? null : { name: m[0].toLowerCase(), end: HTML_TAG_NAME_RE.lastIndex }
}

function rawTextCloseAt(html: string, name: string, from: number): number {
  let i = from
  for (;;) {
    const at = html.indexOf("</", i)
    if (at === -1) return html.length
    const parsed = tagNameAt(html, at + 2)
    if (parsed !== null && parsed.name === name) return at
    i = at + 2
  }
}

export function htmlToText(html: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const lt = html.indexOf("<", i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    if (html.startsWith("!--", lt + 1)) {
      const end = html.indexOf("-->", lt + 4)
      out += " "
      if (end === -1) break
      i = end + 3
      continue
    }

    const gt = html.indexOf(">", lt + 1)
    if (gt === -1) break
    out += " "
    i = gt + 1

    if (html[lt + 1] === "/") continue
    const parsed = tagNameAt(html, lt + 1)
    if (parsed === null || !RAW_TEXT_ELEMENTS.has(parsed.name)) continue
    const close = rawTextCloseAt(html, parsed.name, i)
    if (close >= html.length) break
    const closeGt = html.indexOf(">", close)
    if (closeGt === -1) break
    out += " "
    i = closeGt + 1
  }
  return decodeTextEntities(out)
}

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
