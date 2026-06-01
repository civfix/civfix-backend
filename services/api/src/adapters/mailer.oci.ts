/**
 * REAL Mailer adapter backed by OCI Email Delivery over SMTP (nodemailer).
 *
 * SCAFFOLD: bodies throw until a later step implements them. nodemailer is referenced via
 * `import type` only here.
 *
 * Seam rule: nodemailer may ONLY be imported in this file.
 */

import { AppError } from "@civfix/shared"
import type { Mailer } from "@civfix/shared/interfaces"
// import type { Transporter } from "nodemailer"

export interface OciMailerConfig {
  host: string
  port: number
  user: string
  pass: string
  fromNoReply: string
  fromOutreach: string
}

const NOT_IMPL = "adapter not implemented: mailer.oci"

export class OciMailer implements Mailer {
  private readonly config: OciMailerConfig

  constructor(config: OciMailerConfig) {
    this.config = config
  }

  sendOtp(_to: string, _code: string): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  sendTransactional(_to: string, _template: string, _vars: Record<string, unknown>): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
