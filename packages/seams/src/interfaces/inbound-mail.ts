/**
 * Inbound email parsing for the reply-by-email flow.
 */

export interface ParsedMailAddress {
  name?: string
  address: string
}

/**
 * A single decoded attachment. Optional fields mirror what a real MIME parser surfaces; `content` is
 * the raw bytes (absent for an attachment too large to buffer). The inbound-mail webhook streams these
 * into R2.
 */
export interface ParsedMailAttachment {
  filename?: string
  content?: Uint8Array
  size?: number
  contentType?: string
}

export interface ParsedMail {
  from: ParsedMailAddress | null
  to: ParsedMailAddress[]
  subject: string | null
  text: string | null
  html: string | null
  messageId: string | null
  inReplyTo: string | null
  headers: Record<string, string>
  /** Decoded attachments, when the parser surfaces them. Optional so the minimal fake stays valid. */
  attachments?: ParsedMailAttachment[]
}

export interface InboundMail {
  parse(raw: Uint8Array): Promise<ParsedMail>
  extractThreadToken(mail: ParsedMail): string | null
}
