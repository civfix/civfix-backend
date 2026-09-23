import { describe, it, expect } from "vitest"
import { httpUrlField } from "../../src/routes/admin/_route-utils.js"

// `formUrl` is re-served as an href in the admin console and the public directory. Zod's `.url()` only
// checks that `new URL()` parses, and `javascript:`, `data:` and `vbscript:` all parse: a stored XSS in
// two UIs, and a full authz bypass in the console (the CSRF cookie is JS-readable). The shared schema
// is not edited from this repo, so the scheme allowlist is enforced at the persist boundary.
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
