import type { InboundMail, ParsedMail } from "../interfaces/inbound-mail.js"

const decoder = new TextDecoder()

/**
 * Thread-token shape, mirroring the real CfInboundMail adapter. Deliberately PERMISSIVE so it accepts
 * both the 12-char base32 and the older 24-hex tokens: the token's entropy + the unique DB lookup are
 * the real protection, and this gate only rejects obviously malformed candidates. The fake MUST validate
 * the same way production does, or a token the real adapter rejects would still "work" in tests.
 */
const THREAD_TOKEN_RE = /^[a-z0-9]{8,40}$/

const DEFAULT_REPLY_DOMAIN = "civfix.org"

/**
 * Anchored reply-address matcher (mirrors the real CfInboundMail adapter): a typed prefix
 * (`reply`/`report`/`event`), a `-` or older `+` separator, the token, then `@domain`. Anchoring + the
 * domain check stop a mid-string or foreign-domain false positive.
 */
const REPLY_ADDRESS_RE = /^(?:reply|report|event)[-+]([^@\s]+)@([^@\s]+)$/

const REPLY_ADDRESS_SCAN_RE = /(?<![^\s<,;:"])(?:reply|report|event)[-+][^@\s<>,;"]+@[^@\s<>,;"]+/gi

/**
 * In-memory InboundMail. Parses a tiny subset of RFC822: leading "Header: value" lines until a
 * blank line, then the remainder is the text body. Deterministic and dependency-free.
 */
export class FakeInboundMail implements InboundMail {
  /** Reply domain a thread token must live on (mirrors MAIL_REPLY_DOMAIN); defaults to civfix.org. */
  private readonly replyDomain: string

  constructor(replyDomain: string = DEFAULT_REPLY_DOMAIN) {
    this.replyDomain = replyDomain.toLowerCase()
  }

  parse(raw: Uint8Array): Promise<ParsedMail> {
    const text = decoder.decode(raw)
    const normalized = text.replace(/\r\n/g, "\n")
    const splitIdx = normalized.indexOf("\n\n")
    const headerBlock = splitIdx >= 0 ? normalized.slice(0, splitIdx) : normalized
    const body = splitIdx >= 0 ? normalized.slice(splitIdx + 2) : ""

    const headers: Record<string, string> = {}
    for (const line of headerBlock.split("\n")) {
      const idx = line.indexOf(":")
      if (idx > 0) {
        const key = line.slice(0, idx).trim().toLowerCase()
        headers[key] = line.slice(idx + 1).trim()
      }
    }

    const parseAddr = (v: string | undefined) => {
      if (!v) return null
      const m = v.match(/^(.*)<([^>]+)>$/)
      if (m && m[2]) {
        const name = (m[1] ?? "").trim()
        return name ? { name, address: m[2].trim() } : { address: m[2].trim() }
      }
      return { address: v.trim() }
    }

    const to = headers["to"]
    const toAddr = parseAddr(to)

    return Promise.resolve({
      from: parseAddr(headers["from"]),
      to: toAddr ? [toAddr] : [],
      subject: headers["subject"] ?? null,
      text: body.length > 0 ? body : null,
      html: null,
      messageId: headers["message-id"] ?? null,
      inReplyTo: headers["in-reply-to"] ?? null,
      headers,
    })
  }

  /**
   * Mirrors the real CfInboundMail adapter: a typed reply address on OUR reply domain, read from To and
   * then scanned out of the raw Cc header, lowercased before matching. An X-Thread-Token header is ignored
   * because any sender can set it, which would let a stranger pick the thread. Anchoring, the domain check
   * and the token shape keep a city's own `report-*@city.gov` alias or a junk value from creating threads.
   */
  extractThreadToken(mail: ParsedMail): string | null {
    const ccAddresses = (mail.headers["cc"] ?? "").match(REPLY_ADDRESS_SCAN_RE) ?? []
    for (const address of [...mail.to.map((addr) => addr.address), ...ccAddresses]) {
      const match = address.toLowerCase().match(REPLY_ADDRESS_RE)
      if (match?.[1] && match[2] === this.replyDomain && THREAD_TOKEN_RE.test(match[1])) return match[1]
    }
    return null
  }
}
