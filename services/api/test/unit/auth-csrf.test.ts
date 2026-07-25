import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import { AppError, ErrorCode } from "@civfix/shared"
import { csrfProtect, csrfTokenForSession, CSRF_HEADER } from "../../src/auth/csrf.js"
import { CSRF_COOKIE, SESSION_COOKIE, SESSION_COOKIE_HOST } from "../../src/auth/transport.js"

/** Minimal FastifyRequest stub carrying just the cookies + headers + url csrfProtect reads. */
function req(opts: {
  cookies?: Record<string, string>
  headers?: Record<string, string>
  url?: string
}): FastifyRequest {
  return {
    cookies: opts.cookies ?? {},
    headers: opts.headers ?? {},
    url: opts.url ?? "/v1/reports",
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

const SESSION = "session-token-value"

describe("csrfProtect (session-bound token, L3)", () => {
  it("passes when the header carries the token derived from THIS session", async () => {
    const token = await csrfTokenForSession(SESSION)
    await expect(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: token },
          headers: { [CSRF_HEADER]: token },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("accepts the session cookie under the __Host- name too (rename transition)", async () => {
    const token = await csrfTokenForSession(SESSION)
    await expect(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE_HOST]: SESSION },
          headers: { [CSRF_HEADER]: token },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("REJECTS a matching cookie+header pair that is not bound to the session (the L3 attack)", async () => {
    // Pure double-submit accepted this: anything that can WRITE a cookie for the site (a compromised
    // sibling subdomain) could plant a value and echo it in the header. Binding kills it.
    await expectForbidden(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "planted-by-attacker" },
          headers: { [CSRF_HEADER]: "planted-by-attacker" },
        }),
      ),
    )
  })

  it("REJECTS a token derived from a DIFFERENT session", async () => {
    const otherToken = await csrfTokenForSession("someone-elses-session")
    await expectForbidden(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: otherToken },
          headers: { [CSRF_HEADER]: otherToken },
        }),
      ),
    )
  })

  it("rejects when the header is missing", async () => {
    await expectForbidden(
      csrfProtect(req({ cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "abc" } })),
    )
  })

  it("is EXEMPT for bearer requests (no ambient cookie)", async () => {
    // A bearer request carrying a session cookie too should still be exempt: bearer wins.
    await expect(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "abc" },
          headers: { authorization: "Bearer some-token" },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("is a no-op when there is no session cookie (anonymous request)", async () => {
    await expect(csrfProtect(req({}))).resolves.toBeUndefined()
  })

  it("TRANSITIONAL: the legacy double-submit is accepted ONLY under /v1/admin/", async () => {
    // The operator console still mints unbound tokens (routes/admin/auth.routes.ts). Until it derives
    // them, its requests fall back — and nothing else does.
    await expect(
      csrfProtect(
        req({
          url: "/v1/admin/users/abc/role",
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "legacy" },
          headers: { [CSRF_HEADER]: "legacy" },
        }),
      ),
    ).resolves.toBeUndefined()

    await expectForbidden(
      csrfProtect(
        req({
          url: "/v1/reports",
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "legacy" },
          headers: { [CSRF_HEADER]: "legacy" },
        }),
      ),
    )
  })
})

describe("csrfTokenForSession", () => {
  it("is deterministic per session and unguessable across sessions", async () => {
    const a = await csrfTokenForSession(SESSION)
    const b = await csrfTokenForSession(SESSION)
    const c = await csrfTokenForSession(SESSION + "x")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.length).toBeGreaterThan(20)
    // The session token itself must not be recoverable from (or embedded in) the CSRF value.
    expect(a).not.toContain(SESSION)
  })
})
