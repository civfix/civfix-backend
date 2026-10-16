import { describe, expect, it } from "vitest"
import { AppError, ErrorCode } from "@civfix/contract"
import { MailSendError } from "../src/mail-send-error.js"

describe("MailSendError", () => {
  it("is an AppError that carries the SMTP detail", () => {
    const mail = new MailSendError(ErrorCode.INTERNAL, "smtp down", { responseCode: 421 })
    expect(mail).toBeInstanceOf(MailSendError)
    expect(mail).toBeInstanceOf(AppError)
    expect(mail.smtp).toEqual({ responseCode: 421 })
    expect(mail.name).toBe("MailSendError")
  })
})
