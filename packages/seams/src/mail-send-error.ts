import { AppError, type AppErrorOptions, type ErrorCode } from "@civfix/contract"

// A Mailer seam failure: an AppError that also carries the SMTP detail the adapter saw, for logs and
// retry decisions. Server-only, so it lives with the seam rather than in the contract.
export interface SmtpFailureDetail {
  responseCode?: number
  command?: string
  response?: string
  code?: string
}

export class MailSendError extends AppError {
  readonly smtp: SmtpFailureDetail

  constructor(
    code: ErrorCode,
    message: string,
    smtp: SmtpFailureDetail,
    opts: AppErrorOptions = {},
  ) {
    super(code, message, opts)
    this.name = "MailSendError"
    this.smtp = smtp
  }
}
