import { describe, expect, it } from "vitest"
import type { ParsedMail } from "@civfix/shared/interfaces"
import {
  CfInboundMail,
  domainsAligned,
  readMailAuthVerdict,
} from "../../src/adapters/inbound-mail.cf.js"
import { sanitizeInboundHtml } from "../../src/services/admin/inbound-html-sanitizer.js"

/**
 * M7 — forged inbound email could impersonate a jurisdiction: there was NO message authentication at
 * all, and a spoofable `X-Thread-Token` HEADER selected the thread. M6 — untrusted `bodyHtml` was
 * stored and served verbatim to the admin console.
 */

function mail(over: Partial<ParsedMail> = {}): ParsedMail {
  return {
    from: { address: "clerk@lacity.gov" },
    to: [{ address: "reply-abcdefgh1234@civfix.org" }],
    subject: null,
    text: null,
    html: null,
    messageId: null,
    inReplyTo: null,
    headers: {},
    ...over,
  }
}

describe("readMailAuthVerdict (M7)", () => {
  it("returns 'unknown' when the MTA stamped no Authentication-Results header (FAIL CLOSED)", () => {
    expect(readMailAuthVerdict(mail())).toBe("unknown")
    expect(readMailAuthVerdict(mail({ headers: { "authentication-results": "  " } }))).toBe("unknown")
  })

  it("passes a DMARC-aligned message", () => {
    const m = mail({
      headers: { "authentication-results": "mx.civfix.org; spf=pass; dkim=pass; dmarc=pass" },
    })
    expect(readMailAuthVerdict(m)).toBe("pass")
  })

  it("fails a DMARC fail even when SPF passes (SPF authenticates the envelope, not the From header)", () => {
    const m = mail({
      headers: { "authentication-results": "mx.civfix.org; spf=pass; dmarc=fail" },
    })
    expect(readMailAuthVerdict(m)).toBe("fail")
  })

  it("does not let an appended relay verdict override our MTA's (first token wins)", () => {
    const m = mail({
      headers: { "authentication-results": "mx.civfix.org; dmarc=fail, attacker.example; dmarc=pass" },
    })
    expect(readMailAuthVerdict(m)).toBe("fail")
  })

  it("accepts DKIM only when the signing domain is ALIGNED with the visible From domain", () => {
    const aligned = mail({
      from: { address: "clerk@lacity.gov" },
      headers: { "authentication-results": "mx.civfix.org; dkim=pass header.d=mail.lacity.gov" },
    })
    expect(readMailAuthVerdict(aligned)).toBe("pass")

    const unaligned = mail({
      from: { address: "clerk@lacity.gov" },
      headers: { "authentication-results": "mx.civfix.org; dkim=pass header.d=attacker.example" },
    })
    expect(readMailAuthVerdict(unaligned)).toBe("fail")
  })

  it("rejects a lookalike domain as aligned (suffix match is dot-anchored)", () => {
    expect(domainsAligned("mail.city.gov", "city.gov")).toBe(true)
    expect(domainsAligned("city.gov", "city.gov")).toBe(true)
    expect(domainsAligned("evilcity.gov", "city.gov")).toBe(false)
  })
})

describe("CfInboundMail.extractThreadToken (M7)", () => {
  const adapter = new CfInboundMail({ replyDomain: "civfix.org" })

  it("IGNORES the spoofable X-Thread-Token header", () => {
    const m = mail({
      to: [{ address: "clerk@lacity.gov" }],
      headers: { "x-thread-token": "abcdefgh1234" },
    })
    expect(adapter.extractThreadToken(m)).toBeNull()
  })

  it("still recovers a token from a typed recipient on OUR reply domain", () => {
    expect(adapter.extractThreadToken(mail())).toBe("abcdefgh1234")
  })

  it("ignores a lookalike reply address on a foreign domain", () => {
    const m = mail({ to: [{ address: "reply-abcdefgh1234@civfix.org.attacker.example" }] })
    expect(adapter.extractThreadToken(m)).toBeNull()
  })
})

describe("sanitizeInboundHtml (M6)", () => {
  it("removes <script> together with its contents", () => {
    const out = sanitizeInboundHtml("<p>hi</p><script>alert(document.cookie)</script>")
    expect(out).toBe("<p>hi</p>")
    expect(out).not.toContain("alert")
  })

  it("removes an UNCLOSED dangerous element and everything after it", () => {
    expect(sanitizeInboundHtml("<p>a</p><script>steal()")).toBe("<p>a</p>")
  })

  it("drops event handlers and style attributes but keeps the element", () => {
    const out = sanitizeInboundHtml('<p onclick="steal()" style="position:fixed">text</p>')
    expect(out).toBe("<p>text</p>")
  })

  it("drops javascript: hrefs, including entity-obfuscated ones", () => {
    expect(sanitizeInboundHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>")
    expect(sanitizeInboundHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe("<a>x</a>")
    expect(sanitizeInboundHtml('<a href="java&#09;script:alert(1)">x</a>')).toBe("<a>x</a>")
    expect(sanitizeInboundHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe("<a>x</a>")
  })

  it("keeps a safe http/mailto href", () => {
    expect(sanitizeInboundHtml('<a href="https://city.gov/x" onclick="y()">c</a>')).toBe(
      '<a href="https://city.gov/x">c</a>',
    )
    expect(sanitizeInboundHtml('<a href="mailto:clerk@city.gov">m</a>')).toBe(
      '<a href="mailto:clerk@city.gov">m</a>',
    )
  })

  it("unwraps a non-allowlisted tag but preserves its text", () => {
    expect(sanitizeInboundHtml("<table><tr><td>cell</td></tr></table>")).toBe("cell")
  })

  it("drops <img src> (tracking pixel) while keeping alt text", () => {
    expect(sanitizeInboundHtml('<img src="https://tracker.example/p.gif" alt="logo">')).toBe(
      '<img alt="logo">',
    )
  })

  it("strips comments, including the conditional-comment script-smuggling trick", () => {
    expect(sanitizeInboundHtml("<!--[if mso]><script>x()</script><![endif]--><p>ok</p>")).toBe(
      "<p>ok</p>",
    )
  })

  it("removes svg/iframe/object wholesale", () => {
    expect(sanitizeInboundHtml('<svg><script>x()</script></svg><p>ok</p>')).toBe("<p>ok</p>")
    expect(sanitizeInboundHtml('<iframe src="//evil"></iframe><p>ok</p>')).toBe("<p>ok</p>")
  })

  it("returns null for empty/absent input", () => {
    expect(sanitizeInboundHtml(null)).toBeNull()
    expect(sanitizeInboundHtml(undefined)).toBeNull()
    expect(sanitizeInboundHtml("")).toBeNull()
  })
})
