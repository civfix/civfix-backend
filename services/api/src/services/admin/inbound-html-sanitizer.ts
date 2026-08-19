
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

const DROP_VOID = new Set(["input", "link", "meta", "base", "embed", "source", "track", "param"])

const RAW_TEXT_DROP = new Set(["script", "style", "title", "textarea", "noscript"])

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

const VOID_TAGS = new Set(["br", "hr", "img"])

const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["alt", "title"]),
}

const SAFE_URL_RE = /^(?:https?:|mailto:)/i

export const INBOUND_HTML_MAX_CHARS = 512 * 1024

const TAG_NAME_RE = /\/?([a-zA-Z][^\s/>]*)/y

export function sanitizeInboundHtml(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null
  if (html.length === 0) return null
  if (html.length > INBOUND_HTML_MAX_CHARS) return null

  let working = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
  working = working.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, "").replace(/<![^>]*>/g, "")

  for (const tag of DROP_WITH_CONTENT) {
    const close = `</${tag}\\b[^>]*>`
    const pattern = RAW_TEXT_DROP.has(tag)
      ? `<${tag}\\b[\\s\\S]*?(?:${close}|$)`
      : `<${tag}\\b[\\s\\S]*?${close}`
    working = working.replace(new RegExp(pattern, "gi"), "")
  }
  for (const tag of DROP_VOID) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "")
  }

  let out = ""
  let i = 0
  let gt = -2
  for (;;) {
    const lt = working.indexOf("<", i)
    if (lt === -1) {
      out += working.slice(i)
      break
    }
    out += working.slice(i, lt)

    TAG_NAME_RE.lastIndex = lt + 1
    const m = TAG_NAME_RE.exec(working)
    if (m === null) {
      out += "&lt;"
      i = lt + 1
      continue
    }

    if (gt < lt) gt = working.indexOf(">", lt + 1)
    if (gt === -1) {
      out += working.slice(lt).replace(/</g, "&lt;")
      break
    }

    const name = (m[1] ?? "").toLowerCase()
    if (!ALLOWED_TAGS.has(name)) {
      out += ""
    } else if (working[lt + 1] === "/") {
      out += VOID_TAGS.has(name) ? "" : `</${name}>`
    } else {
      out += `<${name}${sanitizeAttributes(name, working.slice(TAG_NAME_RE.lastIndex, gt))}>`
    }
    i = gt + 1
  }
  return out
}

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

function decodeEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) =>
        safeFromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);?/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
      .replace(/&(?:tab|newline);/gi, "")
      .replace(/&amp;/gi, "&")
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
