import { describe, it, expect } from "vitest"
import { FakeInboundMail } from "@civfix/shared/fakes"
import type { ParsedMail } from "@civfix/shared/interfaces"
import { mintThreadToken } from "../../src/services/admin/mail-repository.drizzle.js"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"

/**
 * Regression lock for the thread-token round-trip (originally issue #40):
 *   - the outbound side mints a token via `mintThreadToken()` and sends FROM `{kind}-{token}@`, and
 *   - BOTH the real CfInboundMail adapter AND the FakeInboundMail recover that exact token from the
 *     reply address, so a jurisdiction's reply threads back onto the report/event.
 * The two adapters MUST agree on accept/reject — the original bug was the real adapter rejecting a token
 * shape the fake accepted, so replies silently never threaded in prod while every fake-based test passed.
 * This locks: the current 12-char base32 token round-trips through both, the legacy 24-hex token and the
 * legacy `+` separator still parse (in-flight replies), and obvious junk is rejected by both.
 *
 * The real adapter only lazy-imports mailparser inside parse(); extractThreadToken() is pure, so it is
 * safe to call here without mailparser installed (we hand it a ParsedMail directly, never calling parse).
 */

/** Build a minimal ParsedMail whose `to` recipients are `addrs` (the rest defaulted/empty). */
function mailTo(addrs: string | string[], headers: Record<string, string> = {}): ParsedMail {
  const list = Array.isArray(addrs) ? addrs : [addrs]
  return {
    from: { address: "clerk@lacity.gov" },
    to: list.map((address) => ({ address })),
    subject: "Re: civfix report",
    text: "Thanks, we'll take a look.",
    html: null,
    messageId: "<reply-1@lacity.gov>",
    inReplyTo: null,
    headers,
  }
}

describe("thread token round-trip (mint -> {kind}-{token}@ -> extract)", () => {
  const fake = new FakeInboundMail()
  const real = new CfInboundMail()

  it("mints a 12-char lowercase base32 token", () => {
    expect(mintThreadToken()).toMatch(/^[a-z2-7]{12}$/)
  })

  it("a freshly minted token is recovered by BOTH the real adapter and the fake", () => {
    const token = mintThreadToken()
    const mail = mailTo(`report-${token}@civfix.org`)
    expect(real.extractThreadToken(mail)).toBe(token)
    expect(fake.extractThreadToken(mail)).toBe(token)
  })

  it("the legacy geo-{geoid} token is REJECTED by both", () => {
    const mail = mailTo("reply-geo-06037@civfix.org")
    expect(real.extractThreadToken(mail)).toBeNull()
    expect(fake.extractThreadToken(mail)).toBeNull()
  })

  it("M7: the REAL adapter IGNORES an X-Thread-Token header (spoofable thread selector)", () => {
    const token = mintThreadToken()
    const mail = mailTo("clerk@lacity.gov", { "x-thread-token": token })
    // The header path is deleted: a token is only ever accepted from a recipient address on our own
    // reply domain. Anyone who has seen one outbound civfix email knows a live token (it is printed in
    // the From address on purpose), so a header-selected thread let a forged message drive report
    // status changes and post an "official city reply" into the public report chat.
    expect(real.extractThreadToken(mail)).toBeNull()
    // The shared FakeInboundMail (an external @civfix/shared package) still honors the header. That is
    // dev/test-only — the real adapter is what production uses — and the processor's DMARC gate now
    // stands in front of the threaded path regardless. Tracked for the next @civfix/shared release.
    expect(fake.extractThreadToken(mail)).toBe(token)
  })

  it("a non-reply recipient with no token yields null from both", () => {
    const mail = mailTo("support@civfix.org")
    expect(real.extractThreadToken(mail)).toBeNull()
    expect(fake.extractThreadToken(mail)).toBeNull()
  })

  it("recovers the token from reply- / report- / event- local-parts (both adapters)", () => {
    const token = mintThreadToken()
    for (const kind of ["reply", "report", "event"]) {
      const mail = mailTo(`${kind}-${token}@civfix.org`)
      expect(real.extractThreadToken(mail)).toBe(token)
      expect(fake.extractThreadToken(mail)).toBe(token)
    }
  })

  it("still parses a legacy 24-hex token on the legacy + separator (in-flight replies)", () => {
    const legacy = "0123456789abcdef01234567"
    const mail = mailTo(`report+${legacy}@civfix.org`)
    expect(real.extractThreadToken(mail)).toBe(legacy)
    expect(fake.extractThreadToken(mail)).toBe(legacy)
  })

  it("rejects a garbage / malformed token on a report- / event- address (both adapters)", () => {
    for (const addr of [
      "report-not.a.token@civfix.org",
      "event-ZZZZ@civfix.org",
      "report-geo-06037@civfix.org",
    ]) {
      expect(real.extractThreadToken(mailTo(addr))).toBeNull()
      expect(fake.extractThreadToken(mailTo(addr))).toBeNull()
    }
  })

  it("ignores a typed prefix on a FOREIGN domain (no thread hijack), both adapters", () => {
    // A city's own alias or a mailing-list decoy whose local-part happens to start report-/event-/reply-
    // must NOT be read as a thread token — the token only ever lives on our reply domain.
    for (const addr of [
      "report-publicworks@city.gov",
      "event-registration@constantcontact.com",
      "reply-mailinglist1@example.com",
    ]) {
      expect(real.extractThreadToken(mailTo(addr))).toBeNull()
      expect(fake.extractThreadToken(mailTo(addr))).toBeNull()
    }
  })

  it("picks the real civfix.org token even when a foreign decoy is the FIRST recipient", () => {
    const token = mintThreadToken()
    const mail = mailTo(["event-registration@constantcontact.com", `report-${token}@civfix.org`])
    expect(real.extractThreadToken(mail)).toBe(token)
    expect(fake.extractThreadToken(mail)).toBe(token)
  })

  it("rejects a prefix that is mid-local-part, not anchored (both adapters)", () => {
    expect(real.extractThreadToken(mailTo("noreply-newsletter@civfix.org"))).toBeNull()
    expect(fake.extractThreadToken(mailTo("noreply-newsletter@civfix.org"))).toBeNull()
  })
})
