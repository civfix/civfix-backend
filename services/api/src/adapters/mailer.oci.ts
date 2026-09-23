import { randomUUID } from "node:crypto"
import { AppError, ErrorCode, MailSendError } from "@civfix/shared"
import type { Mailer, OutboundEmail, SentMail } from "@civfix/shared/interfaces"
import type { Transporter } from "nodemailer"
import { domainOf, escapeHtml, sanitizeHeaderValue } from "./mail-text.js"
import { mailFailure, SMTP_AUTH_FAILURE_CODE } from "./mail-failure.js"
import {
  button,
  code,
  heading,
  kvTable,
  paragraph,
  quote,
  type EmailBlock,
} from "./email-blocks.js"
import { renderEmailBody } from "./email-layout.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { resolveLocale, type Locale } from "../i18n/locales.js"
import { OTP_TTL_SECONDS } from "../auth/otp.js"
import { SECONDS_PER_MINUTE } from "../lib/time.js"
import { OCI_MAILER_DEFAULT_TIMEOUT_MS } from "./mailer-defaults.js"

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
  timeoutMs?: number
  logger?: OciMailerLogger
}

export interface OciMailerLogger {
  warn(obj: unknown, msg?: string): void
}

// Only for callers that construct the mailer without a logger; the API container always injects its
// pino logger, whose serializers redact the SMTP response an error carries.
const consoleLogger: OciMailerLogger = {
  warn: (obj, msg) => console.warn(msg ?? "", obj),
}

const SMTPS_IMPLICIT_TLS_PORT = 465

const DEFAULT_EVENT_TITLE = "the event"

const GUEST_OTP_DEFAULT_MINUTES = "5"

const DEFAULT_CTA_LABEL = "Open"

interface Rendered {
  subject: string
  text: string
  html: string
}

function classifyMailError(err: unknown, from: string): MailSendError {
  const failure = mailFailure(err)
  const detail = failure.response !== undefined ? ` (${failure.response})` : ""
  const smtp = {
    ...(failure.responseCode !== undefined ? { responseCode: failure.responseCode } : {}),
    ...(failure.command !== undefined ? { command: failure.command } : {}),
    ...(failure.response !== undefined ? { response: failure.response } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
  }

  switch (failure.kind) {
    case "auth":
      return failure.code === SMTP_AUTH_FAILURE_CODE
        ? new MailSendError(
            ErrorCode.INTERNAL,
            `Email not sent: the SMTP server rejected our credentials. Check ` +
              `OCI_EMAIL_SMTP_USER / OCI_EMAIL_SMTP_PASS.${detail}`,
            smtp,
            { cause: err },
          )
        : new MailSendError(
            ErrorCode.CONFLICT,
            `Email not sent: the sending address is not an approved sender. In OCI Email Delivery, ` +
              `add an Approved Sender for the whole domain (@${domainOf(from)}) once DKIM is active. That covers ` +
              `every per-thread reply address.${detail}`,
            smtp,
            { cause: err },
          )
    case "oversize":
      return new MailSendError(
        ErrorCode.CONFLICT,
        `Email not sent: the message (with its attachments) is too large for the mail provider. ` +
          `Send fewer or smaller photos. The rest remain available as links.${detail}`,
        smtp,
        { cause: err },
      )
    case "permanent":
      return new MailSendError(
        ErrorCode.CONFLICT,
        `Email not sent: the recipient address was permanently rejected by its mail server.` +
          (failure.responseCode !== undefined ? ` (SMTP ${failure.responseCode})` : ""),
        smtp,
        { cause: err },
      )
    default:
      return new MailSendError(ErrorCode.INTERNAL, "Failed to send email.", smtp, { cause: err })
  }
}

export class OciMailer implements Mailer {
  private readonly config: OciMailerConfig
  private transporter: Transporter | undefined

  constructor(config: OciMailerConfig) {
    this.config = config
  }

  async sendOtp(to: string, code: string, locale?: string): Promise<void> {
    const body = renderOtp(code, resolveLocale(locale))
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

  private async getTransporter(): Promise<Transporter> {
    if (!this.transporter) {
      const nodemailer = await import("nodemailer")
      const timeout = this.config.timeoutMs ?? OCI_MAILER_DEFAULT_TIMEOUT_MS
      const transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.port === SMTPS_IMPLICIT_TLS_PORT,
        requireTLS: true,
        auth: { user: this.config.user, pass: this.config.pass },
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
      })
      this.transporter = transporter
      const logger = this.config.logger ?? consoleLogger
      transporter.verify().catch((err: unknown) => {
        logger.warn(
          { err },
          "OCI mailer SMTP verify failed (continuing; send will surface the error)",
        )
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

export function renderOtp(passcode: string, locale: Locale): Rendered {
  const subject = renderMessage(locale, "email.otp.subject")
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks: [
      paragraph(renderMessage(locale, "email.otp.html_intro")),
      code(passcode),
      paragraph(
        renderMessage(locale, "email.otp.body_expiry", {
          minutes: String(Math.floor(OTP_TTL_SECONDS / SECONDS_PER_MINUTE)),
        }),
        { muted: true },
      ),
    ],
  })
  return { subject, text, html }
}

export type TemplateVars = Record<string, unknown>

interface TemplateContent {
  subject: string
  blocks: EmailBlock[]
}

type TemplateRenderer = (vars: TemplateVars, locale: Locale) => TemplateContent

const TEMPLATES: ReadonlyMap<string, TemplateRenderer> = new Map([
  ["report_update", renderReportUpdate],
  ["guest_otp", renderGuestOtp],
  ["guest_confirmed", renderGuestConfirmed],
  ["guest_promoted", renderGuestPromoted],
  ["action", renderAction],
])

export function renderTemplate(template: string, vars: TemplateVars): Rendered {
  const locale = resolveLocale(typeof vars.locale === "string" ? vars.locale : undefined)
  const render = TEMPLATES.get(template) ?? renderGeneric
  const { subject, blocks } = render(vars, locale)
  const { text, html } = renderEmailBody({ preheader: subject, blocks })
  return { subject, text, html }
}

function renderReportUpdate(vars: TemplateVars, locale: Locale): TemplateContent {
  const status = stringVar(vars, "status", "updated")
  const subject = renderMessage(locale, "email.report_update.subject", { status })
  const message = renderMessage(locale, "email.report_update.body", { status })
  return { subject, blocks: [paragraph(message)] }
}

function renderGuestOtp(vars: TemplateVars, locale: Locale): TemplateContent {
  const title = stringVar(vars, "title", DEFAULT_EVENT_TITLE)
  const passcode = stringVar(vars, "code", "")
  const minutes = stringVar(vars, "minutes", GUEST_OTP_DEFAULT_MINUTES)
  return {
    subject: renderMessage(locale, "email.guest_otp.subject", { title }),
    blocks: [
      paragraph(renderMessage(locale, "email.guest_otp.html_intro", { title })),
      code(passcode),
      paragraph(renderMessage(locale, "email.guest_otp.body_expiry", { minutes }), {
        muted: true,
      }),
    ],
  }
}

function renderGuestConfirmed(vars: TemplateVars, locale: Locale): TemplateContent {
  const title = stringVar(vars, "title", DEFAULT_EVENT_TITLE)
  const when = optionalVar(vars, "when")
  const place = optionalVar(vars, "place")
  const cancelUrl = optionalVar(vars, "cancelUrl")
  const subject = renderMessage(locale, "email.guest_confirmed.subject", { title })
  const details: Array<[string, string]> = []
  if (when !== undefined) details.push([renderMessage(locale, "email.event.when"), when])
  if (place !== undefined) details.push([renderMessage(locale, "email.event.where"), place])
  const blocks: EmailBlock[] = [heading(title)]
  if (details.length > 0) blocks.push(kvTable(details))
  blocks.push(paragraph(renderMessage(locale, "email.guest_confirmed.checkin")))
  if (cancelUrl !== undefined) {
    blocks.push(
      paragraph(renderMessage(locale, "email.guest_confirmed.cancel_hint"), { muted: true }),
      button(cancelUrl, renderMessage(locale, "email.guest_confirmed.cancel_cta")),
    )
  }
  return { subject, blocks }
}

function renderGuestPromoted(vars: TemplateVars, locale: Locale): TemplateContent {
  const title = stringVar(vars, "title", DEFAULT_EVENT_TITLE)
  const when = stringVar(vars, "when", "")
  const eventUrl = optionalVar(vars, "eventUrl")
  const subject = renderMessage(locale, "email.guest_promoted.subject", { title })
  const blocks: EmailBlock[] = [
    paragraph(renderMessage(locale, "email.guest_promoted.intro", { title, when })),
  ]
  if (eventUrl !== undefined) {
    blocks.push(button(eventUrl, renderMessage(locale, "email.guest_promoted.cta")))
  }
  blocks.push(paragraph(renderMessage(locale, "email.guest_promoted.ignore"), { muted: true }))
  return { subject, blocks }
}

function renderAction(vars: TemplateVars, locale: Locale): TemplateContent {
  const subject = stringVar(vars, "subject", renderMessage(locale, "email.generic.subject"))
  const blocks: EmailBlock[] = paragraphsVar(vars).map((p) => paragraph(p))
  const quoteHeading = optionalVar(vars, "quoteHeading")
  const quoted = optionalVar(vars, "quote")
  if (quoted !== undefined) {
    if (quoteHeading !== undefined) blocks.push(heading(quoteHeading))
    blocks.push(quote(quoted))
  }
  const ctaUrl = optionalVar(vars, "ctaUrl")
  if (ctaUrl !== undefined) {
    blocks.push(button(ctaUrl, stringVar(vars, "ctaLabel", DEFAULT_CTA_LABEL)))
  }
  const note = optionalVar(vars, "note")
  if (note !== undefined) blocks.push(paragraph(note, { muted: true }))
  if (blocks.length === 0) {
    blocks.push(paragraph(renderMessage(locale, "email.generic.body")))
  }
  return { subject, blocks }
}

function renderGeneric(vars: TemplateVars, locale: Locale): TemplateContent {
  const subject = stringVar(vars, "subject", renderMessage(locale, "email.generic.subject"))
  const message = stringVar(vars, "message", renderMessage(locale, "email.generic.body"))
  return { subject, blocks: [paragraph(message)] }
}

function stringVar(vars: TemplateVars, key: string, fallback: string): string {
  const v = vars[key]
  return typeof v === "string" && v.length > 0 ? v : fallback
}

function optionalVar(vars: TemplateVars, key: string): string | undefined {
  const v = vars[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function paragraphsVar(vars: TemplateVars): string[] {
  const v = vars.paragraphs
  if (!Array.isArray(v)) return []
  return v.filter((p): p is string => typeof p === "string" && p.length > 0)
}

function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
}
