import { describe, it, expect } from "vitest"
import { scrubEvent, scrubBreadcrumb } from "../../src/errors/glitchtip.js"

describe("scrubEvent (GlitchTip PII scrubbing)", () => {
  it("drops the user record entirely", () => {
    const out = scrubEvent({ user: { id: "u1", email: "a@b.com", ip_address: "1.2.3.4" } })
    expect(out.user).toBeUndefined()
  })

  it("strips request headers/cookies/body/query, keeping only method + path", () => {
    const out = scrubEvent({
      request: {
        method: "POST",
        url: "https://api.civfix.org/v1/reports/search?q=secret+text",
        headers: { authorization: "Bearer abc", cookie: "sid=xyz" },
        cookies: { sid: "xyz" },
        data: { description: "free text", lat: 34.05, lng: -118.24 },
        query_string: "q=secret+text",
      },
    })
    expect(out.request).toEqual({ method: "POST", url: "https://api.civfix.org/v1/reports/search" })
    expect(JSON.stringify(out)).not.toContain("authorization")
    expect(JSON.stringify(out)).not.toContain("secret")
    expect(JSON.stringify(out)).not.toContain("34.05")
  })

  it("deep-redacts PII-shaped keys in extra (email, lat/lng, token, description, otp)", () => {
    const out = scrubEvent({
      extra: {
        requestId: "req-1",
        email: "user@example.com",
        lat: 34.0522,
        lng: -118.2437,
        token: "sess_abcdef",
        description: "the pothole on my street",
        otp: "123456",
        nested: { authorization: "Bearer t", harmless: "ok" },
      },
    })
    const extra = out.extra as Record<string, unknown>
    expect(extra.requestId).toBe("req-1")
    expect(extra.email).toBe("[redacted]")
    expect(extra.lat).toBe("[redacted]")
    expect(extra.lng).toBe("[redacted]")
    expect(extra.token).toBe("[redacted]")
    expect(extra.description).toBe("[redacted]")
    expect(extra.otp).toBe("[redacted]")
    expect((extra.nested as Record<string, unknown>).authorization).toBe("[redacted]")
    expect((extra.nested as Record<string, unknown>).harmless).toBe("ok")
  })

  it("drops captured breadcrumbs and does not mutate the input event", () => {
    const input = { breadcrumbs: [{ category: "http" }], extra: { email: "x@y.com" } }
    const out = scrubEvent(input)
    expect(out.breadcrumbs).toBeUndefined()
    expect(input.breadcrumbs).toEqual([{ category: "http" }])
    expect(input.extra.email).toBe("x@y.com")
  })
})

describe("scrubEvent (exception + message redaction)", () => {
  it("redacts an email embedded in an exception value", () => {
    const out = scrubEvent({
      exception: {
        values: [
          {
            type: "error",
            value:
              "duplicate key value violates unique constraint: email=user@example.com already exists",
          },
        ],
      },
    })
    const values = (out.exception as { values: Array<{ value: string }> }).values
    expect(values[0]!.value).not.toContain("user@example.com")
    expect(values[0]!.value).toContain("[redacted]")
  })

  it("redacts an access_token embedded in event.message", () => {
    const out = scrubEvent({
      message: "fetch failed for https://api.mapbox.com/x?access_token=pk.secret123&limit=1",
    })
    expect(out.message).not.toContain("pk.secret123")
    expect(out.message).toContain("access_token=[redacted]")
  })

  it("redacts a Luhn-valid card number in event.message and leaves other long digit runs alone", () => {
    const out = scrubEvent({ message: "charge 4242424242424242 failed; order 1234567890123456789" })
    expect(out.message).not.toContain("4242424242424242")
    expect(out.message).toContain("[redacted]")
    expect(out.message).toContain("1234567890123456789")
  })

  it("does not mutate the input exception (pure)", () => {
    const input = { exception: { values: [{ value: "x@y.com" }] } }
    const out = scrubEvent(input)
    expect((input.exception.values[0] as { value: string }).value).toBe("x@y.com")
    expect(out.exception.values[0]!.value).toBe("[redacted]")
  })
})

describe("scrubBreadcrumb", () => {
  it("drops http/fetch/xhr/query breadcrumbs entirely", () => {
    expect(scrubBreadcrumb({ category: "http", data: { url: "x" } })).toBeNull()
    expect(scrubBreadcrumb({ category: "fetch" })).toBeNull()
    expect(scrubBreadcrumb({ category: "xhr" })).toBeNull()
    expect(scrubBreadcrumb({ category: "db.query" })).toBeNull()
  })

  it("keeps other breadcrumbs but redacts their data", () => {
    const out = scrubBreadcrumb({ category: "log", data: { email: "a@b.com", level: "info" } })
    expect(out).not.toBeNull()
    expect((out!.data as Record<string, unknown>).email).toBe("[redacted]")
    expect((out!.data as Record<string, unknown>).level).toBe("info")
  })
})
