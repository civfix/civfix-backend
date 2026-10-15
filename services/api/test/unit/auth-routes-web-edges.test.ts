import { describe, it, expect, afterEach } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { resolvePostLoginRedirect } from "../../src/routes/auth.routes.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"

const WEB_ORIGIN = "https://app.civfix.org"
const DAY_MS = 24 * 60 * 60 * 1000

let harness: AuthHarness | undefined

afterEach(async () => {
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

function cookieLines(setCookie: string | string[] | undefined): string[] {
  return Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  for (const line of cookieLines(setCookie)) {
    if (!line.startsWith(`${name}=`)) continue
    const pair = line.split(";")[0]!
    return decodeURIComponent(pair.slice(name.length + 1))
  }
  return null
}

function cookieMaxAge(setCookie: string | string[] | undefined, name: string): number | null {
  for (const line of cookieLines(setCookie)) {
    if (!line.startsWith(`${name}=`)) continue
    const match = /max-age=(\d+)/i.exec(line)
    if (match) return Number(match[1])
  }
  return null
}

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

describe("resolvePostLoginRedirect returns the value it validated", () => {
  const origins = ["https://civfix.org"]

  it("strips surrounding whitespace from an accepted redirect", () => {
    expect(resolvePostLoginRedirect("  /dashboard ", origins)).toBe("/dashboard")
    expect(resolvePostLoginRedirect("\thttps://civfix.org/home\n", origins)).toBe(
      "https://civfix.org/home",
    )
  })
})

describe("GET /auth/session cookie lifetimes", () => {
  it("gives the CSRF cookie the same remaining lifetime as the session cookie", async () => {
    harness = await makeAuthHarness({ startMs: Date.now() - 5 * DAY_MS })
    const email = "csrf.lifetime@example.com"
    await harness.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const code = harness.mailer.lastOtpFor(email)!
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "web" },
      payload: { email, code },
    })
    const session = cookieValue(verify.headers["set-cookie"], "civfix_session")!

    const check = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: `civfix_session=${session}` },
    })
    expect(check.json().authenticated).toBe(true)
    const sessionMaxAge = cookieMaxAge(check.headers["set-cookie"], "civfix_session")
    const csrfMaxAge = cookieMaxAge(check.headers["set-cookie"], "civfix_csrf")
    expect(sessionMaxAge).not.toBeNull()
    expect(sessionMaxAge!).toBeLessThan(harness.services.sessions.ttl)
    expect(csrfMaxAge).toBe(sessionMaxAge)
  })
})

describe("web OAuth callbacks when the user cancels at the provider", () => {
  it("Google: redirects back to the captured target and clears the handshake cookie", async () => {
    harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN] })
    const start = await harness.app.inject({
      method: "GET",
      url: `/auth/google/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    expect(start.statusCode).toBe(302)
    const state = new URL(start.headers.location as string).searchParams.get("state")!
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!

    const res = await harness.app.inject({
      method: "GET",
      url: `/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: `civfix_oauth=${encodeURIComponent(handshake)}` },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/reports/7")
    expect(cookieLines(res.headers["set-cookie"]).some((l) => l.startsWith("civfix_oauth=;"))).toBe(
      true,
    )
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })

  it("Google: a cancel with a foreign state neither honors the stash nor clears it", async () => {
    harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN] })
    const start = await harness.app.inject({
      method: "GET",
      url: `/auth/google/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!

    const res = await harness.app.inject({
      method: "GET",
      url: "/auth/google/callback?error=access_denied&state=someone-elses-state",
      headers: { cookie: `civfix_oauth=${encodeURIComponent(handshake)}` },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(WEB_ORIGIN)
    expect(cookieLines(res.headers["set-cookie"]).some((l) => l.startsWith("civfix_oauth="))).toBe(
      false,
    )
  })

  it("Google: a callback with neither code nor error is still rejected", async () => {
    harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN] })
    const res = await harness.app.inject({ method: "GET", url: "/auth/google/callback?state=x" })
    expect(res.statusCode).toBe(422)
  })

  it("Apple: a form_post cancel redirects back to the captured target", async () => {
    harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_WITH_APPLE_WEB })
    const start = await harness.app.inject({
      method: "GET",
      url: `/auth/apple/start?redirect=${encodeURIComponent("/events")}`,
    })
    expect(start.statusCode).toBe(302)
    const state = new URL(start.headers.location as string).searchParams.get("state")!
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!

    const res = await harness.app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `civfix_oauth=${encodeURIComponent(handshake)}`,
      },
      payload: new URLSearchParams({ error: "user_cancelled_authorize", state }).toString(),
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/events")
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })
})
