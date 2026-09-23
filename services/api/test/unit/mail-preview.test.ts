import { describe, expect, it } from "vitest"
import { htmlToText, toPreview, PREVIEW_LEN } from "../../src/services/admin/mail-preview.js"
import { INBOUND_HTML_SOURCE_MAX_CHARS } from "../../src/services/admin/inbound-processor.js"

describe("htmlToText", () => {
  it("drops raw-text element CONTENT, not just the tags", () => {
    expect(htmlToText("<p>a</p><script>alert(1)</script><p>b</p>")).not.toContain("alert(1)")
    expect(htmlToText("<style>a{color:red}</style>hello").trim()).toBe("hello")
  })

  it("drops comments and decodes the entities a reader needs", () => {
    expect(htmlToText("<!-- hidden --><p>x&amp;y</p>")).toContain("x&y")
    expect(htmlToText("<!-- hidden -->")).not.toContain("hidden")
    expect(htmlToText("&lt;p&gt;&nbsp;&quot;q&quot;")).toContain('<p> "q"')
  })

  it("stops at an unterminated tag and at an unclosed raw-text element", () => {
    expect(htmlToText("<p>before</p><script>unclosed")).toContain("before")
    expect(htmlToText("<p>before</p><script>unclosed")).not.toContain("unclosed")
    expect(htmlToText("<p>kept</p><div attr=")).toContain("kept")
  })

  it("keeps ordinary body text with tags replaced by separators", () => {
    expect(htmlToText("<p>hello <b>world</b></p>").replace(/\s+/g, " ").trim()).toBe("hello world")
  })

  it("breaks lines at blocks, marks blockquote lines, decodes numeric entities, keeps http links", () => {
    const html =
      '<div>a&#233;</div><blockquote><p>q1</p>q2</blockquote><p>&#x1F600;&#0;</p>' +
      '<a href="https://x.gov/t?a=1&amp;b=2">ticket</a> <a href="javascript:alert(1)">bad</a>'
    const emoji = String.fromCodePoint(0x1f600, 0xfffd)
    expect(htmlToText(html)).toBe(`a\u00e9\n\n> q1\n> q2\n\n${emoji}\nticket (https://x.gov/t?a=1&b=2) bad`)
  })

  it("keeps the line breaks inside <pre> and collapses them everywhere else", () => {
    expect(htmlToText("a\nb<pre>c\n<b>d</b>\n\ne</pre>f\ng")).toBe("a b\nc\nd\n\ne\nf g")
    expect(htmlToText("<blockquote><pre>q1\r\nq2</pre></blockquote>")).toBe("> q1\n> q2")
  })

  it("toPreview prefers text, falls back to html, and bounds the length", () => {
    expect(toPreview("plain text wins", "<p>html</p>")).toBe("plain text wins")
    expect(toPreview(null, "<p>Crew dispatched to 42 Elm St</p>")).toBe("Crew dispatched to 42 Elm St")
    expect(toPreview("x".repeat(PREVIEW_LEN + 50))).toHaveLength(PREVIEW_LEN)
    expect(toPreview(null, null)).toBe("")
  })
})

describe("htmlToText is linear at the inbound source cap (B3)", () => {
  const BUDGET_MS = 500
  const CAP = INBOUND_HTML_SOURCE_MAX_CHARS

  function fill(unit: string): string {
    return unit.repeat(Math.floor(CAP / unit.length))
  }

  const payloads: [string, string][] = [
    ["unterminated script run", fill("<script")],
    ["terminated script open tags", fill("<script >")],
    ["unterminated style run", fill("<style")],
    ["unterminated comment run", fill("<!--")],
    ["bare angle brackets", fill("<")],
    ["orphan close markers", fill("</")],
    ["ordinary markup", fill("<p>hello <b>world</b></p>")],
    ["script blocks between paragraphs", fill("<p>a</p><script>var x=1;</script>")],
  ]

  for (const [name, payload] of payloads) {
    it(`${name} stays under ${BUDGET_MS}ms`, () => {
      expect(payload.length).toBeLessThanOrEqual(CAP)
      const t0 = performance.now()
      const out = htmlToText(payload)
      const elapsed = performance.now() - t0
      expect(out).not.toContain("<script")
      expect(out).not.toContain("var x=1;")
      expect(elapsed).toBeLessThan(BUDGET_MS)
    })
  }
})
