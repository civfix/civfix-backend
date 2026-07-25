import { describe, expect, it } from "vitest"
import { sanitizeInboundHtml } from "../../src/services/admin/inbound-html-sanitizer.js"
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
  it("no catastrophic backtracking on pathological input", () => {
    const t0 = Date.now()
    sanitizeInboundHtml("<" + "a".repeat(50000) + " " + "b=1 ".repeat(20000))
    sanitizeInboundHtml("<a ".repeat(40000))
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
