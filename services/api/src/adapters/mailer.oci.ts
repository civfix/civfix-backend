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
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { Mailer } from "@civfix/shared/interfaces"
import type { Transporter } from "nodemailer"

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
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        // OCI Email Delivery uses STARTTLS on 587; `secure` is true only for implicit TLS (465).
        secure: this.config.port === 465,
        auth: { user: this.config.user, pass: this.config.pass },
      })
    }
    return this.transporter
  }

  private async send(to: string, body: Rendered): Promise<void> {
    const transporter = await this.getTransporter()
    try {
      await transporter.sendMail({
        from: this.config.fromNoReply,
        to,
        subject: body.subject,
        text: body.text,
        html: body.html,
      })
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "Failed to send email.", { cause: err })
    }
  }
}

/** Render the OTP email. */
function renderOtp(code: string): Rendered {
  const subject = "Your civfix sign-in code"
  const text = [
    `Your civfix sign-in code is ${code}.`,
    "",
    "It expires in 5 minutes. If you did not request it, you can ignore this email.",
  ].join("\n")
  const html = [
    "<p>Your civfix sign-in code is:</p>",
    `<p style="font-size:24px;font-weight:bold;letter-spacing:3px">${code}</p>`,
    "<p>It expires in 5 minutes. If you did not request it, you can ignore this email.</p>",
  ].join("")
  return { subject, text, html }
}

/**
 * Render a named transactional template. Unknown templates fall back to a generic notification so a
 * missing template never throws at send time. Kept small for Phase 1.
 */
function renderTemplate(template: string, vars: Record<string, unknown>): Rendered {
  switch (template) {
    case "report_update": {
      const status = stringVar(vars, "status", "updated")
      const subject = `Your civfix report was ${status}`
      const text = `Your report has a new status: ${status}.`
      const html = `<p>Your report has a new status: <strong>${status}</strong>.</p>`
      return { subject, text, html }
    }
    default: {
      const subject = stringVar(vars, "subject", "A civfix notification")
      const message = stringVar(vars, "message", "You have a new civfix notification.")
      return { subject, text: message, html: `<p>${message}</p>` }
    }
  }
}

/** Read a string variable from a template var bag, with a fallback. */
function stringVar(vars: Record<string, unknown>, key: string, fallback: string): string {
  const v = vars[key]
  return typeof v === "string" && v.length > 0 ? v : fallback
}
