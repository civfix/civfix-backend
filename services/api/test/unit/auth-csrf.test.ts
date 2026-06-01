import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import { AppError, ErrorCode } from "@civfix/shared"
import { csrfProtect, CSRF_HEADER } from "../../src/auth/csrf.js"
import { CSRF_COOKIE, SESSION_COOKIE } from "../../src/auth/transport.js"

/** Minimal FastifyRequest stub carrying just the cookies + headers csrfProtect reads. */
function req(opts: {
  cookies?: Record<string, string>
  headers?: Record<string, string>
}): FastifyRequest {
  return {
    cookies: opts.cookies ?? {},
    headers: opts.headers ?? {},
  } as unknown as FastifyRequest
}

async function expectForbidden(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(ErrorCode.FORBIDDEN)
    return
  }
  throw new Error("expected csrfProtect to reject with FORBIDDEN")
}

describe("csrfProtect (double-submit)", () => {
  it("passes when the header matches the cookie", async () => {
    const token = "csrf-token-value"
    await expect(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: "sess", [CSRF_COOKIE]: token },
          headers: { [CSRF_HEADER]: token },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("rejects when the header is missing", async () => {
    await expectForbidden(
      csrfProtect(
        req({ cookies: { [SESSION_COOKIE]: "sess", [CSRF_COOKIE]: "abc" } }),
      ),
    )
  })

  it("rejects when the header does not match the cookie", async () => {
    await expectForbidden(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: "sess", [CSRF_COOKIE]: "abc" },
          headers: { [CSRF_HEADER]: "different" },
        }),
      ),
    )
  })

  it("rejects when the CSRF cookie is missing", async () => {
    await expectForbidden(
      csrfProtect(
        req({ cookies: { [SESSION_COOKIE]: "sess" }, headers: { [CSRF_HEADER]: "abc" } }),
      ),
    )
  })

  it("is EXEMPT for bearer requests (no ambient cookie)", async () => {
    // A bearer request carrying a session cookie too should still be exempt: bearer wins.
    await expect(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: "sess", [CSRF_COOKIE]: "abc" },
          headers: { authorization: "Bearer some-token" },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("is a no-op when there is no session cookie (anonymous request)", async () => {
    await expect(csrfProtect(req({}))).resolves.toBeUndefined()
  })
})
