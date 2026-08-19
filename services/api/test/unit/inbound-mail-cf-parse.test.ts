import { describe, it, expect } from "vitest"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import { detectBounce } from "../../src/services/admin/inbound-bounce.js"

function bytes(msg: string): Uint8Array {
  return new TextEncoder().encode(msg)
}

const DSN_BOUNDARY = "=_report_boundary_1"

function rfc3464Bounce(): Uint8Array {
  return bytes(
    [
      "From: Mail Delivery System <MAILER-DAEMON@mail.example.com>",
      "To: report-abcd1234efgh@civfix.org",
      "Subject: Delivery Status Notification (Failure)",
      "Message-ID: <dsn-abc@mail.example.com>",
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${DSN_BOUNDARY}"`,
      "MIME-Version: 1.0",
      "",
      `--${DSN_BOUNDARY}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your message could not be delivered to publicworks@city.gov.",
      "",
      `--${DSN_BOUNDARY}`,
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mail.example.com",
      "",
      "Final-Recipient: rfc822; publicworks@city.gov",
      "Action: failed",
      "Status: 5.1.1",
      "",
      `--${DSN_BOUNDARY}`,
      "Content-Type: message/rfc822",
      "",
      "Message-ID: <original-outbound-42@civfix.org>",
      "To: publicworks@city.gov",
      "Subject: Case ABC123",
      "",
      "Original outbound body.",
      `--${DSN_BOUNDARY}--`,
      "",
    ].join("\r\n"),
  )
}

function manyPartMessage(parts: number): Uint8Array {
  const boundary = "b0undary_many"
  const lines: string[] = [
    "From: attacker@evil.test",
    "To: report-abcd1234efgh@civfix.org",
    "Subject: bomb",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "MIME-Version: 1.0",
    "",
  ]
  for (let i = 0; i < parts; i++) {
    lines.push(`--${boundary}`)
    lines.push("Content-Type: text/plain")
    lines.push(`Content-Disposition: attachment; filename="a${i}.txt"`)
    lines.push("")
    lines.push("x")
  }
  lines.push(`--${boundary}--`)
  lines.push("")
  return bytes(lines.join("\r\n"))
}

describe("CfInboundMail.parse — structured content-type rendering (F099)", () => {
  it("renders a structured multipart/report content-type back to header-string form, not a JSON blob", async () => {
    const parsed = await new CfInboundMail().parse(rfc3464Bounce())
    const contentType = parsed.headers["content-type"]
    expect(typeof contentType).toBe("string")
    expect(contentType).not.toMatch(/^\s*\{/)
    expect(contentType).toContain("multipart/report")
    expect(contentType).toContain("report-type=delivery-status")
  })

  it("lets detectBounce classify a real RFC 3464 DSN through the REAL adapter", async () => {
    const parsed = await new CfInboundMail().parse(rfc3464Bounce())
    const detection = detectBounce(parsed)
    expect(detection.isBounce).toBe(true)
    expect(detection.failedRecipient).toBe("publicworks@city.gov")
  })
})

describe("CfInboundMail.parse — MIME part-count pre-scan (F097)", () => {
  it("rejects a message with too many MIME parts BEFORE mailparser can stall, and does so quickly", async () => {
    const started = Date.now()
    await expect(new CfInboundMail().parse(manyPartMessage(300))).rejects.toThrow(
      /too many MIME parts/,
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("still parses a legitimate small multipart message", async () => {
    const parsed = await new CfInboundMail().parse(manyPartMessage(3))
    expect(parsed.attachments?.length).toBe(3)
    expect(parsed.subject).toBe("bomb")
  })
})
