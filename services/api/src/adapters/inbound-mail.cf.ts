
import type {
  InboundMail,
  ParsedMail,
  ParsedMailAddress,
  ParsedMailAttachment,
} from "@civfix/shared/interfaces"
import type { AddressObject, Attachment, EmailAddress, HeaderLines } from "mailparser"
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

    const fromValue = singleFromMailbox(parsed.headerLines, parsed.from)
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

export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net"

const AUTHENTICATION_RESULTS_HEADER = "authentication-results"

const DMARC_NO_POLICY_RESULTS: ReadonlySet<string> = new Set(["none", "temperror", "permerror"])

const METHOD_SPEC_RE = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z0-9_-]+)/

const PROP_SPEC_RE = /^([a-z0-9_-]+\.[a-z0-9_.-]+)=(\S+)$/

const QUOTED_REMOTE_IP_RE = /smtp\.remote-ip\s*=\s*"[0-9a-f:.]+"/gi

const FLAT_COMMENT_RE = /\([^()]*\)/g

interface AuthResult {
  method: string
  result: string
  props: ReadonlyMap<string, string>
}

export function readMailAuthVerdict(mail: ParsedMail): MailAuthVerdict {
  const stamp = mail.headers[AUTHENTICATION_RESULTS_HEADER] ?? ""
  if (stamp.trim().split(/[\s;]/, 1)[0]?.toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) return "unknown"
  const results = parseStamp(stamp)
  if (results === null) return "fail"
  if (results.length === 0) return "unknown"
  const fromDomain = domainOfOrNull(mail.from?.address ?? null)
  if (fromDomain === null) return "fail"

  const dmarcResults = results.filter((r) => r.method === "dmarc")
  if (dmarcResults.length > 1) return "fail"
  const [dmarc] = dmarcResults
  if (dmarc !== undefined) {
    if (results.slice(0, results.indexOf(dmarc)).some(carriesEnvelopeValue)) return "fail"
    const headerFrom = dmarc.props.get("header.from")
    if (headerFrom !== undefined && headerFrom !== fromDomain) return "fail"
    if (dmarc.result === "pass" && headerFrom !== undefined) return "pass"
    if (dmarc.result !== "pass" && !DMARC_NO_POLICY_RESULTS.has(dmarc.result)) return "fail"
  }

  const alignedDkim = leadingDkimResults(results).some((r) =>
    isAlignedPass(r, r.props.get("header.d") ?? r.props.get("header.i"), fromDomain),
  )
  return alignedDkim ? "pass" : "fail"
}

function parseStamp(stamp: string): AuthResult[] | null {
  const unquoted = stamp.replace(QUOTED_REMOTE_IP_RE, "")
  if (/["\\]/.test(unquoted)) return null
  const uncommented = unquoted.replace(FLAT_COMMENT_RE, " ")
  if (/[()]/.test(uncommented)) return null
  const results: AuthResult[] = []
  for (const resinfo of uncommented.split(";").slice(1)) {
    const tokens = resinfo.replace(/\s*=\s*/g, "=").trim().toLowerCase().split(/\s+/)
    const [methodSpec, ...propSpecs] = tokens
    const [, method, result] = METHOD_SPEC_RE.exec(methodSpec ?? "") ?? []
    if (method === undefined || result === undefined) continue
    const props = new Map<string, string>()
    for (const spec of propSpecs) {
      const [, name, value] = PROP_SPEC_RE.exec(spec) ?? []
      if (name === undefined || value === undefined) continue
      if (props.has(name)) return null
      props.set(name, value)
    }
    results.push({ method, result, props })
  }
  return results
}

function carriesEnvelopeValue(result: AuthResult): boolean {
  return result.props.has("smtp.helo") || result.props.has("smtp.mailfrom")
}

function leadingDkimResults(results: readonly AuthResult[]): readonly AuthResult[] {
  const end = results.findIndex((r) => r.method !== "dkim")
  return end === -1 ? results : results.slice(0, end)
}

function isAlignedPass(result: AuthResult, identity: string | undefined, from: string): boolean {
  if (result.result !== "pass" || identity === undefined) return false
  const domain = identityDomain(identity)
  return domain !== null && domainsAligned(domain, from)
}

function identityDomain(identity: string): string | null {
  if (identity.includes("@")) return domainOfOrNull(identity)
  return identity.length > 0 ? identity : null
}

export const domainOf = domainOfOrNull

export function domainsAligned(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function singleFromMailbox(
  headerLines: HeaderLines,
  from: AddressObject | undefined,
): EmailAddress | null {
  if (headerLines.filter((line) => line.key === "from").length !== 1) return null
  const mailboxes = (from?.value ?? []).flatMap((entry) => entry.group ?? [entry])
  return mailboxes.length === 1 ? (mailboxes[0] ?? null) : null
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
    const name = key.toLowerCase()
    const isAuthResults = name === AUTHENTICATION_RESULTS_HEADER
    out[name] = stringifyHeader(isAuthResults && Array.isArray(value) ? value[0] : value)
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
