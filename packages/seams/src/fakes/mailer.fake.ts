import type { Mailer, OutboundEmail, SentMail } from "../interfaces/mailer.js"

export interface CapturedMail {
  to: string
  code?: string
  template?: string
  vars?: Record<string, unknown>
  /** The full envelope captured by sendOutbound (so tests assert from/replyTo/attachments, etc.). */
  outbound?: OutboundEmail
}

/**
 * In-memory Mailer that captures every send for assertions. `sendOutbound` records the whole envelope
 * so a test can assert From and Reply-To are carried.
 */
export class FakeMailer implements Mailer {
  readonly sent: CapturedMail[] = []
  /** Deterministic Message-ID counter (no Date/random, so fakes stay reproducible). */
  private n = 0

  sendOtp(to: string, code: string): Promise<void> {
    this.sent.push({ to, code })
    return Promise.resolve()
  }

  sendTransactional(to: string, template: string, vars: Record<string, unknown>): Promise<void> {
    this.sent.push({ to, template, vars })
    return Promise.resolve()
  }

  sendOutbound(email: OutboundEmail): Promise<SentMail> {
    this.sent.push({ to: email.to, outbound: email })
    const messageId =
      email.messageId !== undefined && email.messageId.length > 0
        ? email.messageId
        : `<fake-outbound-${++this.n}@civfix.test>`
    return Promise.resolve({ messageId })
  }

  /** Test helper: most recent OTP code sent to an address. */
  lastOtpFor(to: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]
      if (m && m.to === to && m.code !== undefined) return m.code
    }
    return undefined
  }

  /** Test helper: the most recent outbound envelope (or undefined when none has been sent). */
  lastOutbound(): OutboundEmail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i]
      if (m && m.outbound !== undefined) return m.outbound
    }
    return undefined
  }

  reset(): void {
    this.sent.length = 0
    this.n = 0
  }
}
