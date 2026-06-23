import { describe, it, expect, afterEach } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { resolvePostLoginRedirect } from "../../src/routes/auth.routes.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"

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
      url: "/v1/auth/otp/request",
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
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    expect(verifyRes.statusCode).toBe(200)
    const session = verifyRes.json()
    expect(typeof session.token).toBe("string")
    expect(session.token.length).toBeGreaterThan(20)
    expect(session.user.role).toBe("citizen")
    // The real users.email column now backs the account, so the DTO carries the verified email.
    expect(session.user.email).toBe(email)
    expect(session.csrfToken).toBeUndefined()
    // Mobile transport sets no session cookie.
    expect(verifyRes.headers["set-cookie"]).toBeUndefined()

    const token: string = session.token

    // 4) GET /auth/session with the bearer token -> authenticated.
    const checkRes = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(checkRes.statusCode).toBe(200)
    const check = checkRes.json()
    expect(check.authenticated).toBe(true)
    expect(check.user.id).toBe(session.user.id)
    expect(check.user.email).toBe(email)
    expect(check.roles).toEqual(["citizen"])
  })

  // The OAuth config used to test the Apple WEB flow: the default harness providers PLUS the Services ID
  // (APPLE_OAUTH_WEB_CLIENT_ID) that the web redirect flow + web Apple button require.
  const OAUTH_WITH_APPLE_WEB: OAuthConfig = {
    google: {
      clientId: "test-google-client",
      clientSecret: "test-google-secret",
      redirectUri: "http://localhost:8080/auth/google/callback",
    },
    apple: {
      clientId: "test-apple-client",
      teamId: "TEAMID",
      keyId: "KEYID",
      privateKey: "unused-in-stubbed-verify",
      redirectUri: "http://localhost:8080/auth/apple/callback",
      webClientId: "org.civfix.web",
    },
  }

  it("an unauthenticated WEB /auth/session omits apple unless the web Services ID is configured", async () => {
    harness = await makeAuthHarness()
    // No x-client header => web transport. The default harness configures the NATIVE Apple flow but NOT the
    // web Services ID, so the web's Apple button (which needs the web redirect flow) is NOT advertised.
    const res = await harness.app.inject({ method: "GET", url: "/v1/auth/session" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.authenticated).toBe(false)
    expect(body.roles).toEqual([])
    expect(body.enabledProviders).toEqual(["google", "email"])
  })

  it("a MOBILE /auth/session advertises apple (the native flow needs no web Services ID)", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { "x-client": "mobile" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabledProviders).toEqual(["apple", "google", "email"])
  })

  it("a WEB /auth/session advertises apple once the web Services ID is configured", async () => {
    harness = await makeAuthHarness({ oauthConfig: OAUTH_WITH_APPLE_WEB })
    const res = await harness.app.inject({ method: "GET", url: "/v1/auth/session" })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabledProviders).toEqual(["apple", "google", "email"])
  })

  it("GET /auth/apple/start redirects to Apple (form_post) with a SameSite=None state cookie", async () => {
    harness = await makeAuthHarness({ oauthConfig: OAUTH_WITH_APPLE_WEB })
    const res = await harness.app.inject({ method: "GET", url: "/auth/apple/start" })
    expect(res.statusCode).toBe(302)
    const location = String(res.headers["location"])
    expect(location).toContain("appleid.apple.com")
    expect(location).toContain("response_type=code")
    // Apple REQUIRES form_post whenever scopes are requested; Arctic omits it, so the route adds it.
    expect(location).toContain("response_mode=form_post")
    // The state cookie must be SameSite=None so it survives Apple's cross-site form POST to the callback.
    const setCookie = res.headers["set-cookie"]
    const rawCookie = (Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie)).toLowerCase()
    expect(rawCookie).toContain("samesite=none")
  })

  it("GET /auth/apple/start is rejected when the web Services ID is not configured", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({ method: "GET", url: "/auth/apple/start" })
    // Native-only Apple config => the web flow is unavailable; /start surfaces a clean 4xx, not a 5xx.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })

  it("a wrong OTP code is rejected with 401", async () => {
    harness = await makeAuthHarness()
    const email = "wrong.code@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const correct = harness.mailer.lastOtpFor(email)!
    const wrong = correct === "000000" ? "111111" : "000000"
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      payload: { email, code: wrong },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("validates the request body (bad email -> 422)", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: "not-an-email" },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("auth routes: web cookie flow + CSRF + logout", () => {
  it("verify (web) sets httpOnly session cookie + readable CSRF cookie + csrfToken", async () => {
    harness = await makeAuthHarness()
    const email = "web.user@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!

    const verifyRes = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
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
      url: "/v1/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}` },
    })
    expect(checkRes.json().authenticated).toBe(true)
  })

  it("GET /auth/session returns csrfToken for the WEB cookie flow, echoing the CSRF cookie", async () => {
    harness = await makeAuthHarness()
    const email = "csrf.web@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    const cookies = parseCookies(verify.headers["set-cookie"])

    // A cookie-authenticated session check surfaces the SAME csrfToken as the readable CSRF cookie, so
    // the SPA can recover it after a reload/redirect.
    const check = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}; civfix_csrf=${cookies.civfix_csrf}` },
    })
    expect(check.json().authenticated).toBe(true)
    expect(check.json().csrfToken).toBe(cookies.civfix_csrf)
  })

  it("GET /auth/session MINTS a csrfToken (+ cookie) for a cookie session missing the CSRF cookie", async () => {
    harness = await makeAuthHarness()
    const email = "csrf.recover@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    const cookies = parseCookies(verify.headers["set-cookie"])

    // Present ONLY the session cookie (CSRF cookie lost, e.g. after an OAuth redirect): the check both
    // returns a csrfToken and sets a matching readable CSRF cookie.
    const check = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}` },
    })
    const minted = check.json().csrfToken as string
    expect(typeof minted).toBe("string")
    const setCookies = parseCookies(check.headers["set-cookie"])
    expect(setCookies.civfix_csrf).toBe(minted)
  })

  it("GET /auth/session OMITS csrfToken for the bearer (mobile) flow", async () => {
    harness = await makeAuthHarness()
    const email = "csrf.bearer@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    const token = verify.json().token as string

    const check = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(check.json().authenticated).toBe(true)
    expect(check.json().csrfToken).toBeUndefined()
  })

  it("logout requires CSRF on the cookie flow and revokes the session", async () => {
    harness = await makeAuthHarness()
    const email = "logout.user@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verifyRes = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    const cookies = parseCookies(verifyRes.headers["set-cookie"])
    const csrfToken = verifyRes.json().csrfToken as string
    const cookieHeader = `civfix_session=${cookies.civfix_session}; civfix_csrf=${cookies.civfix_csrf}`

    // Logout WITHOUT the CSRF header -> 403.
    const noCsrf = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: cookieHeader },
    })
    expect(noCsrf.statusCode).toBe(403)

    // Logout WITH the CSRF header -> 200 + session revoked.
    const ok = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfToken },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })

    // The session no longer authenticates.
    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: `civfix_session=${cookies.civfix_session}` },
    })
    expect(after.json().authenticated).toBe(false)
  })

  it("logout on the bearer flow needs no CSRF and revokes", async () => {
    harness = await makeAuthHarness()
    const email = "bearer.logout@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    const token = verify.json().token as string

    const logout = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(logout.statusCode).toBe(200)

    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.json().authenticated).toBe(false)
  })

  it("logout while unauthenticated is 401", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({ method: "POST", url: "/v1/auth/logout" })
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
      picture: null,
    })

    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/google",
      headers: { "x-client": "mobile" },
      payload: { idToken: "google-id-token" },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user.displayName).toBe("Google Person")
    expect(typeof body.token).toBe("string")
    // A brand-new OAuth account is profileComplete:false, exactly like a fresh OTP signup, so the clients'
    // first-run gate (which triggers ONLY on an explicit `false`) fires for Google/Apple signups too.
    expect(body.user.profileComplete).toBe(false)

    // The minted session authenticates.
    const check = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
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
      picture: null,
    })
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/apple",
      headers: { "x-client": "mobile" },
      payload: { identityToken: "apple-id-token", fullName: "Apple Person" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.displayName).toBe("Apple Person")
    // Brand-new Apple account is profileComplete:false (parity with the OTP + Google signup paths).
    expect(res.json().user.profileComplete).toBe(false)
  })

  it("an unverifiable token surfaces as an error (not a session)", async () => {
    harness = await makeAuthHarness()
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/google",
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

describe("auth routes: OAuth redirect allowlist (P2-2 open-redirect guard)", () => {
  it("accepts a relative internal path and an allowlisted absolute origin", async () => {
    harness = await makeAuthHarness({ webOrigins: ["https://app.civfix.org"] })
    const rel = await harness.app.inject({
      method: "GET",
      url: "/auth/google/start?redirect=%2Fdashboard",
    })
    expect(rel.statusCode).toBe(302)

    const abs = await harness.app.inject({
      method: "GET",
      url: "/auth/google/start?redirect=" + encodeURIComponent("https://app.civfix.org/back"),
    })
    expect(abs.statusCode).toBe(302)
  })

  it("REJECTS a foreign-origin redirect and a protocol-relative // redirect with 422", async () => {
    harness = await makeAuthHarness({ webOrigins: ["https://app.civfix.org"] })
    const evil = await harness.app.inject({
      method: "GET",
      url: "/auth/google/start?redirect=" + encodeURIComponent("https://evil.example.com/phish"),
    })
    expect(evil.statusCode).toBe(422)

    const protoRel = await harness.app.inject({
      method: "GET",
      url: "/auth/google/start?redirect=" + encodeURIComponent("//evil.example.com"),
    })
    expect(protoRel.statusCode).toBe(422)
  })
})

describe("resolvePostLoginRedirect (web OAuth callback target)", () => {
  const origins = ["https://civfix.org", "https://www.civfix.org"]

  it("honors an allowlisted absolute redirect", () => {
    expect(resolvePostLoginRedirect("https://civfix.org/home", origins)).toBe("https://civfix.org/home")
  })

  it("honors a safe relative redirect", () => {
    expect(resolvePostLoginRedirect("/dashboard", origins)).toBe("/dashboard")
  })

  it("falls back to the first web origin when no redirect was captured", () => {
    expect(resolvePostLoginRedirect(undefined, origins)).toBe("https://civfix.org")
  })

  it("falls back to the first web origin for a disallowed redirect (never an open redirect)", () => {
    expect(resolvePostLoginRedirect("https://evil.example.com", origins)).toBe("https://civfix.org")
    expect(resolvePostLoginRedirect("//evil.example.com", origins)).toBe("https://civfix.org")
  })

  it("falls back to the site root when there are no web origins", () => {
    expect(resolvePostLoginRedirect(undefined, [])).toBe("/")
  })
})

describe("auth routes: Apple nonce binding (P2-3)", () => {
  it("binds the nonce through the route: matching nonce signs in, mismatched nonce is rejected", async () => {
    harness = await makeAuthHarness()
    // Register a token bound to nonce "abc123" (the verifier enforces params.expectedNonce against it).
    harness.verifier.register(
      "apple-nonce-token",
      { sub: "apple-nonce-sub", email: "nonce@example.com", emailVerified: true, name: null, picture: null },
      "abc123",
    )

    // Correct nonce -> the route threads body.nonce -> service -> verifier; sign-in succeeds.
    const ok = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/apple",
      headers: { "x-client": "mobile" },
      payload: { identityToken: "apple-nonce-token", nonce: "abc123", fullName: "Nonce User" },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().user.displayName).toBe("Nonce User")

    // WRONG nonce -> the bind fails -> no session is issued (error envelope, no token leaked).
    const bad = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/apple",
      headers: { "x-client": "mobile" },
      payload: { identityToken: "apple-nonce-token", nonce: "WRONG", fullName: "Nonce User" },
    })
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)
    expect(bad.json().token).toBeUndefined()
  })

  it("a no-nonce Apple sign-in still works (backward compatible)", async () => {
    harness = await makeAuthHarness()
    harness.verifier.register("apple-plain", {
      sub: "apple-plain-sub",
      email: "plain@example.com",
      emailVerified: true,
      name: null,
      picture: null,
    })
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/apple",
      headers: { "x-client": "mobile" },
      payload: { identityToken: "apple-plain", fullName: "Plain User" },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe("auth routes: first-run registration (handle availability + PUT /me/profile)", () => {
  /** Sign in a fresh email via the mobile OTP flow (bearer; no CSRF) -> token + session user. */
  async function signIn(
    h: AuthHarness,
    email: string,
  ): Promise<{ token: string; user: { profileComplete: boolean; handle: string | null } }> {
    await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = h.mailer.lastOtpFor(email)!
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code },
    })
    return res.json() as { token: string; user: { profileComplete: boolean; handle: string | null } }
  }

  it("a fresh account is profileComplete:false with a generated placeholder handle (the gate trigger)", async () => {
    harness = await makeAuthHarness()
    const { user } = await signIn(harness, "newbie@example.com")
    // The gate trigger is profileComplete:false (NOT a null handle). The handle column is NOT NULL now, so a
    // brand-new account carries a generated placeholder ('user' + 12 lowercase hex) until first-run picks one.
    expect(user.profileComplete).toBe(false)
    expect(user.handle).toMatch(/^user[0-9a-f]{12}$/)
  })

  it("GET /me/handle-available reports free / invalid / unauthorized", async () => {
    harness = await makeAuthHarness()
    const { token } = await signIn(harness, "checker@example.com")
    const headers = { authorization: `Bearer ${token}` }

    const free = await harness.app.inject({ method: "GET", url: "/v1/me/handle-available?handle=ana_99", headers })
    expect(free.statusCode).toBe(200)
    expect(free.json()).toEqual({ available: true, reason: null })

    const invalid = await harness.app.inject({ method: "GET", url: "/v1/me/handle-available?handle=ab", headers })
    expect(invalid.json()).toEqual({ available: false, reason: "invalid" })

    const anon = await harness.app.inject({ method: "GET", url: "/v1/me/handle-available?handle=ana_99" })
    expect(anon.statusCode).toBe(401)
  })

  it("PUT /me/profile sets the username + name and completes the profile", async () => {
    harness = await makeAuthHarness()
    const { token } = await signIn(harness, "register@example.com")
    const headers = { authorization: `Bearer ${token}`, "x-client": "mobile" }

    const res = await harness.app.inject({
      method: "PUT",
      url: "/v1/me/profile",
      headers,
      payload: { handle: "ana_99", displayName: "Ana Rivera" },
    })
    expect(res.statusCode).toBe(200)
    const user = res.json().user
    expect(user.handle).toBe("ana_99")
    expect(user.displayName).toBe("Ana Rivera")
    expect(user.profileComplete).toBe(true)

    // The session now reflects the completed profile.
    const check = await harness.app.inject({ method: "GET", url: "/v1/auth/session", headers })
    expect(check.json().user.profileComplete).toBe(true)
    expect(check.json().user.handle).toBe("ana_99")
  })

  it("rejects a username already taken by another user with 409", async () => {
    harness = await makeAuthHarness()
    const a = await signIn(harness, "first@example.com")
    const b = await signIn(harness, "second@example.com")

    const claim = await harness.app.inject({
      method: "PUT",
      url: "/v1/me/profile",
      headers: { authorization: `Bearer ${a.token}`, "x-client": "mobile" },
      payload: { handle: "rivera", displayName: "A" },
    })
    expect(claim.statusCode).toBe(200)

    const avail = await harness.app.inject({
      method: "GET",
      url: "/v1/me/handle-available?handle=rivera",
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(avail.json()).toEqual({ available: false, reason: "taken" })

    const conflict = await harness.app.inject({
      method: "PUT",
      url: "/v1/me/profile",
      headers: { authorization: `Bearer ${b.token}`, "x-client": "mobile" },
      payload: { handle: "rivera", displayName: "B" },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe("CONFLICT")
  })

  it("validates the handle format (bad handle -> 422)", async () => {
    harness = await makeAuthHarness()
    const { token } = await signIn(harness, "badhandle@example.com")
    const res = await harness.app.inject({
      method: "PUT",
      url: "/v1/me/profile",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { handle: "no spaces!", displayName: "X" },
    })
    expect(res.statusCode).toBe(422)
  })
})
