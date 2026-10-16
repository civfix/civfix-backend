/**
 * Outbound transactional email behind a vendor-neutral interface.
 */

/** A binary attachment on an outbound email (the bytes are owned by the caller). */
export interface OutboundAttachment {
  filename: string
  contentType: string
  content: Uint8Array
}

/**
 * A fully-specified outbound email. Unlike `sendTransactional` (an OTP/notification template sender
 * that always goes From the no-reply mailbox), this carries the envelope first-class: a `from` the
 * adapter MUST honor (e.g. `outreach@civfix.org`), a `replyTo` so a recipient's reply threads back via
 * the inbound pipeline, an explicit `messageId` (for In-Reply-To/References correlation), and binary
 * attachments. This is the seam the operator outreach / report-routing path uses.
 */
export interface OutboundEmail {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html?: string
  /** RFC822 Message-ID to set (angle-bracket form). The adapter mints one when omitted. */
  messageId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: OutboundAttachment[]
  headers?: Record<string, string>
}

/** The result of an outbound send: the RFC822 Message-ID actually used (for reply/bounce correlation). */
export interface SentMail {
  messageId: string
}

export interface Mailer {
  sendOtp(to: string, code: string): Promise<void>
  sendTransactional(to: string, template: string, vars: Record<string, unknown>): Promise<void>
  /**
   * Deliver a fully-specified outbound email (honoring `from`/`replyTo`/`messageId`/attachments) and
   * return the Message-ID used. The reply-threading + report-routing path depends on this; a real
   * adapter MUST set the From and Reply-To it is given (the seam exists precisely so they are not
   * dropped). Returns the Message-ID so the caller can correlate an eventual reply or bounce.
   */
  sendOutbound(email: OutboundEmail): Promise<SentMail>
}
