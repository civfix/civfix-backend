
import type {
  InboundMail,
  ParsedMail,
  ParsedMailAddress,
  ParsedMailAttachment,
} from "@civfix/shared/interfaces"
import type { AddressObject, Attachment, EmailAddress } from "mailparser"
import { domainOfOrNull } from "./mail-text.js"

const THREAD_TOKEN_RE = /^[a-z0-9]{8,40}$/

export interface CfInboundMailConfig {
  webhookSecret?: string
  replyDomain?: string
}

const DEFAULT_REPLY_DOMAIN = "civfix.org"

const REPLY_ADDRESS_RE = /^(?:reply|report|event)[-+]([^@\s]+)@([^@\s]+)$/

const MAX_MIME_PARTS = 200
const MAX_DISTINCT_BOUNDARIES = 32
const BOUNDARY_DECL_RE = /boundary\s*=\s*(?:"([^"\r\n]{1,200})"|([^;"\s\r\n]{1,200}))/gi

function countMimeParts(raw: Uint8Array): number {
  const text = Buffer.from(raw).toString("latin1")
  const boundaries = new Set<string>()
  BOUNDARY_DECL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BOUNDARY_DECL_RE.exec(text)) !== null) {
    const b = (m[1] ?? m[2] ?? "").trim()
    if (b.length === 0) continue
    boundaries.add(b)
    if (boundaries.size > MAX_DISTINCT_BOUNDARIES) return Number.POSITIVE_INFINITY
  }
  let count = 0
  for (const b of boundaries) {
    const delim = `--${b}`
    let idx = text.indexOf(delim)
    while (idx !== -1) {
      count++
      if (count > MAX_MIME_PARTS) return count
      idx = text.indexOf(delim, idx + delim.length)
    }
  }
  return count
}

export class CfInboundMail implements InboundMail {
  private readonly config: CfInboundMailConfig

  constructor(config: CfInboundMailConfig = {}) {
    this.config = config
  }

  async parse(raw: Uint8Array): Promise<ParsedMail> {
    if (countMimeParts(raw) > MAX_MIME_PARTS) {
      throw new Error("inbound mail: too many MIME parts")
    }
    const { simpleParser } = await import("mailparser")
    const parsed = await simpleParser(Buffer.from(raw), {
      maxHtmlLengthToParse: 2 * 1024 * 1024,
      skipImageLinks: true,
    })

    const fromValue = parsed.from?.value?.[0]
    return {
      from: fromValue ? toAddress(fromValue) : null,
      to: toAddresses(parsed.to),
      subject: parsed.subject ?? null,
      text: parsed.text ?? null,
      html: typeof parsed.html === "string" ? parsed.html : null,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      headers: flattenHeaders(parsed.headers),
      attachments: (parsed.attachments ?? []).map(toAttachment),
    }
  }

  extractThreadToken(mail: ParsedMail): string | null {
    const replyDomain = (this.config.replyDomain ?? DEFAULT_REPLY_DOMAIN).toLowerCase()
    for (const addr of mail.to) {
      const match = addr.address.match(REPLY_ADDRESS_RE)
      if (match && match[1] && match[2] && match[2].toLowerCase() === replyDomain) {
        if (THREAD_TOKEN_RE.test(match[1])) return match[1]
      }
    }
    return null
  }
}

export type MailAuthVerdict = "pass" | "fail" | "unknown"

const AUTH_RESULT_RE = /\b(dmarc|dkim|spf)\s*=\s*([a-z]+)/gi

const DKIM_DOMAIN_RE = /header\.(?:d|i)\s*=\s*@?([a-z0-9.-]+)/i

export function readMailAuthVerdict(mail: ParsedMail): MailAuthVerdict {
  const raw = mail.headers["authentication-results"]
  if (!raw || raw.trim().length === 0) return "unknown"

  const results = new Map<string, string>()
  let firstDkimDomain: string | undefined
  for (const clause of raw.split(";")) {
    for (const m of clause.matchAll(AUTH_RESULT_RE)) {
      const method = (m[1] ?? "").toLowerCase()
      const result = (m[2] ?? "").toLowerCase()
      if (results.has(method)) continue
      results.set(method, result)
      if (method === "dkim") firstDkimDomain = DKIM_DOMAIN_RE.exec(clause)?.[1]?.toLowerCase()
    }
  }

  const dmarc = results.get("dmarc")
  if (dmarc === "pass") return "pass"
  if (dmarc !== undefined) return "fail"

  if (results.get("dkim") === "pass") {
    const fromDomain = domainOfOrNull(mail.from?.address ?? null)
    if (firstDkimDomain && fromDomain && domainsAligned(firstDkimDomain, fromDomain)) return "pass"
  }

  return results.size > 0 ? "fail" : "unknown"
}

export const domainOf = domainOfOrNull

export function domainsAligned(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function toAddress(value: EmailAddress): ParsedMailAddress {
  const name = value.name && value.name.length > 0 ? value.name : undefined
  return name !== undefined
    ? { name, address: value.address ?? "" }
    : { address: value.address ?? "" }
}

function toAddresses(to: AddressObject | AddressObject[] | undefined): ParsedMailAddress[] {
  if (!to) return []
  const groups = Array.isArray(to) ? to : [to]
  const out: ParsedMailAddress[] = []
  for (const group of groups) {
    for (const value of group.value ?? []) {
      if (value.address) out.push(toAddress(value))
    }
  }
  return out
}

function toAttachment(att: Attachment): ParsedMailAttachment {
  const out: ParsedMailAttachment = {
    content: new Uint8Array(att.content),
    size: att.size,
  }
  if (att.filename && att.filename.length > 0) out.filename = att.filename
  if (att.contentType) out.contentType = att.contentType
  return out
}

function flattenHeaders(headers: Map<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of headers) {
    out[key.toLowerCase()] = stringifyHeader(value)
  }
  return out
}

function stringifyHeader(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") {
    const v = value as { text?: unknown; value?: unknown; params?: unknown }
    if (typeof v.value === "string" && v.params !== null && typeof v.params === "object") {
      return renderStructuredHeaderValue(v.value, v.params as Record<string, unknown>)
    }
    if (typeof v.text === "string") return v.text
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function renderStructuredHeaderValue(value: string, params: Record<string, unknown>): string {
  let out = value
  for (const [key, param] of Object.entries(params)) {
    if (typeof param === "string") out += `; ${key}=${param}`
  }
  return out
}
