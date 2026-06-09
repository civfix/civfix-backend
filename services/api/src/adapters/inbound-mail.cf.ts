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
    const parsed = await simpleParser(Buffer.from(raw))

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
    // Mirror of FakeInboundMail.extractThreadToken: prefer the explicit header, else parse a
    // reply+{token}@... recipient. Keeps production + tests in agreement.
    const headerToken = mail.headers["x-thread-token"]
    if (headerToken && headerToken.length > 0) return headerToken
    for (const addr of mail.to) {
      const match = addr.address.match(/reply\+([^@]+)@/)
      if (match && match[1]) return match[1]
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
