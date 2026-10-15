import { describe, expect, it } from "vitest"
import { sanitizeInboundHtml } from "../../src/services/admin/inbound-html-sanitizer.js"

const RUN = 64 * 1024

describe("inbound HTML link cleanup stays linear on attacker-sized input", () => {
  it("cleans an href with a long interior run of spaces in linear time", () => {
    const html = `<a href="https://x.example/${" ".repeat(RUN)}y">link</a>`
    const started = performance.now()
    const out = sanitizeInboundHtml(html)
    expect(performance.now() - started).toBeLessThan(500)
    expect(out).toContain("link")
  })

  it("still trims control characters and spaces at both ends of an href", () => {
    const out = sanitizeInboundHtml(`<a href="\u0001 https://x.example/a \u0002">link</a>`)
    expect(out).toContain('href="https://x.example/a"')
  })
})
