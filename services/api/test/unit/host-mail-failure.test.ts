import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import { AppError, ErrorCode, MailSendError } from "@civfix/shared"
import { LOG_REDACT_PATHS } from "../../src/server.js"
import { isRetryableMailFailure, mailFailure, mailFailureKind } from "../../src/adapters/mail-failure.js"

describe("mailFailure", () => {
  it("classifies an auth rejection", () => {
    expect(mailFailureKind({ code: "EAUTH", response: "535 bad credentials" })).toBe("auth")
  })

  it("classifies oversize by response code and by text", () => {
    expect(mailFailureKind({ responseCode: 552 })).toBe("oversize")
    expect(mailFailureKind({ responseCode: 523 })).toBe("oversize")
    expect(mailFailureKind({ response: "552 Message too large" })).toBe("oversize")
    expect(mailFailureKind({ response: "5.3.4 message size exceeds the maximum size" })).toBe(
      "oversize",
    )
  })

  it("fails an UNCLASSIFIABLE 5xx to the sender side, never to a recipient suppression", () => {
    expect(mailFailureKind({ responseCode: 550 })).toBe("auth")
    expect(mailFailureKind({ responseCode: 550, response: "550 request failed" })).toBe("auth")
    expect(
      mailFailureKind({
        responseCode: 550,
        response: "550 5.7.1 Service unavailable; client host blocked",
      }),
    ).toBe("auth")
    expect(mailFailureKind({ responseCode: 451 })).toBe("transient")
  })

  it("keeps a relay refusal on the sender side even when it arrives on RCPT TO", () => {
    expect(
      mailFailureKind({
        responseCode: 550,
        command: "RCPT TO",
        response: "550 5.7.1 relay access denied",
      }),
    ).toBe("auth")
    expect(
      mailFailureKind({ responseCode: 550, command: "RCPT TO", response: "550 relay not permitted" }),
    ).toBe("auth")
    expect(
      mailFailure({
        responseCode: 550,
        command: "RCPT TO",
        response: "550 Sender address rejected: not an approved sender",
      }),
    ).toMatchObject({ kind: "auth", senderRejected: true })
  })

  it("classifies socket-level failures as transient", () => {
    expect(mailFailureKind({ code: "ETIMEDOUT" })).toBe("transient")
    expect(mailFailureKind({ code: "ECONNRESET" })).toBe("transient")
    expect(isRetryableMailFailure({ code: "ESOCKET" })).toBe(true)
  })

  it("falls back to unknown and never throws", () => {
    expect(mailFailureKind(null)).toBe("unknown")
    expect(mailFailureKind(undefined)).toBe("unknown")
    expect(mailFailureKind("nope")).toBe("unknown")
    expect(mailFailureKind(new Error("boom"))).toBe("unknown")
  })

  it("classifies a SENDER rejection as auth, never as a recipient hard bounce", () => {
    expect(mailFailureKind({ responseCode: 550, response: "550 5.7.1 Sender address rejected" })).toBe(
      "auth",
    )
    expect(mailFailureKind({ responseCode: 553, response: "553 sorry, that domain isn't allowed" })).toBe(
      "auth",
    )
    expect(mailFailureKind({ responseCode: 530, response: "530 Authentication required" })).toBe("auth")
    expect(mailFailureKind({ responseCode: 535, response: "535 auth failed" })).toBe("auth")
    expect(mailFailureKind({ responseCode: 554, response: "554 5.7.1 Relay access denied" })).toBe(
      "auth",
    )
    expect(
      mailFailureKind({ responseCode: 550, command: "MAIL FROM", response: "550 no" }),
    ).toBe("auth")
    expect(mailFailure({ responseCode: 550, response: "550 5.7.1 Sender address rejected" }).senderRejected).toBe(
      true,
    )
  })

  it("still classifies a RECIPIENT rejection as permanent (the only thing that suppresses)", () => {
    expect(mailFailureKind({ responseCode: 550, response: "550 5.1.1 No such user here" })).toBe(
      "permanent",
    )
    expect(
      mailFailureKind({ responseCode: 550, command: "RCPT TO", response: "550 mailbox unavailable" }),
    ).toBe("permanent")
    expect(
      mailFailure({ responseCode: 550, response: "550 5.1.1 unknown user" }).senderRejected,
    ).toBe(false)
  })

  it("does not read a recipient rejection as a sender problem because it mentions the sender's domain", () => {
    expect(
      mailFailureKind({
        responseCode: 550,
        response: "550 5.1.1 recipient rejected: mail from unknown domain of sender",
      }),
    ).toBe("permanent")
  })

  it("preserves the provider detail for operator copy", () => {
    const failure = mailFailure({ responseCode: 550, response: "550 not an approved sender" })
    expect(failure.response).toBe("550 not an approved sender")
    expect(failure.responseCode).toBe(550)
  })

  it("does not treat an oversize 5xx as a sender-approval problem", () => {
    expect(mailFailureKind({ responseCode: 552, response: "552 too big" })).toBe("oversize")
  })
})

describe("mailFailure reads THROUGH the Mailer seam", () => {
  it("reads the smtp detail off a MailSendError instead of its AppError code", () => {
    const err = new MailSendError(ErrorCode.CONFLICT, "Email not sent: ...", {
      responseCode: 550,
      command: "RCPT TO",
      response: "550 5.1.1 no such user here",
      code: "EENVELOPE",
    })
    expect(mailFailure(err)).toMatchObject({
      kind: "permanent",
      responseCode: 550,
      command: "RCPT TO",
      code: "EENVELOPE",
    })
  })

  it("follows `cause` when a raw provider error is merely wrapped", () => {
    const raw = Object.assign(new Error("boom"), { code: "EAUTH", response: "535 bad creds" })
    const wrapped = new AppError(ErrorCode.INTERNAL, "Failed to send email.", { cause: raw })
    expect(mailFailureKind(wrapped)).toBe("auth")
  })

  it("does not mistake a plain AppError for an SMTP failure", () => {
    expect(mailFailureKind(new AppError(ErrorCode.CONFLICT, "nope"))).toBe("unknown")
    expect(mailFailure(new AppError(ErrorCode.CONFLICT, "nope")).code).toBeUndefined()
  })
})

describe("the verbatim SMTP reply never reaches a log line", () => {
  const RECIPIENT_ECHO = "550 5.1.1 <resident@example.org>: recipient unknown"

  function capture(payload: Record<string, unknown>): string {
    const lines: string[] = []
    const instance = Fastify({
      logger: {
        level: "info",
        redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
        stream: {
          write(line: string) {
            lines.push(line)
          },
        },
      },
    })
    instance.log.error(payload, "mail send failed")
    return lines.join("")
  }

  it("redacts smtp.response at the top level, one level down and under err", () => {
    const smtp = { responseCode: 550, command: "RCPT TO", response: RECIPIENT_ECHO }
    for (const payload of [{ smtp }, { failure: { smtp } }, { err: { smtp } }]) {
      const line = capture(payload)
      expect(line).not.toContain("resident@example.org")
      expect(line).toContain("[REDACTED]")
      expect(line).toContain("550")
    }
  })

  it("keeps the smtp detail out of the serialized AppError body", () => {
    const error = new MailSendError(ErrorCode.CONFLICT, "Email not sent.", {
      responseCode: 550,
      response: RECIPIENT_ECHO,
    })
    expect(JSON.stringify(error.toJSON())).not.toContain("resident@example.org")
    expect(Object.keys(error.toJSON())).not.toContain("smtp")
  })
})
