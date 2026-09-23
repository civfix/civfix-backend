import { describe, expect, it } from "vitest"
import {
  INBOUND_HTML_MAX_CHARS,
  sanitizeInboundHtml,
} from "../../src/services/admin/inbound-html-sanitizer.js"
const cases: [string, string][] = [
  [
    "underscore div handler",
    '<div_ onmouseover="alert(1)" style="position:fixed;inset:0">hover</div_>',
  ],
  ["underscore autofocus", '<x_y autofocus tabindex=1 onfocus="alert(document.domain)">z</x_y>'],
  ["underscore anchor js:", '<a_ href="javascript:alert(1)">go</a_>'],
  ["underscore img onerror", "<img_ src=x onerror=alert(1)>"],
  ["underscore uppercase", "<A_B ONERROR=alert(1)>text</A_B>"],
  ["digit-suffix tag", "<h1_2 onclick=alert(1)>x</h1_2>"],
  ["dash tag", "<my-el onclick=alert(1)>x</my-el>"],
  ["colon tag", "<a:b onclick=alert(1)>x</a:b>"],
  ["stray lt", "3 < 5 and <div onclick=alert(1)>y</div>"],
  ["truncated tag", "text <div onclick=alert(1)"],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  ["entity js scheme", '<a href="&#106;avascript:alert(1)">x</a>'],
  ["tab js scheme", '<a href="java&#09;script:alert(1)">x</a>'],
  ["nested unclosed script", "<script>alert(1)"],
  ["conditional comment", "<!--[if mso]><script>alert(1)</script><![endif]--><p>ok</p>"],
]
describe("sanitizer bypass attempts", () => {
  for (const [name, input] of cases) {
    it(name, () => {
      const out = sanitizeInboundHtml(input) ?? ""
      if (!out.includes("&lt;")) expect(out.toLowerCase()).not.toMatch(/on\w+\s*=/)
      expect(out).not.toMatch(/<[a-zA-Z][^>]*\son\w+\s*=/i)
      expect(out.toLowerCase()).not.toContain("javascript:")
      expect(out.toLowerCase()).not.toContain("<script")
      expect(out.toLowerCase()).not.toContain("<svg")
      expect(out).not.toMatch(/<[a-zA-Z][^\s/>]*[_:-]/)
      console.log(`  ${name.padEnd(26)} -> ${JSON.stringify(out).slice(0, 90)}`)
    })
  }
  it("PRESERVES a real email body that starts with meta", () => {
    expect(sanitizeInboundHtml('<meta charset="utf-8"><p>real email body</p>')).toBe(
      "<p>real email body</p>",
    )
    expect(sanitizeInboundHtml("<style>a{}</style><meta charset=utf-8><p>hello body</p>")).toBe(
      "<p>hello body</p>",
    )
    expect(
      sanitizeInboundHtml(
        '<html><head><meta http-equiv="x"><link rel="y"></head><body><p>hi</p></body></html>',
      ),
    ).toContain("<p>hi</p>")
  })
  it("F103: an UNCLOSED non-raw-text drop element no longer swallows the rest of the body", () => {
    const out = sanitizeInboundHtml(
      "<p>before the form</p><form action=x><p>the municipality's actual reply</p>",
    )
    expect(out).toContain("before the form")
    expect(out).toContain("the municipality's actual reply")
    expect(out?.toLowerCase()).not.toContain("<form")
  })

  it("F103: a NON-CANONICAL closing tag still closes the swallow instead of running to end-of-document", () => {
    const out = sanitizeInboundHtml(
      '<form action=x><p>hidden</p></form data-x="1"><p>kept after the form</p>',
    )
    expect(out).toContain("kept after the form")
    expect(out).not.toContain("hidden")
  })

  it("F103: unclosed head/iframe drop the tag but keep the surrounding body", () => {
    const head = sanitizeInboundHtml("<head><p>still here</p>")
    expect(head).toContain("still here")
    expect(head?.toLowerCase()).not.toContain("<head")

    const frame = sanitizeInboundHtml("<p>a</p><iframe src=https://evil.example><p>b</p>")
    expect(frame).toContain("a")
    expect(frame).toContain("b")
    expect(frame?.toLowerCase()).not.toContain("<iframe")
  })

  it("F103: raw-text elements STILL swallow to end-of-document when unclosed (browser semantics)", () => {
    const out = sanitizeInboundHtml("<p>before</p><script>alert(1)<p>after</p>")
    expect(out).toContain("before")
    expect(out?.toLowerCase()).not.toContain("alert(1)")
    expect(out).not.toContain("after")
  })

  it("no catastrophic backtracking on pathological input", () => {
    const t0 = Date.now()
    sanitizeInboundHtml("<" + "a".repeat(50000) + " " + "b=1 ".repeat(20000))
    sanitizeInboundHtml("<a ".repeat(40000))
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe("sanitizer is linear at the size cap (H14)", () => {
  const BUDGET_MS = 500
  const LINEAR_TOLERANCE = 4
  const PER_CHAR_NOISE_MS = 0.0005

  function fill(unit: string): string {
    return unit.repeat(Math.floor(INBOUND_HTML_MAX_CHARS / unit.length))
  }

  function repeatChar(c: string, total: number): string {
    return c.repeat(Math.max(0, total))
  }

  const payloads: [string, () => string][] = [
    [
      "allowed tag + attribute name-run",
      () => `<a ${repeatChar("a", INBOUND_HTML_MAX_CHARS - 4)}>`,
    ],
    [
      "allowed tag + unclosed quoted value",
      () => `<a href="${repeatChar("a", INBOUND_HTML_MAX_CHARS - 10)}`,
    ],
    [
      "allowed tag + unquoted value-run",
      () => `<img alt=${repeatChar("a", INBOUND_HTML_MAX_CHARS - 10)}>`,
    ],
    [
      "allowed tag + name-run then href",
      () => `<a ${repeatChar("a", INBOUND_HTML_MAX_CHARS - 30)} href="https://x.test">`,
    ],
    ["unterminated declarations", () => fill("<!")],
    ["unterminated named declarations", () => fill("<!x")],
    ["unterminated iframe run", () => fill("<iframe")],
    ["unterminated iframe tags", () => fill("<iframe ")],
    ["unterminated script run", () => fill("<script")],
    ["unterminated script tags", () => fill("<script ")],
    ["unterminated form tags", () => fill("<form ")],
    ["mixed unterminated drop tags", () => fill("<form <iframe <object <svg ")],
    ["balanced form pairs", () => fill("<form></form>")],
    ["orphan close tags", () => fill("</form>")],
    ["unterminated comments", () => fill("<!--")],
    ["bare angle brackets", () => fill("<")],
  ]

  for (const [name, build] of payloads) {
    it(`${name} is sanitized safely at the size cap`, () => {
      const payload = build()
      expect(payload.length).toBeLessThanOrEqual(INBOUND_HTML_MAX_CHARS)
      const out = sanitizeInboundHtml(payload)
      expect(out).not.toBeNull()
      expect(out?.toLowerCase()).not.toContain("<iframe")
      expect(out?.toLowerCase()).not.toContain("<script")
      expect(out?.toLowerCase()).not.toContain("<form")
      expect(out).not.toMatch(/<[a-zA-Z][^>]*\son\w+\s*=/i)
    })
  }

  function costPerChar(build: (chars: number) => string, chars: number): number {
    const payload = build(chars)
    sanitizeInboundHtml(payload)
    const t0 = performance.now()
    sanitizeInboundHtml(payload)
    return (performance.now() - t0) / chars
  }

  const growthCases: [string, (chars: number) => string][] = [
    ["bare angle brackets", (n) => "<".repeat(n)],
    ["unterminated comments", (n) => "<!--".repeat(Math.floor(n / 4))],
    ["orphan close tags", (n) => "</form>".repeat(Math.floor(n / 7))],
    ["balanced form pairs", (n) => "<form></form>".repeat(Math.floor(n / 13))],
    ["attribute name-run", (n) => `<a ${repeatChar("a", n - 4)}>`],
  ]

  for (const [name, build] of growthCases) {
    it(`${name} costs no more per character as the body grows (no super-linear blowup)`, () => {
      const small = costPerChar(build, INBOUND_HTML_MAX_CHARS / 8)
      const full = costPerChar(build, INBOUND_HTML_MAX_CHARS)
      expect(full).toBeLessThan(small * LINEAR_TOLERANCE + PER_CHAR_NOISE_MS)
    })
  }

  it("B1: a huge attribute slice on an ALLOWED tag never yields an unsafe attribute", () => {
    const run = "a".repeat(64 * 1024)
    const t0 = performance.now()
    const out = sanitizeInboundHtml(`<a ${run} href="javascript:alert(1)" onclick=x>text</a>`) ?? ""
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    expect(out).toBe("<a>text</a>")
  })

  it("B1: a name-run before a real href still yields the href (no attribute is skipped)", () => {
    const run = "a".repeat(32 * 1024)
    const out = sanitizeInboundHtml(`<a ${run} href="https://x.test" title=t>go</a>`) ?? ""
    expect(out).toBe('<a href="https://x.test" title="t">go</a>')
  })

  it("keeps the FIRST occurrence of a duplicated attribute and drops later ones", () => {
    expect(
      sanitizeInboundHtml('<a href="https://first.test" href="https://second.test">x</a>'),
    ).toBe('<a href="https://first.test">x</a>')
    expect(sanitizeInboundHtml('<a title="one" title="two" href="https://ok.test">x</a>')).toBe(
      '<a title="one" href="https://ok.test">x</a>',
    )
    expect(sanitizeInboundHtml('<a href="javascript:alert(1)" href="https://ok.test">x</a>')).toBe(
      "<a>x</a>",
    )
    expect(sanitizeInboundHtml('<img alt="a" alt="b">')).toBe('<img alt="a">')
  })

  it("keeps the spaces in title and alt text", () => {
    expect(sanitizeInboundHtml('<a title="Click here now" href="https://x.test/a">go</a>')).toBe(
      '<a title="Click here now" href="https://x.test/a">go</a>',
    )
    expect(sanitizeInboundHtml('<img alt="City of Los Angeles logo">')).toBe(
      '<img alt="City of Los Angeles logo">',
    )
  })

  it("keeps an href's own spaces so the link still points where the sender meant", () => {
    expect(sanitizeInboundHtml('<a href=" https://x.test/a b ">go</a>')).toBe(
      '<a href="https://x.test/a b">go</a>',
    )
  })

  it("decodes common named entities once instead of double-encoding them", () => {
    expect(sanitizeInboundHtml('<a title="Tom &quot;T&quot; &amp; co">x</a>')).toBe(
      '<a title="Tom &quot;T&quot; &amp; co">x</a>',
    )
    expect(sanitizeInboundHtml('<img alt="a&nbsp;b &lt;c&gt; it&apos;s">')).toBe(
      '<img alt="a\u00a0b &lt;c&gt; it\'s">',
    )
  })

  it("still refuses a script scheme hidden behind spaces, controls or named entities", () => {
    for (const href of [
      "java script:alert(1)",
      " \u0001javascript:alert(1)",
      "java&Tab;script:alert(1)",
      "javascript&colon;alert(1)",
      "&#x6A;ava&#x09;script:alert(1)",
    ]) {
      expect(sanitizeInboundHtml(`<a href="${href}">x</a>`)).toBe("<a>x</a>")
    }
  })

  it("still refuses a body over the size cap", () => {
    expect(sanitizeInboundHtml("a".repeat(INBOUND_HTML_MAX_CHARS + 1))).toBeNull()
  })

  it("a 512 KB body of REAL markup still sanitizes correctly", () => {
    const unit = '<p>hello <a href="https://x.example">link</a><script>alert(1)</script></p>'
    const body = unit.repeat(Math.floor(INBOUND_HTML_MAX_CHARS / unit.length))
    const t0 = performance.now()
    const out = sanitizeInboundHtml(body) ?? ""
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    expect(out.toLowerCase()).not.toContain("<script")
    expect(out).not.toContain("alert(1)")
    expect(out).toContain('<a href="https://x.example">link</a>')
  })
})
