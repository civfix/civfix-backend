
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AppError, ErrorCode } from "@civfix/shared"
import type { OutboundEmail } from "@civfix/shared/interfaces"
import {
  OciMailer,
  OCI_MAILER_DEFAULT_TIMEOUT_MS,
} from "../../src/adapters/mailer.oci.js"

interface SentMailArgs {
  from: string
  to: string
  subject: string
  text?: string
  html?: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  headers?: Record<string, string>
}

const sendMail = vi.fn<(args: SentMailArgs) => Promise<unknown>>()
const verify = vi.fn(async () => true)
let lastTransportOpts: Record<string, unknown> | undefined

vi.mock("nodemailer", () => ({
  createTransport: (opts: Record<string, unknown>) => {
    lastTransportOpts = opts
    return { sendMail, verify }
  },
}))

const CONFIG = {
  host: "smtp.email.us-ashburn-1.oci.oraclecloud.com",
  port: 587,
  user: "ocid1.user",
  pass: "secret",
  fromNoReply: "no-reply@civfix.org",
  fromOutreach: "civfix <outreach@civfix.org>",
}

function outbound(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    from: "civfix <report-abc123@civfix.org>",
    to: "publicworks@city.gov",
    subject: "Case ABC123",
    text: "A pothole was reported.",
    ...overrides,
  } as OutboundEmail
}

beforeEach(() => {
  sendMail.mockReset()
  sendMail.mockResolvedValue({ accepted: ["x"] })
  lastTransportOpts = undefined
})

describe("OciMailer.sendOutbound header handling", () => {
  it("REJECTS an envelope address containing a newline (SMTP header injection)", async () => {
    const mailer = new OciMailer(CONFIG)
    await expect(
      mailer.sendOutbound(outbound({ to: "victim@city.gov\r\nBcc: attacker@evil.test" })),
    ).rejects.toBeInstanceOf(AppError)
    expect(sendMail).not.toHaveBeenCalled()

    await expect(
      mailer.sendOutbound(outbound({ from: "a@civfix.org\nX-Injected: 1" })),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL })
    const nul = String.fromCharCode(0)
    await expect(
      mailer.sendOutbound(outbound({ replyTo: `a@civfix.org${nul}` })),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("SANITIZES the subject, custom headers, In-Reply-To and References", async () => {
    const mailer = new OciMailer(CONFIG)
    await mailer.sendOutbound(
      outbound({
        subject: "Case ABC123\r\nX-Evil: yes",
        inReplyTo: "<in\r\nX-Evil: yes@city.gov>",
        references: ["<a@city.gov>", "<b\r\nX-Evil: yes@city.gov>"],
        headers: { "X-Civfix-Thread\r\nX-Evil": "abc\r\ndef" },
      }),
    )

    const args = sendMail.mock.calls[0]![0]
    expect(args.subject).toBe("Case ABC123X-Evil: yes")
    expect(args.inReplyTo).not.toMatch(/[\r\n]/)
    expect(args.references?.every((r) => !/[\r\n]/.test(r))).toBe(true)
    for (const [key, value] of Object.entries(args.headers ?? {})) {
      expect(key).not.toMatch(/[\r\n]/)
      expect(value).not.toMatch(/[\r\n]/)
    }
  })

  it("generates a <uuid@from-domain> Message-ID when none is supplied, and honors one that is", async () => {
    const mailer = new OciMailer(CONFIG)

    const generated = await mailer.sendOutbound(outbound())
    expect(generated.messageId).toMatch(/^<[0-9a-f-]{36}@civfix\.org>$/)
    expect(sendMail.mock.calls[0]![0].messageId).toBe(generated.messageId)

    const explicit = await mailer.sendOutbound(outbound({ messageId: "<out-42@civfix.org>" }))
    expect(explicit.messageId).toBe("<out-42@civfix.org>")
  })

  it("uses STARTTLS on 587 and implicit TLS on 465", async () => {
    await new OciMailer(CONFIG).sendOutbound(outbound())
    expect(lastTransportOpts).toMatchObject({ port: 587, secure: false, requireTLS: true })

    await new OciMailer({ ...CONFIG, port: 465 }).sendOutbound(outbound())
    expect(lastTransportOpts).toMatchObject({ port: 465, secure: true })
  })
})

describe("OciMailer error classification", () => {
  it("maps a permanent 5xx to CONFLICT with the approved-sender remediation", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("rejected"), {
        responseCode: 550,
        code: "EENVELOPE",
        response: "550 relay not permitted",
      }),
    )
    const mailer = new OciMailer(CONFIG)
    await expect(mailer.sendOutbound(outbound())).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    })
    await mailer.sendOutbound(outbound()).catch((err: AppError) => {
      expect(err.message).toContain("approved sender")
      expect(err.message).toContain("@civfix.org")
      expect(err.message).toContain("550 relay not permitted")
    })
  })

  it("maps a size rejection (552 / 'message too large') to CONFLICT about size, not approved-sender", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("too big"), {
        responseCode: 552,
        response: "552 message size exceeds the administrative limit",
      }),
    )
    const mailer = new OciMailer(CONFIG)
    await mailer.sendOutbound(outbound()).then(
      () => expect.unreachable("send should reject"),
      (err: AppError) => {
        expect(err.code).toBe(ErrorCode.CONFLICT)
        expect(err.message).toContain("too large")
        expect(err.message).not.toContain("approved sender")
      },
    )

    sendMail.mockRejectedValue(
      Object.assign(new Error("x"), { responseCode: 550, response: "550 message too large" }),
    )
    await mailer.sendOutbound(outbound()).catch((err: AppError) => {
      expect(err.code).toBe(ErrorCode.CONFLICT)
      expect(err.message).toContain("too large")
    })
  })

  it("maps EAUTH to INTERNAL with a CREDENTIALS message, not the approved-sender one", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("auth failed"), {
        responseCode: 535,
        code: "EAUTH",
        response: "535 Authentication credentials invalid",
      }),
    )
    const mailer = new OciMailer(CONFIG)
    await mailer.sendOutbound(outbound()).then(
      () => expect.unreachable("send should reject"),
      (err: AppError) => {
        expect(err.code).toBe(ErrorCode.INTERNAL)
        expect(err.message).toContain("OCI_EMAIL_SMTP_USER")
        expect(err.message).not.toContain("approved sender")
      },
    )
  })

  it("maps anything else (transient / codeless) to a generic INTERNAL", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("timeout"), { responseCode: 421, code: "ETIMEDOUT" }),
    )
    const mailer = new OciMailer(CONFIG)
    await expect(mailer.sendOutbound(outbound())).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      message: "Failed to send email.",
    })

    sendMail.mockRejectedValue(new Error("socket closed"))
    await expect(mailer.sendOutbound(outbound())).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
      message: "Failed to send email.",
    })
  })
})

describe("OciMailer.sendOtp", () => {
  it("renders the passcode email and localizes it when a locale is passed", async () => {
    const mailer = new OciMailer(CONFIG)

    await mailer.sendOtp("user@example.com", "123456")
    const english = sendMail.mock.calls[0]![0]
    expect(english.from).toBe(CONFIG.fromNoReply)
    expect(english.to).toBe("user@example.com")
    expect(english.subject).toBe("Your civfix sign-in code")
    expect(english.html).toContain("123456")
    expect(english.text).toContain("123456")

    await mailer.sendOtp("user@example.com", "123456", "es-419")
    expect(sendMail.mock.calls[1]![0].subject).toBe("Tu código de acceso a civfix")
  })

  it("rejects a recipient containing a newline", async () => {
    const mailer = new OciMailer(CONFIG)
    await expect(mailer.sendOtp("a@b.test\r\nBcc: c@d.test", "123456")).rejects.toBeInstanceOf(
      AppError,
    )
  })
})

describe("OciMailer.sendTransactional", () => {
  it("renders the report_update template with the interpolated status", async () => {
    await new OciMailer(CONFIG).sendTransactional("user@example.com", "report_update", {
      status: "resolved",
    })
    const args = sendMail.mock.calls[0]![0]
    expect(args.subject).toBe("Your civfix report was resolved")
    expect(args.text).toContain("Your report has a new status: resolved.")
    expect(args.html).toContain("resolved")
  })

  it("localizes from a `locale` var", async () => {
    await new OciMailer(CONFIG).sendTransactional("user@example.com", "report_update", {
      status: "resuelto",
      locale: "es",
    })
    expect(sendMail.mock.calls[0]![0].subject).toBe("Tu reporte en civfix fue resuelto")
  })

  it("falls back to the generic template for an unknown name, honoring caller subject/message", async () => {
    const mailer = new OciMailer(CONFIG)

    await mailer.sendTransactional("user@example.com", "nope", {})
    expect(sendMail.mock.calls[0]![0].subject).toBe("A civfix notification")

    await mailer.sendTransactional("user@example.com", "nope", {
      subject: "Custom subject",
      message: "Custom message",
    })
    expect(sendMail.mock.calls[1]![0].subject).toBe("Custom subject")
    expect(sendMail.mock.calls[1]![0].text).toContain("Custom message")
  })

  it("sanitizes a header-injecting subject var", async () => {
    await new OciMailer(CONFIG).sendTransactional("user@example.com", "nope", {
      subject: "Hi\r\nX-Evil: yes",
    })
    expect(sendMail.mock.calls[0]![0].subject).not.toMatch(/[\r\n]/)
  })
})

describe("OciMailer transport timeouts", () => {
  it("arms connect/greeting/socket timeouts with the configured value", async () => {
    const mailer = new OciMailer({ ...CONFIG, timeoutMs: 4321 })
    await mailer.sendOutbound(outbound())
    expect(lastTransportOpts).toMatchObject({
      connectionTimeout: 4321,
      greetingTimeout: 4321,
      socketTimeout: 4321,
    })
  })

  it("falls back to the default timeout when none is configured (never unbounded)", async () => {
    const mailer = new OciMailer(CONFIG)
    await mailer.sendOutbound(outbound())
    expect(OCI_MAILER_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(lastTransportOpts).toMatchObject({
      connectionTimeout: OCI_MAILER_DEFAULT_TIMEOUT_MS,
      greetingTimeout: OCI_MAILER_DEFAULT_TIMEOUT_MS,
      socketTimeout: OCI_MAILER_DEFAULT_TIMEOUT_MS,
    })
  })
})
