import { describe, it, expect, afterEach } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

/**
 * Full offline sign-in flows through the real Fastify app (app.inject), wired with the in-memory
 * stores + FakeMailer + in-memory cache + a stub JWKS verifier. No DB, no Redis, no Docker. This is
 * the end-to-end proof that auth works.
 */

let harness: AuthHarness | undefined

afterEach(async () => {
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

/** Parse the Set-Cookie header(s) into a name -> value map (value only, attributes dropped). */
function parseCookies(setCookie: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const line of list) {
    const [pair] = line.split(";")
    const eq = pair!.indexOf("=")
    if (eq > 0) out[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1))
  }
  return out
}

describe("auth routes: email OTP, mobile bearer flow", () => {
  it("request -> verify (mobile) -> bearer session -> /auth/session authenticated", async () => {
    harness = await makeAuthHarness()
    const email = "mobile.user@example.com"

    // 1) Request a code.
    const reqRes = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { email },
    })
    expect(reqRes.statusCode).toBe(200)
    expect(reqRes.json()).toMatchObject({ sent: true, resendAfterSec: 60 })

    // 2) Read the code straight from the FakeMailer.
    const code = harness.mailer.lastOtpFor(email)
    expect(code).toMatch(/^\d{6}$/)

    // 3) Verify as a MOBILE client -> token in the body, no cookies.
    const verifyRes = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    expect(verifyRes.statusCode).toBe(200)
    const session = verifyRes.json()
    expect(typeof session.token).toBe("string")
    expect(session.token.length).toBeGreaterThan(20)
    expect(session.user.role).toBe("citizen")
    expect(session.csrfToken).toBeUndefined()
    // Mobile transport sets no session cookie.
    expect(verifyRes.headers["set-cookie"]).toBeUndefined()

    const token: string = session.token

    // 4) GET /auth/session with the bearer token -> authenticated.
    const checkRes = await harness.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(checkRes.statusCode).toBe(200)
    const check = checkRes.json()
    expect(check.authenticated).toBe(true)
    expect(check.user.id).toBe(session.user.id)
    expect(check.roles).toEqual(["citizen"])
  })

  it("an unauthenticated /auth/session reports authenticated:false", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({ method: "GET", url: "/auth/session" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: false, roles: [] })
  })

  it("a wrong OTP code is rejected with 401", async () => {
    harness = await makeAuthHarness()
    const email = "wrong.code@example.com"
    await harness.app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
    const correct = harness.mailer.lastOtpFor(email)!
    const wrong = correct === "000000" ? "111111" : "000000"
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { email, code: wrong },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("validates the request body (bad email -> 422)", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { email: "not-an-email" },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("auth routes: web cookie flow + CSRF + logout", () => {
  it("verify (web) sets httpOnly session cookie + readable CSRF cookie + csrfToken", async () => {
    harness = await makeAuthHarness()
    const email = "web.user@example.com"
    await harness.app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!

    const verifyRes = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    expect(verifyRes.statusCode).toBe(200)
    const body = verifyRes.json()
    // Web transport: no bearer token in the body, csrfToken present.
    expect(body.token).toBeUndefined()
    expect(typeof body.csrfToken).toBe("string")

    const setCookie = verifyRes.headers["set-cookie"]
    const cookies = parseCookies(setCookie)
    expect(cookies.civfix_session).toBeTruthy()
    expect(cookies.civfix_csrf).toBe(body.csrfToken)

    // The session cookie must be httpOnly; the csrf cookie must NOT be (SPA reads it).
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie as string]
    const sessionLine = lines.find((l) => l.startsWith("civfix_session="))!
    const csrfLine = lines.find((l) => l.startsWith("civfix_csrf="))!
    expect(sessionLine.toLowerCase()).toContain("httponly")
    expect(csrfLine.toLowerCase()).not.toContain("httponly")

    // The web session cookie authenticates /auth/session with no bearer token.
    const checkRes = await harness.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}` },
    })
    expect(checkRes.json().authenticated).toBe(true)
  })

  it("logout requires CSRF on the cookie flow and revokes the session", async () => {
    harness = await makeAuthHarness()
    const email = "logout.user@example.com"
    await harness.app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verifyRes = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    const cookies = parseCookies(verifyRes.headers["set-cookie"])
    const csrfToken = verifyRes.json().csrfToken as string
    const cookieHeader = `civfix_session=${cookies.civfix_session}; civfix_csrf=${cookies.civfix_csrf}`

    // Logout WITHOUT the CSRF header -> 403.
    const noCsrf = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    })
    expect(noCsrf.statusCode).toBe(403)

    // Logout WITH the CSRF header -> 200 + session revoked.
    const ok = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })

    // The session no longer authenticates.
    const after = await harness.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}` },
    })
    expect(after.json().authenticated).toBe(false)
  })

  it("logout on the bearer flow needs no CSRF and revokes", async () => {
    harness = await makeAuthHarness()
    const email = "bearer.logout@example.com"
    await harness.app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    const token = verify.json().token as string

    const logout = await harness.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.statusCode).toBe(200)

    const after = await harness.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.json().authenticated).toBe(false)
  })

  it("logout while unauthenticated is 401", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({ method: "POST", url: "/auth/logout" })
    expect(res.statusCode).toBe(401)
  })
})

describe("auth routes: OAuth token (mobile) flows via stubbed verifier", () => {
  it("POST /auth/google verifies the id token and mints a session", async () => {
    harness = await makeAuthHarness()
    harness.verifier.register("google-id-token", {
      sub: "google-sub-xyz",
      email: "oauth.google@example.com",
      emailVerified: true,
      name: "Google Person",
    })

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/google",
      headers: { "x-client": "mobile" },
      payload: { idToken: "google-id-token" },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user.displayName).toBe("Google Person")
    expect(typeof body.token).toBe("string")

    // The minted session authenticates.
    const check = await harness.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { authorization: `Bearer ${body.token}` },
    })
    expect(check.json().authenticated).toBe(true)
  })

  it("POST /auth/apple verifies the identity token and mints a session", async () => {
    harness = await makeAuthHarness()
    harness.verifier.register("apple-id-token", {
      sub: "apple-sub-xyz",
      email: "oauth.apple@example.com",
      emailVerified: true,
      name: null,
    })
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/apple",
      headers: { "x-client": "mobile" },
      payload: { identityToken: "apple-id-token", fullName: "Apple Person" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.displayName).toBe("Apple Person")
  })

  it("an unverifiable token surfaces as an error (not a session)", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "never-registered" },
    })
    // The stub rejects unknown tokens; the error mapper renders a 500 envelope (no session leaked).
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.json().token).toBeUndefined()
  })
})

describe("auth routes: Google web start", () => {
  it("GET /auth/google/start redirects and sets the signed handshake cookie", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({ method: "GET", url: "/auth/google/start" })
    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location).toContain("accounts.google.com")
    // A signed oauth handshake cookie is set.
    const setCookie = res.headers["set-cookie"]
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie as string]
    expect(lines.some((l) => l.startsWith("civfix_oauth="))).toBe(true)
  })
})
