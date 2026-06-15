/**
 * REAL InboundMail adapter for the Cloudflare Email Routing pipeline.
 *
 * The Cloudflare Email Worker writes the raw .eml to R2; the backend fetches it and calls parse() here.
 * parse() decodes the RFC822 bytes (via mailparser) into the vendor-neutral ParsedMail, including
 * attachments. extractThreadToken() recovers a reply+{token}@ thread token (or an X-Thread-Token
 * header) so the inbound processor can route a reply into its mail_threads thread; catch-all mail with
 * no token goes to the inbound_emails inbox instead.
 *
 * Seam rule: the MIME-parsing SDK (mailparser) is imported ONLY in this file, lazily, so constructing
 * the adapter during DI never loads it.
 */

import type {
  InboundMail,
  ParsedMail,
  ParsedMailAddress,
  ParsedMailAttachment,
} from "@civfix/shared/interfaces"
import type { AddressObject, Attachment, EmailAddress } from "mailparser"

/** Shape of a thread token as minted by mintThreadToken() (24 lowercase hex chars). */
const THREAD_TOKEN_RE = /^[0-9a-f]{24}$/

export interface CfInboundMailConfig {
  /** Shared secret used to authenticate the Cloudflare webhook (CF_EMAIL_WEBHOOK_SECRET). */
  webhookSecret?: string
}

export class CfInboundMail implements InboundMail {
  private readonly config: CfInboundMailConfig

  constructor(config: CfInboundMailConfig = {}) {
    this.config = config
  }

  async parse(raw: Uint8Array): Promise<ParsedMail> {
    const { simpleParser } = await import("mailparser")
    // SECURITY (DoS): bound the HTML-DOM parsing work on untrusted mail. maxHtmlLengthToParse caps the
    // HTML body the parser will walk; skipImageLinks avoids extra cid-rewriting. The caller also enforces
    // a hard raw-byte cap (INBOUND_OBJECT_MAX_BYTES) before this runs.
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
    // Prefer the explicit header, else parse a reply+{token}@... recipient. NOTE: unlike
    // FakeInboundMail.extractThreadToken, the real adapter additionally SHAPE-VALIDATES the candidate
    // (THREAD_TOKEN_RE) so a forged/junk inbound value cannot create stray threads (security hardening).
    // SECURITY: a thread token is a 24-hex-char value minted by mintThreadToken(). Validate the SHAPE of
    // any candidate (from the spoofable X-Thread-Token header OR a sender-chosen reply+{x}@ address) before
    // returning it, so a junk/forged value cannot create stray threads or probe the thread namespace. The
    // real protection is the token's entropy; this just rejects obviously-malformed candidates early.
    const headerToken = mail.headers["x-thread-token"]
    if (headerToken && THREAD_TOKEN_RE.test(headerToken)) return headerToken
    for (const addr of mail.to) {
      const match = addr.address.match(/reply\+([^@]+)@/)
      if (match && match[1] && THREAD_TOKEN_RE.test(match[1])) return match[1]
    }
    return null
  }
}

/** Map a mailparser EmailAddress to the vendor-neutral ParsedMailAddress (name omitted when absent). */
function toAddress(value: EmailAddress): ParsedMailAddress {
  const name = value.name && value.name.length > 0 ? value.name : undefined
  return name !== undefined
    ? { name, address: value.address ?? "" }
    : { address: value.address ?? "" }
}

/** Flatten mailparser's `to` (an AddressObject, an array of them, or undefined) into addresses. */
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

/** Map a mailparser Attachment to ParsedMailAttachment (bytes copied into a plain Uint8Array). */
function toAttachment(att: Attachment): ParsedMailAttachment {
  const out: ParsedMailAttachment = {
    content: new Uint8Array(att.content),
    size: att.size,
  }
  if (att.filename && att.filename.length > 0) out.filename = att.filename
  if (att.contentType) out.contentType = att.contentType
  return out
}

/**
 * Reduce mailparser's headers Map to a Record<string,string> with lowercase keys (matching the fake).
 * Structured header values (addresses, dates, parameter objects) are stringified best-effort.
 */
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
    const v = value as { text?: unknown; value?: unknown }
    if (typeof v.text === "string") return v.text
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
