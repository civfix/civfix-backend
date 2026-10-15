import { describe, expect, it } from "vitest"
import type { ParsedMail } from "@civfix/shared/interfaces"
import {
  CfInboundMail,
  CLOUDFLARE_AUTHSERV_ID,
  domainsAligned,
  readMailAuthVerdict,
} from "../../src/adapters/inbound-mail.cf.js"
import { sanitizeInboundHtml } from "../../src/services/admin/inbound-html-sanitizer.js"
import { isJurisdictionSender } from "../../src/services/admin/inbound-thread-correlation.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"

/**
 * Forged inbound email could impersonate a jurisdiction: there was NO message authentication at all,
 * and a spoofable `X-Thread-Token` HEADER selected the thread. Untrusted `bodyHtml` was also stored and
 * served verbatim to the admin console.
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
  const cf = (...resinfos: string[]) => ["mx.cloudflare.net", ...resinfos].join("; ")
  const verdict = (header: string, from = "clerk@lacity.gov") =>
    readMailAuthVerdict(
      mail({ from: { address: from }, headers: { "authentication-results": header } }),
    )
  const stamp = (
    helo: string,
    mailFrom: string,
    dmarc = "dmarc=none header.from=lacity.gov policy.dmarc=none",
  ) =>
    cf(
      "dkim=none",
      dmarc,
      `spf=none (mx.cloudflare.net: no SPF records found for postmaster@${helo}) smtp.helo=${helo}`,
      `spf=pass (mx.cloudflare.net: domain of ${mailFrom} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${mailFrom}`,
      'arc=none smtp.remote-ip="2001:db8::1"',
    )

  it("returns 'unknown' when the MTA stamped no Authentication-Results header (FAIL CLOSED)", () => {
    expect(readMailAuthVerdict(mail())).toBe("unknown")
    expect(readMailAuthVerdict(mail({ headers: { "authentication-results": "  " } }))).toBe(
      "unknown",
    )
    expect(verdict(cf("none"))).toBe("unknown")
  })

  it("returns 'unknown' when the header was not stamped by Cloudflare's MX", () => {
    expect(CLOUDFLARE_AUTHSERV_ID).toBe("mx.cloudflare.net")
    expect(verdict("mx.civfix.org; dmarc=pass header.from=lacity.gov")).toBe("unknown")
    expect(verdict("attacker.example; spf=pass; dkim=pass header.d=lacity.gov; dmarc=pass")).toBe(
      "unknown",
    )
  })

  it("passes a DMARC pass evaluated on the parsed From domain", () => {
    expect(
      verdict(cf("spf=pass", "dkim=pass header.d=lacity.gov", "dmarc=pass header.from=lacity.gov")),
    ).toBe("pass")
  })

  it("fails a DMARC pass that was evaluated on a different From domain", () => {
    expect(verdict(cf("dmarc=pass header.from=attacker.example"))).toBe("fail")
  })

  it("fails a DMARC fail even when SPF passes (SPF authenticates the envelope, not the From header)", () => {
    expect(
      verdict(cf("dmarc=fail header.from=lacity.gov", "spf=pass smtp.mailfrom=clerk@lacity.gov")),
    ).toBe("fail")
  })

  it("keeps an enforced DMARC failure a failure even with an aligned DKIM pass", () => {
    for (const result of ["fail", "quarantine", "reject"]) {
      expect(
        verdict(cf("dkim=pass header.d=lacity.gov", `dmarc=${result} header.from=lacity.gov`)),
      ).toBe("fail")
    }
  })

  it("passes dmarc=none on an aligned DKIM pass (Cloudflare's real header shape)", () => {
    const header = cf(
      "dkim=pass header.d=lacity.gov header.s=sig1 header.b=AbCd1234",
      "dmarc=none header.from=lacity.gov policy.dmarc=none",
      "spf=none (mx.cloudflare.net: no SPF records found for postmaster@relay.example) smtp.helo=relay.example",
      "spf=softfail (mx.cloudflare.net: domain of transitioning bounce@esp.example) smtp.mailfrom=bounce@esp.example",
      "arc=none smtp.remote-ip=192.0.2.1",
    )
    expect(verdict(header)).toBe("pass")
  })

  it("checks EVERY DKIM pass for alignment, not only the first", () => {
    const header = cf(
      "dkim=pass header.d=tenant.onmicrosoft.com",
      "dkim=pass header.i=@mail.lacity.gov",
      "dmarc=none header.from=lacity.gov",
    )
    expect(verdict(header)).toBe("pass")
  })

  it("falls back to an aligned SPF pass when there is no DMARC policy", () => {
    for (const dmarc of [
      "dmarc=none header.from=lacity.gov",
      "dmarc=temperror",
      "dmarc=permerror",
    ]) {
      expect(verdict(cf(dmarc, "spf=pass smtp.mailfrom=clerk@lacity.gov"))).toBe("pass")
    }
    expect(verdict(cf("spf=pass smtp.mailfrom=clerk@lacity.gov"))).toBe("pass")
    expect(
      verdict(cf("spf=pass smtp.mailfrom=clerk@lacity.gov", "arc=none smtp.remote-ip=192.0.2.1")),
    ).toBe("pass")
  })

  it("counts SPF only for a lone address-shaped smtp.mailfrom followed by nothing but Cloudflare's arc result", () => {
    expect(verdict(cf("spf=pass smtp.mailfrom=lacity.gov"))).toBe("fail")
    expect(
      verdict(
        cf("spf=pass smtp.mailfrom=clerk@lacity.gov", "arc=none smtp.remote-ip=x@lacity.gov"),
      ),
    ).toBe("fail")
    expect(verdict(cf("spf=pass smtp.mailfrom=clerk@lacity.gov", "dkim=none"))).toBe("fail")
  })

  it("fails an echoed envelope sender that spills into another result or property", () => {
    const echoed = [
      "lacity.gov;@evil.example",
      "x@lacity.gov;@evil.example",
      "lacity.gov @evil.example",
      "lacity.gov;x=y@evil.example",
      "x@lacity.gov a.b=y@evil.example",
      "x@lacity.gov;arc=none a.b=y@evil.example",
      "x@lacity.gov;dkim=pass header.i=y@evil.example",
    ]
    for (const mailFrom of echoed) {
      expect(verdict(stamp("relay.evil.example", mailFrom))).toBe("fail")
    }
  })

  it("fails dmarc=none when neither DKIM nor SPF is aligned with the From domain", () => {
    const header = cf(
      "dkim=pass header.d=attacker.example",
      "dmarc=none header.from=lacity.gov",
      "spf=pass smtp.mailfrom=bounce@attacker.example",
    )
    expect(verdict(header)).toBe("fail")
  })

  it("reads only each result's leading method=result, never comments, quoted text or properties", () => {
    expect(
      verdict(
        cf("spf=fail (dmarc=pass header.from=lacity.gov)", "dmarc=none header.from=lacity.gov"),
      ),
    ).toBe("fail")
    expect(
      verdict(
        cf('dmarc=none reason="dmarc=pass; dkim=pass header.d=lacity.gov" policy.dmarc=pass'),
      ),
    ).toBe("fail")
  })

  it("does not let a later DMARC result override the first one", () => {
    expect(
      verdict(
        cf(
          "dmarc=fail header.from=lacity.gov, attacker.example",
          "dmarc=pass header.from=lacity.gov",
        ),
      ),
    ).toBe("fail")
  })

  it("passes only an SPF pass whose envelope domain is aligned", () => {
    expect(verdict(stamp("mail.lacity.gov", "clerk@lacity.gov"))).toBe("pass")
    expect(verdict(stamp("relay.attacker.example", "a@attacker.example"))).toBe("fail")
  })

  it("fails a mailfrom local part that closes the SPF comment early", () => {
    const forged = ["a)smtp.mailfrom=lacity.gov(b", "a);dkim=pass header.d=lacity.gov;(b"]
    for (const local of [...forged.map((f) => `"${f}"`), ...forged]) {
      expect(verdict(stamp("relay.attacker.example", `${local}@attacker.example`))).toBe("fail")
    }
  })

  it("ignores results that a ';' in the echoed helo appends, with or without a DMARC result", () => {
    const forged = [
      "dkim=pass header.d=lacity.gov",
      "spf=pass smtp.mailfrom=lacity.gov",
      "dmarc=pass header.from=lacity.gov",
    ]
    for (const result of forged) {
      expect(verdict(stamp(`relay.example;${result}`, "a@attacker.example"))).toBe("fail")
      expect(verdict(stamp(`relay.example;${result}`, "a@attacker.example", "dkim=none"))).toBe(
        "fail",
      )
    }
  })

  it("fails a backslash, a nested or unbalanced comment, a repeated property, and DKIM after DMARC", () => {
    for (const tail of ["(a\\) b)", "(a (b) c)", "(a", "header.d=attacker.example"]) {
      const dkim = `dkim=pass header.d=lacity.gov ${tail}`
      expect(verdict(cf(dkim, "dmarc=none header.from=lacity.gov"))).toBe("fail")
    }
    expect(verdict(cf("dmarc=none header.from=lacity.gov", "dkim=pass header.d=lacity.gov"))).toBe(
      "fail",
    )
  })

  it("fails a Cloudflare-stamped message with no single From address", () => {
    const header = cf("dmarc=pass header.from=lacity.gov")
    expect(
      readMailAuthVerdict(mail({ from: null, headers: { "authentication-results": header } })),
    ).toBe("fail")
  })

  it("aligns on the organizational domain, never on a public suffix or a lookalike", () => {
    expect(domainsAligned("mail.city.gov", "city.gov")).toBe(true)
    expect(domainsAligned("city.gov", "city.gov")).toBe(true)
    expect(domainsAligned("bss.lacity.org", "ita.lacity.org")).toBe(true)
    expect(domainsAligned("evilcity.gov", "city.gov")).toBe(false)
    expect(domainsAligned("evil.org", "org")).toBe(false)
    expect(domainsAligned("org", "lacity.org")).toBe(false)
    expect(domainsAligned("evil.co.uk", "council.co.uk")).toBe(false)
    expect(domainsAligned("lacity.gov;x", "lacity.gov")).toBe(false)
  })

  it("fails a public-suffix From domain that the sender's own domain would suffix-match", () => {
    const noPolicy = "dmarc=none header.from=org policy.dmarc=none"
    expect(verdict(cf("dkim=pass header.d=evil.org", noPolicy), "x@org")).toBe("fail")
    expect(verdict(cf("dkim=none", noPolicy, "spf=pass smtp.mailfrom=a@evil.org"), "x@org")).toBe(
      "fail",
    )
    expect(
      verdict(cf("dkim=pass header.d=evil.co.uk", "dmarc=none header.from=co.uk"), "x@co.uk"),
    ).toBe("fail")
  })
})

describe("isJurisdictionSender", () => {
  it("matches the contact on file by organizational domain, never by a bare public suffix", async () => {
    const mailRepo = new InMemoryMailRepository()
    const thread = mailRepo.seedThread({ threadToken: "abcdefgh1234" })
    mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      toAddr: "publicworks@lacity.org",
    })
    const sentBy = (address: string) =>
      isJurisdictionSender(mailRepo, thread.id, mail({ from: { address } }))
    expect(await sentBy("x@org")).toBe(false)
    expect(await sentBy("clerk@evil.org")).toBe(false)
    expect(await sentBy("clerk@lacity.org")).toBe(true)
    expect(await sentBy("clerk@bss.lacity.org")).toBe(true)
  })
})

describe("CfInboundMail.parse: the headers the verdict trusts", () => {
  const adapter = new CfInboundMail({ replyDomain: "civfix.org" })
  const eml = (...headers: string[]) =>
    new TextEncoder().encode(
      [...headers, "To: report-abcdefgh1234@civfix.org", "", "Crew dispatched."].join("\r\n"),
    )

  it("trusts only the top-most Authentication-Results, ignoring a forged copy below it", async () => {
    const parsed = await adapter.parse(
      eml(
        "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=none header.from=lacity.gov",
        "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=lacity.gov",
        "From: Clerk <clerk@lacity.gov>",
      ),
    )
    expect(parsed.from?.address).toBe("clerk@lacity.gov")
    expect(readMailAuthVerdict(parsed)).toBe("fail")
  })

  it("fails a stamp that a leading continuation line in the sender's headers extends", async () => {
    const stamp =
      "mx.cloudflare.net; dkim=none; dmarc=none header.from=lacity.gov; spf=pass smtp.mailfrom=a@x.example"
    for (const injected of [
      "dkim=pass header.d=lacity.gov",
      "spf=pass smtp.mailfrom=clerk@lacity.gov",
    ]) {
      const parsed = await adapter.parse(
        eml(`Authentication-Results: ${stamp}`, ` ; ${injected}`, "From: clerk@lacity.gov"),
      )
      expect(parsed.headers["authentication-results"]).toContain(injected)
      expect(readMailAuthVerdict(parsed)).toBe("fail")
    }
  })

  it("returns no From for a message with two From headers or two From addresses", async () => {
    const auth =
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=attacker.example"
    const twoHeaders = await adapter.parse(
      eml(auth, "From: x@attacker.example", "From: clerk@lacity.gov"),
    )
    expect(twoHeaders.from).toBeNull()
    expect(readMailAuthVerdict(twoHeaders)).toBe("fail")

    const twoAddresses = await adapter.parse(
      eml(auth, "From: clerk@lacity.gov, x@attacker.example"),
    )
    expect(twoAddresses.from).toBeNull()
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

  it("matches the reply address case-insensitively and returns the token lowercased", () => {
    const m = mail({ to: [{ address: "REPORT-ABCDEFGH1234@CivFix.org" }] })
    expect(adapter.extractThreadToken(m)).toBe("abcdefgh1234")
  })

  it("recovers a token from Cc when To carries none", () => {
    const tokenFromCc = (cc: string) =>
      adapter.extractThreadToken(mail({ to: [{ address: "clerk@lacity.gov" }], headers: { cc } }))
    expect(tokenFromCc('"Some, Name" <report-abcdefgh1234@civfix.org>, other@x.com')).toBe(
      "abcdefgh1234",
    )
    expect(tokenFromCc("xreport-abcdefgh1234@civfix.org")).toBeNull()
    expect(tokenFromCc("report-abcdefgh1234@civfix.org.attacker.example")).toBeNull()
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
    expect(sanitizeInboundHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe(
      "<a>x</a>",
    )
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
    expect(sanitizeInboundHtml("<svg><script>x()</script></svg><p>ok</p>")).toBe("<p>ok</p>")
    expect(sanitizeInboundHtml('<iframe src="//evil"></iframe><p>ok</p>')).toBe("<p>ok</p>")
  })

  it("returns null for empty/absent input", () => {
    expect(sanitizeInboundHtml(null)).toBeNull()
    expect(sanitizeInboundHtml(undefined)).toBeNull()
    expect(sanitizeInboundHtml("")).toBeNull()
  })
})
