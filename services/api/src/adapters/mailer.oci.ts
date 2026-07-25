
import { randomUUID } from "node:crypto"
import { AppError, ErrorCode } from "@civfix/shared"
import type { Mailer, OutboundEmail, SentMail } from "@civfix/shared/interfaces"
import type { Transporter } from "nodemailer"
import { domainOf, escapeHtml, sanitizeHeaderValue } from "./mail-text.js"
import { code, paragraph } from "./email-blocks.js"
import { renderEmailBody } from "./email-layout.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { resolveLocale, type Locale } from "../i18n/locales.js"

const CRLF_RE = /[\r\n\0]/
const CRLF_GLOBAL_RE = /[\r\n\0]/g

function assertCleanAddress(value: string, field: string): string {
  if (CRLF_RE.test(value)) {
    throw new AppError(ErrorCode.INTERNAL, `Outbound email ${field} contains an illegal newline.`)
  }
  return value
}

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

interface Rendered {
  subject: string
  text: string
  html: string
}

interface SmtpError {
  responseCode?: number
  code?: string
  response?: string
}

function classifyMailError(err: unknown, from: string): AppError {
  const e = (err ?? {}) as SmtpError
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined
  const code = typeof e.code === "string" ? e.code : undefined
  const response = typeof e.response === "string" ? e.response : undefined
  const detail = response ? ` (${response})` : ""

  // EAUTH is the SMTP CREDENTIALS being wrong (a 535), not the sender being unapproved. It carries a 5xx
  // responseCode, so it used to fall into the approved-sender branch below and told the operator to fix
  // OCI's Approved Senders while the actual fault was the SMTP user/password. Classified first, and as
  // INTERNAL: it is a deployment misconfiguration (and 5xx routes it to the error tracker), not a conflict
  // the caller can resolve.
  if (code === "EAUTH") {
    return new AppError(
      ErrorCode.INTERNAL,
      `Email not sent: the SMTP server rejected our credentials. Check ` +
        `OCI_EMAIL_SMTP_USER / OCI_EMAIL_SMTP_PASS.${detail}`,
      { cause: err },
    )
  }

  // Any permanent 5xx SMTP response. (The old `EAUTH || EENVELOPE` disjunct alongside this was dead: it
  // additionally required responseCode >= 500, which this already covers for every code SMTP can emit.)
  if (responseCode !== undefined && responseCode >= 500 && responseCode < 600) {
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

  /**
   * `locale` is an OPTIONAL extra parameter, and it IS supplied in production: auth/otp.ts widens this one
   * seam structurally (its LocaleAwareMailer type) and passes the account's `users.locale`, so the
   * email.otp.* catalogs are live and a user whose locale is es/de/ko gets their passcode in that language.
   * The parameter stays optional only because the shared `Mailer.sendOtp(to, code)` contract has no locale
   * slot to declare it in — a 2-parameter sendOtp is still assignable, so every other Mailer (FakeMailer,
   * test doubles) satisfies the widened type and simply keeps rendering `en`. An unknown/absent value is
   * clamped by resolveLocale, so nothing here depends on the caller validating it.
   */
  async sendOtp(to: string, code: string, locale?: string): Promise<void> {
    const body = renderOtp(code, resolveLocale(locale))
    await this.send(to, body)
  }

  /**
   * Interface-mandated, but NOTHING in production calls it yet: the report-status notification ships as a
   * push/bell, and the jurisdiction packet path uses sendOutbound (which carries attachments + an explicit
   * Message-ID that this template path drops). It is kept — with `report_update` + its four translated
   * catalogs — because that is exactly the copy a report-status email needs, and covered by unit tests so
   * the render path cannot rot unnoticed while it waits for its caller.
   */
  async sendTransactional(
    to: string,
    template: string,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const body = renderTemplate(template, vars)
    await this.send(to, body)
  }

  private async getTransporter(): Promise<Transporter> {
    if (!this.transporter) {
      const nodemailer = await import("nodemailer")
      const transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.port === 465,
        requireTLS: true,
        auth: { user: this.config.user, pass: this.config.pass },
      })
      this.transporter = transporter
      transporter.verify().catch((err: unknown) => {
        console.warn({ err }, "OCI mailer SMTP verify failed (continuing; send will surface the error)")
      })
    }
    return this.transporter
  }

  async sendOutbound(email: OutboundEmail): Promise<SentMail> {
    const transporter = await this.getTransporter()
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
        // In-Reply-To/References are stored Message-IDs recovered from INBOUND mail, i.e.
        // attacker-influenced bytes; they get the same header sanitization as every other field rather
        // than being handed to nodemailer raw.
        inReplyTo: email.inReplyTo ? sanitizeHeaderValue(email.inReplyTo) : undefined,
        references: email.references?.map((r) => sanitizeHeaderValue(r)),
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

/** `locale` is always resolved by the caller (sendOtp), so there is no default to drift from. */
function renderOtp(passcode: string, locale: Locale): Rendered {
  const subject = renderMessage(locale, "email.otp.subject")
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks: [
      paragraph(renderMessage(locale, "email.otp.html_intro")),
      code(passcode),
      paragraph(renderMessage(locale, "email.otp.body_expiry"), { muted: true }),
    ],
  })
  return { subject, text, html }
}

function renderTemplate(template: string, vars: Record<string, unknown>): Rendered {
  const locale = resolveLocale(typeof vars.locale === "string" ? vars.locale : undefined)
  switch (template) {
    case "report_update": {
      const status = stringVar(vars, "status", "updated")
      const subject = renderMessage(locale, "email.report_update.subject", { status })
      const message = renderMessage(locale, "email.report_update.body", { status })
      const { text, html } = renderEmailBody({ preheader: subject, blocks: [paragraph(message)] })
      return { subject, text, html }
    }
    default: {
      const subject = stringVar(vars, "subject", renderMessage(locale, "email.generic.subject"))
      const message = stringVar(vars, "message", renderMessage(locale, "email.generic.body"))
      const { text, html } = renderEmailBody({ preheader: subject, blocks: [paragraph(message)] })
      return { subject, text, html }
    }
  }
}

function stringVar(vars: Record<string, unknown>, key: string, fallback: string): string {
  const v = vars[key]
  return typeof v === "string" && v.length > 0 ? v : fallback
}

function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
}
