import type { ParsedMail } from "@civfix/shared/interfaces"
import { describe, expect, it } from "vitest"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import {
  detectBounce,
  extractEmail,
  matchBracketId,
} from "../../src/services/admin/inbound-bounce.js"

const RUN = 64 * 1024
const BUDGET_MS = 500

function daemonMail(over: Partial<ParsedMail>): ParsedMail {
  return {
    from: { address: "MAILER-DAEMON@mail.example.com" },
    to: [],
    subject: "Undelivered Mail Returned to Sender",
    text: null,
    html: null,
    messageId: null,
    inReplyTo: null,
    headers: {},
    ...over,
  }
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now()
  const value = fn()
  return { value, ms: performance.now() - started }
}

describe("bounce parsing stays linear on attacker-sized input", () => {
  it("scans a long X-Failed-Recipients header with no address in linear time", () => {
    const mail = daemonMail({ headers: { "x-failed-recipients": "a".repeat(RUN) } })
    const { value, ms } = timed(() => detectBounce(mail))
    expect(value.isBounce).toBe(true)
    expect(value.failedRecipient).toBeNull()
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("scans a Final-Recipient label followed by a long run of newlines in linear time", () => {
    const mail = daemonMail({ text: `Final-Recipient:${"\n".repeat(RUN)}` })
    const { value, ms } = timed(() => detectBounce(mail))
    expect(value.isBounce).toBe(true)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("scans a Message-ID line of unclosed brackets in linear time", () => {
    const mail = daemonMail({ text: `Message-ID: ${"<".repeat(RUN)}` })
    const { value, ms } = timed(() => detectBounce(mail))
    expect(value.originalMessageId).toMatch(/^<+$/)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it("stays linear end to end through the real mail parser", async () => {
    const raw = new TextEncoder().encode(
      [
        "From: Mail Delivery System <MAILER-DAEMON@mail.example.com>",
        "To: report-abcd1234efgh@civfix.org",
        "Subject: Undelivered Mail Returned to Sender",
        `X-Failed-Recipients: ${"a".repeat(RUN)}`,
        "Content-Type: text/plain",
        "",
        `Final-Recipient: rfc822; ${"b".repeat(RUN)}`,
        `Original-Message-ID: ${"<".repeat(RUN)}`,
        "",
      ].join("\r\n"),
    )
    const parsed = await new CfInboundMail().parse(raw)
    const { value, ms } = timed(() => detectBounce(parsed))
    expect(value.isBounce).toBe(true)
    expect(value.failedRecipient).toBeNull()
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe("the linear rewrites keep the first match", () => {
  it("extractEmail returns the leftmost address, whole local part included", () => {
    expect(extractEmail("Final: rfc822; ab.c+tag@city.gov (x) d@e.org")).toBe("ab.c+tag@city.gov")
    expect(extractEmail("<<publicworks@city.gov>>")).toBe("publicworks@city.gov")
    expect(extractEmail("no address here")).toBeNull()
  })

  it("Final-Recipient keeps the rfc822 prefix optional and trims to the address", () => {
    const withPrefix = daemonMail({ text: "Final-Recipient: rfc822;   ops@city.gov\n" })
    const without = daemonMail({ text: "Final-Recipient:\tops@city.gov\n" })
    expect(detectBounce(withPrefix).failedRecipient).toBe("ops@city.gov")
    expect(detectBounce(without).failedRecipient).toBe("ops@city.gov")
  })

  it("matchBracketId returns the first bracketed id and falls back to the trimmed value", () => {
    expect(matchBracketId(" <a@b> <c@d> ")).toBe("<a@b>")
    expect(matchBracketId("x<a@b>y<")).toBe("<a@b>")
    expect(matchBracketId("  bare-id@host  ")).toBe("bare-id@host")
    expect(matchBracketId("<>")).toBe("<>")
    expect(matchBracketId("   ")).toBeNull()
  })
})
