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

  function fill(unit: string): string {
    return unit.repeat(Math.floor(INBOUND_HTML_MAX_CHARS / unit.length))
  }

  const payloads: [string, string][] = [
    ["unterminated iframe run", fill("<iframe")],
    ["unterminated iframe tags", fill("<iframe ")],
    ["unterminated script run", fill("<script")],
    ["unterminated script tags", fill("<script ")],
    ["unterminated form tags", fill("<form ")],
    ["mixed unterminated drop tags", fill("<form <iframe <object <svg ")],
    ["balanced form pairs", fill("<form></form>")],
    ["orphan close tags", fill("</form>")],
    ["unterminated comments", fill("<!--")],
    ["bare angle brackets", fill("<")],
  ]

  for (const [name, payload] of payloads) {
    it(`${name} stays under ${BUDGET_MS}ms`, () => {
      expect(payload.length).toBeLessThanOrEqual(INBOUND_HTML_MAX_CHARS)
      const t0 = performance.now()
      const out = sanitizeInboundHtml(payload)
      const elapsed = performance.now() - t0
      expect(out).not.toBeNull()
      expect(out?.toLowerCase()).not.toContain("<iframe")
      expect(out?.toLowerCase()).not.toContain("<script")
      expect(out?.toLowerCase()).not.toContain("<form")
      expect(elapsed).toBeLessThan(BUDGET_MS)
    })
  }

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
