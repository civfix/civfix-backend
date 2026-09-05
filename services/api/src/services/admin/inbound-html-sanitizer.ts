
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

const NON_SPACE_RE = /\S/

const ATTR_NAME_RE = /[a-zA-Z_:][-a-zA-Z0-9_:.]*/y

const UNQUOTED_VALUE_RE = /[^\s"'>]+/y

const SPACE_CHARS = new Set([" ", "\t", "\n", "\r", "\f", "\v"])

export const INBOUND_HTML_MAX_CHARS = 512 * 1024

const MAX_TAG_NAME_CHARS = 16

const TAG_NAME_RE = new RegExp(`[a-zA-Z][^\\s/>]{0,${MAX_TAG_NAME_CHARS}}`, "y")

const CDATA_OPEN = "[cdata["

interface TagName {
  name: string
  end: number
}

function readTagName(html: string, at: number): TagName | null {
  TAG_NAME_RE.lastIndex = at
  const m = TAG_NAME_RE.exec(html)
  if (m === null) return null
  return { name: m[0].toLowerCase(), end: TAG_NAME_RE.lastIndex }
}

function skipPast(html: string, from: number, terminator: string): number {
  const at = html.indexOf(terminator, from)
  return at === -1 ? html.length : at + terminator.length
}

function isCdataOpen(html: string, lt: number): boolean {
  return html.slice(lt + 2, lt + 2 + CDATA_OPEN.length).toLowerCase() === CDATA_OPEN
}

type MarkupStep =
  | { kind: "eof" }
  | { kind: "skip"; lt: number; next: number }
  | { kind: "stray"; lt: number }
  | { kind: "tail"; lt: number }
  | { kind: "tag"; lt: number; close: boolean; name: string; nameEnd: number }

function nextStep(html: string, from: number): MarkupStep {
  const lt = html.indexOf("<", from)
  if (lt === -1) return { kind: "eof" }
  if (html[lt + 1] === "!") {
    if (html.startsWith("--", lt + 2)) {
      return { kind: "skip", lt, next: skipPast(html, lt + 4, "-->") }
    }
    if (isCdataOpen(html, lt)) {
      return { kind: "skip", lt, next: skipPast(html, lt + 2 + CDATA_OPEN.length, "]]>") }
    }
    const gt = html.indexOf(">", lt + 2)
    if (gt === -1) return { kind: "tail", lt }
    return { kind: "skip", lt, next: gt + 1 }
  }
  const close = html[lt + 1] === "/"
  const parsed = readTagName(html, close ? lt + 2 : lt + 1)
  if (parsed === null) return { kind: "stray", lt }
  return { kind: "tag", lt, close, name: parsed.name, nameEnd: parsed.end }
}

function indexCloseTags(html: string): Map<string, number[]> {
  const index = new Map<string, number[]>()
  let i = 0
  for (;;) {
    const step = nextStep(html, i)
    if (step.kind === "eof") break
    if (step.kind === "skip") {
      i = step.next
      continue
    }
    if (step.kind === "tail") break
    if (step.kind === "stray") {
      i = step.lt + 1
      continue
    }
    if (step.close) {
      if (DROP_WITH_CONTENT.has(step.name)) {
        const slots = index.get(step.name)
        if (slots === undefined) index.set(step.name, [step.lt])
        else slots.push(step.lt)
      }
      i = step.lt + 2
      continue
    }
    if (RAW_TEXT_DROP.has(step.name)) {
      i = rawTextCloseAt(html, step.name, step.nameEnd)
      continue
    }
    i = step.lt + 1
  }
  return index
}

function rawTextCloseAt(html: string, name: string, from: number): number {
  let i = from
  for (;;) {
    const at = html.indexOf("</", i)
    if (at === -1) return html.length
    const parsed = readTagName(html, at + 2)
    if (parsed !== null && parsed.name === name) return at
    i = at + 2
  }
}

function closeAfter(
  index: Map<string, number[]>,
  cursors: Map<string, number>,
  name: string,
  lt: number,
): number {
  const slots = index.get(name)
  if (slots === undefined) return -1
  let k = cursors.get(name) ?? 0
  while (k < slots.length && (slots[k] ?? 0) <= lt) k += 1
  cursors.set(name, k)
  return k < slots.length ? (slots[k] ?? -1) : -1
}

export function sanitizeInboundHtml(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null
  if (html.length === 0) return null
  if (html.length > INBOUND_HTML_MAX_CHARS) return null

  const index = indexCloseTags(html)
  const cursors = new Map<string, number>()
  let out = ""
  let i = 0

  for (;;) {
    const step = nextStep(html, i)
    if (step.kind === "eof") {
      out += html.slice(i)
      break
    }
    out += html.slice(i, step.lt)
    if (step.kind === "skip") {
      i = step.next
      continue
    }
    if (step.kind === "tail") {
      out += html.slice(step.lt).replace(/</g, "&lt;")
      break
    }
    if (step.kind === "stray") {
      out += "&lt;"
      i = step.lt + 1
      continue
    }

    if (!step.close && DROP_WITH_CONTENT.has(step.name)) {
      const close = closeAfter(index, cursors, step.name, step.lt)
      if (close !== -1) {
        const gt = html.indexOf(">", close)
        if (gt === -1) break
        i = gt + 1
        continue
      }
      if (RAW_TEXT_DROP.has(step.name)) break
    }

    const gt = html.indexOf(">", step.lt + 1)
    if (gt === -1) {
      out += html.slice(step.lt).replace(/</g, "&lt;")
      break
    }
    if (ALLOWED_TAGS.has(step.name)) {
      if (step.close) {
        out += VOID_TAGS.has(step.name) ? "" : `</${step.name}>`
      } else {
        out += `<${step.name}${sanitizeAttributes(step.name, html.slice(step.nameEnd, gt))}>`
      }
    }
    i = gt + 1
  }
  return out
}

function sanitizeAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag]
  if (!allowed || !NON_SPACE_RE.test(raw)) return ""

  const out: string[] = []
  const seen = new Set<string>()
  let i = 0
  while (i < raw.length) {
    const start = i
    ATTR_NAME_RE.lastIndex = i
    const nameMatch = ATTR_NAME_RE.exec(raw)
    if (nameMatch === null) {
      i += 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    i = ATTR_NAME_RE.lastIndex
    i = skipSpace(raw, i)
    if (raw[i] !== "=") {
      if (i === start) i = start + 1
      continue
    }
    i = skipSpace(raw, i + 1)
    const quote = raw[i]
    let rawValue: string
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, i + 1)
      rawValue = end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end)
      i = end === -1 ? raw.length : end + 1
    } else {
      UNQUOTED_VALUE_RE.lastIndex = i
      const valueMatch = UNQUOTED_VALUE_RE.exec(raw)
      rawValue = valueMatch === null ? "" : valueMatch[0]
      i = valueMatch === null ? i + 1 : UNQUOTED_VALUE_RE.lastIndex
    }
    if (!allowed.has(name) || seen.has(name)) continue
    seen.add(name)
    const value = decodeEntities(rawValue)
    if (name === "href" && !SAFE_URL_RE.test(value.trim())) continue
    out.push(`${name}="${escapeAttr(value)}"`)
  }
  return out.length > 0 ? ` ${out.join(" ")}` : ""
}

function skipSpace(raw: string, from: number): number {
  let i = from
  while (i < raw.length && SPACE_CHARS.has(raw[i] as string)) i += 1
  return i
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
