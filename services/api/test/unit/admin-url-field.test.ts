import { describe, it, expect } from "vitest"
import { httpUrlField } from "../../src/routes/admin/_route-utils.js"

/**
 * L7: `formUrl` on jurisdictions + discovery contacts is persisted and re-served as an href in BOTH the
 * admin console and the public jurisdiction directory. The wire schema in @civfix/shared uses Zod's
 * `.url()`, which only asserts `new URL()` PARSES the string — and `javascript:`, `data:` and `vbscript:`
 * all parse. A stored `javascript:` URI is therefore a stored XSS in two UIs, and in the console that is a
 * full authz bypass (the CSRF cookie is JS-readable).
 *
 * The shared schema cannot be edited from this repo, so the scheme allowlist is enforced at the persist
 * boundary. These tests pin that boundary.
 */
describe("L7: httpUrlField scheme allowlist", () => {
  it("accepts http and https", () => {
    expect(httpUrlField("https://lacity.gov/report", "formUrl")).toBe("https://lacity.gov/report")
    expect(httpUrlField("http://lacity.gov/report", "formUrl")).toBe("http://lacity.gov/report")
  })

  it("trims, and treats null / undefined / blank as 'no value' (clearing the field is legitimate)", () => {
    expect(httpUrlField("  https://lacity.gov  ", "formUrl")).toBe("https://lacity.gov")
    expect(httpUrlField(null, "formUrl")).toBeNull()
    expect(httpUrlField(undefined, "formUrl")).toBeNull()
    expect(httpUrlField("   ", "formUrl")).toBeNull()
  })

  it("REJECTS javascript: (the finding) and every other non-http scheme that Zod .url() lets through", () => {
    for (const hostile of [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://lacity.gov/form",
    ]) {
      expect(() => httpUrlField(hostile, "formUrl"), hostile).toThrowError(
        expect.objectContaining({ httpStatus: 422 }),
      )
    }
  })

  it("REJECTS a string that is not a URL at all", () => {
    expect(() => httpUrlField("not a url", "formUrl")).toThrowError(
      expect.objectContaining({ httpStatus: 422 }),
    )
  })
})
