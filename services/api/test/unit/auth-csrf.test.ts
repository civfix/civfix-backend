import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import { AppError, ErrorCode } from "@civfix/shared"
import { makeCsrf, CSRF_HEADER } from "../../src/auth/csrf.js"
import { CSRF_COOKIE, SESSION_COOKIE, SESSION_COOKIE_HOST } from "../../src/auth/transport.js"

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

// The injected env is the seam under test: both halves come off one instance, as di.ts builds one per
// container.
const { protect: csrfProtect, tokenForSession: csrfTokenForSession } = makeCsrf({
  SESSION_SIGNING_KEY: "unit-test-session-signing-key",
})

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

  it("has NO legacy double-submit fallback, not even under /v1/admin/", async () => {
    // The transitional fallback accepted a plain cookie==header pair for the whole operator API, so any
    // cookie-writing sibling origin (or an XSS on any *.civfix.org host) could plant a pair and forge an
    // operator mutation. It is deleted: admin sign-in mints session-BOUND tokens like the citizen surface
    // (routes/admin/auth.routes.ts), so the admin path is held to the same check as everything else.
    await expectForbidden(
      csrfProtect(
        req({
          url: "/v1/admin/users/abc/role",
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: "legacy" },
          headers: { [CSRF_HEADER]: "legacy" },
        }),
      ),
    )

    const token = await csrfTokenForSession(SESSION)
    await expect(
      csrfProtect(
        req({
          url: "/v1/admin/users/abc/role",
          cookies: { [SESSION_COOKIE]: SESSION, [CSRF_COOKIE]: token },
          headers: { [CSRF_HEADER]: token },
        }),
      ),
    ).resolves.toBeUndefined()
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
    expect(a).not.toContain(SESSION)
  })

  it("both halves key off the INJECTED env, so a foreign instance's token never verifies (C1)", async () => {
    // This is the failure the DI seam exists to prevent: minting under one env while verifying under
    // another. If either half reached for a module-global instead of its injected env, the cross-instance
    // token below would verify (same key) and the same-instance token would be the only thing rejected.
    const other = makeCsrf({ SESSION_SIGNING_KEY: "a-different-signing-key" })
    const foreign = await other.tokenForSession(SESSION)
    const mine = await csrfTokenForSession(SESSION)
    expect(foreign).not.toBe(mine)

    await expectForbidden(
      csrfProtect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION },
          headers: { [CSRF_HEADER]: foreign },
        }),
      ),
    )
    await expect(
      other.protect(
        req({
          cookies: { [SESSION_COOKIE]: SESSION },
          headers: { [CSRF_HEADER]: foreign },
        }),
      ),
    ).resolves.toBeUndefined()
  })
})
