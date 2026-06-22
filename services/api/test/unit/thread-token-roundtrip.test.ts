import { describe, it, expect } from "vitest"
import { FakeInboundMail } from "@civfix/shared/fakes"
import type { ParsedMail } from "@civfix/shared/interfaces"
import { mintThreadToken } from "../../src/services/admin/mail-repository.drizzle.js"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"

/**
 * Regression lock for the two production-only thread-token bugs (issue #40):
 *   - the outbound side mints `reply+{token}@` from a 24-hex `mintThreadToken()` value, and
 *   - BOTH the real CfInboundMail adapter AND the FakeInboundMail recover that exact token from the
 *     plus-address recipient, so a jurisdiction's reply threads back onto the report.
 * The old `sendToCity` minted `geo-{geoid}` tokens, which the real adapter's `^[0-9a-f]{24}$` shape gate
 * REJECTS — so replies never threaded in production while every fake-based test passed. This test asserts
 * the real adapter and the fake now AGREE on the same accept (24-hex) / reject (`geo-…`) behavior, so the
 * bug cannot silently return.
 *
 * The real adapter only lazy-imports mailparser inside parse(); extractThreadToken() is pure, so it is
 * safe to call here without mailparser installed (we hand it a ParsedMail directly, never calling parse).
 */

/** Build a minimal ParsedMail whose only `to` recipient is `addr` (the rest defaulted/empty). */
function mailTo(addr: string, headers: Record<string, string> = {}): ParsedMail {
  return {
    from: { address: "clerk@lacity.gov" },
    to: [{ address: addr }],
    subject: "Re: civfix report",
    text: "Thanks, we'll take a look.",
    html: null,
    messageId: "<reply-1@lacity.gov>",
    inReplyTo: null,
    headers,
  }
}

describe("thread token round-trip (mint -> reply+{token}@ -> extract)", () => {
  const fake = new FakeInboundMail()
  const real = new CfInboundMail()

  it("a freshly minted token is recovered by BOTH the real adapter and the fake", () => {
    const token = mintThreadToken()
    expect(token).toMatch(/^[0-9a-f]{24}$/)
    const mail = mailTo(`reply+${token}@civfix.org`)
    expect(real.extractThreadToken(mail)).toBe(token)
    expect(fake.extractThreadToken(mail)).toBe(token)
  })

  it("the legacy geo-{geoid} token is REJECTED by both (the bug, now locked closed)", () => {
    const mail = mailTo("reply+geo-06037@civfix.org")
    expect(real.extractThreadToken(mail)).toBeNull()
    expect(fake.extractThreadToken(mail)).toBeNull()
  })

  it("an X-Thread-Token header carrying a 24-hex token is recovered by both", () => {
    const token = mintThreadToken()
    const mail = mailTo("clerk@lacity.gov", { "x-thread-token": token })
    expect(real.extractThreadToken(mail)).toBe(token)
    expect(fake.extractThreadToken(mail)).toBe(token)
  })

  it("a non-reply recipient with no token yields null from both", () => {
    const mail = mailTo("support@civfix.org")
    expect(real.extractThreadToken(mail)).toBeNull()
    expect(fake.extractThreadToken(mail)).toBeNull()
  })
})
