
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

const BLOCK_ELEMENTS = new Set(
  "blockquote br dd div dt h1 h2 h3 h4 h5 h6 hr li p pre table td th tr".split(" "),
)

const LINK_HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

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
  const lines: string[] = []
  let line = ""
  let quoteDepth = 0
  let preDepth = 0
  let href: string | null = null
  let anchorText = ""
  const breakLine = (): void => {
    const text = line.replace(/\s+/g, " ").trim()
    lines.push(quoteDepth > 0 && text !== "" ? `> ${text}` : text)
    line = ""
  }
  let i = 0
  for (;;) {
    const lt = html.indexOf("<", i)
    const segment = decodeTextEntities(html.slice(i, lt === -1 ? html.length : lt))
    const [first = "", ...rest] = preDepth > 0 ? segment.split(/\r?\n/) : [segment]
    line += first
    for (const row of rest) {
      breakLine()
      line += row
    }
    if (href !== null) anchorText += segment
    if (lt === -1) break

    if (html.startsWith("!--", lt + 1)) {
      const end = html.indexOf("-->", lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }

    const gt = html.indexOf(">", lt + 1)
    if (gt === -1) break
    i = gt + 1

    const closing = html[lt + 1] === "/"
    const parsed = tagNameAt(html, closing ? lt + 2 : lt + 1)
    if (parsed === null) continue
    if (BLOCK_ELEMENTS.has(parsed.name)) {
      breakLine()
      if (parsed.name === "blockquote") quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1))
      if (parsed.name === "pre") preDepth = Math.max(0, preDepth + (closing ? -1 : 1))
      continue
    }
    if (parsed.name === "a") {
      if (!closing) {
        const m = LINK_HREF_RE.exec(html.slice(parsed.end, gt))
        href = m === null ? null : decodeTextEntities(m[1] ?? m[2] ?? m[3] ?? "")
        anchorText = ""
      } else if (href !== null) {
        if (/^https?:\/\//i.test(href) && anchorText.trim() !== href) line += ` (${href})`
        href = null
      }
      continue
    }
    if (closing || !RAW_TEXT_ELEMENTS.has(parsed.name)) continue
    const close = rawTextCloseAt(html, parsed.name, i)
    if (close >= html.length) break
    const closeGt = html.indexOf(">", close)
    if (closeGt === -1) break
    i = closeGt + 1
  }
  breakLine()
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function decodeTextEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (_m, hex?: string, dec?: string) =>
      codePointText(hex !== undefined ? Number.parseInt(hex, 16) : Number(dec)),
    )
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
}

function codePointText(code: number): string {
  const invalid = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
  return String.fromCodePoint(invalid ? 0xfffd : code)
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncate(value: string): string {
  return value.length > PREVIEW_LEN ? value.slice(0, PREVIEW_LEN) : value
}
