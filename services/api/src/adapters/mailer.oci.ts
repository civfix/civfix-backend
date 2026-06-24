/**
 * REAL Mailer adapter backed by OCI Email Delivery over SMTP (nodemailer).
 *
 * Seam rule: nodemailer is imported ONLY in this file. The transporter is created lazily on first
 * send (so constructing the adapter, e.g. during DI wiring, never opens a socket or requires
 * credentials to be reachable). The DI container swaps in FakeMailer when USE_FAKE_MAILER is set, so
 * this class is only constructed when real SMTP delivery is configured.
 *
 * Two surfaces, both plain-text + minimal HTML, both sent From MAIL_FROM_NOREPLY:
 *   - sendOtp(to, code)                  the email sign-in passcode;
 *   - sendTransactional(to, template, vars)  a small set of named templates (report updates, etc.).
 *
 * A third surface, `sendOutbound(email)`, carries the envelope first-class (a `from` it MUST honor, a
 * `replyTo` so a recipient's reply threads back via the inbound pipeline, an explicit Message-ID for
 * In-Reply-To/References correlation, and binary attachments). It is the seam the operator outreach /
 * report-routing path uses; unlike the two above it does NOT force From the no-reply mailbox.
 */

import { randomUUID } from "node:crypto"
import { AppError, ErrorCode } from "@civfix/shared"
import type { Mailer, OutboundEmail, SentMail } from "@civfix/shared/interfaces"
import type { Transporter } from "nodemailer"
import { domainOf, escapeHtml, sanitizeHeaderValue } from "./mail-text.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { DEFAULT_LOCALE, resolveLocale } from "../i18n/locales.js"

const CRLF_RE = /[\r\n\0]/
const CRLF_GLOBAL_RE = /[\r\n\0]/g

// Envelope addresses (from/replyTo/to) with an embedded CR/LF can't be silently truncated — a malformed
// address is a programming/data error, so reject rather than send a header-injected message.
function assertCleanAddress(value: string, field: string): string {
  if (CRLF_RE.test(value)) {
    throw new AppError(ErrorCode.INTERNAL, `Outbound email ${field} contains an illegal newline.`)
  }
  return value
}

// Sanitize a passthrough header map: strip CR/LF from every key and value (SMTP header injection).
function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.replace(CRLF_GLOBAL_RE, "")] = sanitizeHeaderValue(value)
  }
  return out
}

export interface OciMailerConfig {
  host: string
  port: number
  user: string
  pass: string
  fromNoReply: string
  fromOutreach: string
}

/** A rendered message body. */
interface Rendered {
  subject: string
  text: string
  html: string
}

/** A nodemailer SMTP error carries an optional `responseCode` (the 3-digit SMTP reply) + `code`. */
interface SmtpError {
  responseCode?: number
  code?: string
  response?: string
}

/**
 * Classify a caught nodemailer send error (D17). A PERMANENT auth/authorization/sender failure (SMTP
 * 530/535/550, or nodemailer EAUTH/EENVELOPE with a 5xx response) is a CONFLICT (409) with an actionable
 * message — the operator must fix the sender config (OCI Approved Senders), retrying won't help. Any
 * TRANSIENT failure (SMTP 4xx, or a connection/timeout/TLS error) stays INTERNAL (500, retryable). The
 * SMTP response text is folded into the message when present so the real reason surfaces.
 */
function classifyMailError(err: unknown, from: string): AppError {
  const e = (err ?? {}) as SmtpError
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined
  const code = typeof e.code === "string" ? e.code : undefined
  const response = typeof e.response === "string" ? e.response : undefined

  const isPermanentResponse = responseCode !== undefined && responseCode >= 500 && responseCode < 600
  const isAuthCode = code === "EAUTH" || code === "EENVELOPE"
  if (isPermanentResponse || (isAuthCode && responseCode !== undefined && responseCode >= 500)) {
    const detail = response ? ` (${response})` : ""
    const domain = domainOf(from)
    return new AppError(
      ErrorCode.CONFLICT,
      `Email not sent: the sending address is not an approved sender. In OCI Email Delivery, ` +
        `add an Approved Sender for the whole domain (@${domain}) once DKIM is active — this covers ` +
        `every per-thread reply address.${detail}`,
      { cause: err },
    )
  }
  return new AppError(ErrorCode.INTERNAL, "Failed to send email.", { cause: err })
}

export class OciMailer implements Mailer {
  private readonly config: OciMailerConfig
  private transporter: Transporter | undefined

  constructor(config: OciMailerConfig) {
    this.config = config
  }

  async sendOtp(to: string, code: string): Promise<void> {
    const body = renderOtp(code)
    await this.send(to, body)
  }

  async sendTransactional(
    to: string,
    template: string,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const body = renderTemplate(template, vars)
    await this.send(to, body)
  }

  /** Lazily build the SMTP transporter (nodemailer). Imported here only. */
  private async getTransporter(): Promise<Transporter> {
    if (!this.transporter) {
      const nodemailer = await import("nodemailer")
      const transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        // OCI Email Delivery uses STARTTLS on 587; `secure` is true only for implicit TLS (465).
        secure: this.config.port === 465,
        // SECURITY: on the STARTTLS (587) path, REQUIRE the TLS upgrade. Without this, a STARTTLS-stripping
        // MITM on the VPS->OCI egress could downgrade the connection and read credentials + OTP codes in
        // cleartext. requireTLS makes the send FAIL rather than transmit unencrypted. (No-op for 465.)
        requireTLS: true,
        auth: { user: this.config.user, pass: this.config.pass },
      })
      this.transporter = transporter
      // WARN-ONLY smoke: verify the SMTP connection/credentials on first real use. It NEVER fails the send
      // (let alone boot — the transporter is built lazily, never at DI wiring) so the offline/fake dev path
      // is untouched; a bad host/credential just logs once before the actual send surfaces the real error.
      transporter.verify().catch((err: unknown) => {
        console.warn({ err }, "OCI mailer SMTP verify failed (continuing; send will surface the error)")
      })
    }
    return this.transporter
  }

  async sendOutbound(email: OutboundEmail): Promise<SentMail> {
    const transporter = await this.getTransporter()
    // Mint a Message-ID when the caller did not supply one, so the eventual reply/bounce can be
    // correlated by In-Reply-To/References. Domain is taken from the From address (fallback civfix.org).
    const messageId = email.messageId ?? `<${randomUUID()}@${domainOf(email.from)}>`
    try {
      await transporter.sendMail({
        from: assertCleanAddress(email.from, "from"),
        to: assertCleanAddress(email.to, "to"),
        replyTo: email.replyTo ? assertCleanAddress(email.replyTo, "replyTo") : undefined,
        subject: sanitizeHeaderValue(email.subject),
        text: email.text,
        html: email.html ?? textToHtml(email.text),
        messageId,
        inReplyTo: email.inReplyTo,
        references: email.references,
        attachments: email.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
        headers: sanitizeHeaders(email.headers),
      })
    } catch (err) {
      throw classifyMailError(err, email.from)
    }
    return { messageId }
  }

  private async send(to: string, body: Rendered): Promise<void> {
    const transporter = await this.getTransporter()
    try {
      await transporter.sendMail({
        from: this.config.fromNoReply,
        to: assertCleanAddress(to, "to"),
        subject: sanitizeHeaderValue(body.subject),
        text: body.text,
        html: body.html,
      })
    } catch (err) {
      throw classifyMailError(err, this.config.fromNoReply)
    }
  }
}

/**
 * Render the OTP (sign-in passcode) email. PRE-AUTH: there is no user row yet, so there is no stored
 * `users.locale` to honor — per the i18n spec this email defaults to English ('en'). A caller MAY pass an
 * `Accept-Language` base tag as `locale` (clamped to a supported code) as an optional best-effort.
 */
function renderOtp(code: string, locale: string = DEFAULT_LOCALE): Rendered {
  const subject = renderMessage(locale, "email.otp.subject")
  const text = [
    renderMessage(locale, "email.otp.body_line1", { code }),
    "",
    renderMessage(locale, "email.otp.body_expiry"),
  ].join("\n")
  const html = [
    `<p>${escapeHtml(renderMessage(locale, "email.otp.html_intro"))}</p>`,
    `<p style="font-size:24px;font-weight:bold;letter-spacing:3px">${escapeHtml(code)}</p>`,
    `<p>${escapeHtml(renderMessage(locale, "email.otp.body_expiry"))}</p>`,
  ].join("")
  return { subject, text, html }
}

/**
 * Render a named transactional template, localized to the recipient's locale. The caller passes the
 * recipient's `users.locale` as `vars.locale` (the adapter itself is locale-agnostic — it has no user
 * row); absent/unsupported => English. Unknown templates fall back to a generic notification so a missing
 * template never throws at send time. EXCLUDES jurisdiction report-packet emails (sent via sendOutbound /
 * mail-format.ts), which stay English for officials.
 */
function renderTemplate(template: string, vars: Record<string, unknown>): Rendered {
  const locale = resolveLocale(typeof vars.locale === "string" ? vars.locale : undefined)
  switch (template) {
    case "report_update": {
      const status = stringVar(vars, "status", "updated")
      const subject = renderMessage(locale, "email.report_update.subject", { status })
      const text = renderMessage(locale, "email.report_update.body", { status })
      const html = `<p>${escapeHtml(text)}</p>`
      return { subject, text, html }
    }
    default: {
      const subject = stringVar(vars, "subject", renderMessage(locale, "email.generic.subject"))
      const message = stringVar(vars, "message", renderMessage(locale, "email.generic.body"))
      return { subject, text: message, html: `<p>${escapeHtml(message)}</p>` }
    }
  }
}

/** Read a string variable from a template var bag, with a fallback. */
function stringVar(vars: Record<string, unknown>, key: string, fallback: string): string {
  const v = vars[key]
  return typeof v === "string" && v.length > 0 ? v : fallback
}

// Wrap an escaped plain-text body in a single <p>, with each line break rendered as <br> (so a
// multi-line text body keeps its line structure in the HTML fallback rather than collapsing to one line).
function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
}
