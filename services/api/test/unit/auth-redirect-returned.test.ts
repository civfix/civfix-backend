import { describe, it, expect, afterEach } from "vitest"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"

const WEB_ORIGIN = "https://app.civfix.org"

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

let harness: AuthHarness | undefined

afterEach(async () => {
  await harness?.app.close()
  harness = undefined
})

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  const lines = Array.isArray(header) ? header : header ? [header] : []
  const line = lines.find((l) => l.startsWith(`${name}=`))
  return line ? decodeURIComponent(line.split(";")[0]!.slice(name.length + 1)) : null
}

function readHandshake(header: string | string[] | undefined): {
  state: string
  redirect?: string
} {
  const unsigned = harness!.app.unsignCookie(cookieValue(header, "civfix_oauth")!)
  expect(unsigned.valid).toBe(true)
  return JSON.parse(unsigned.value!) as { state: string; redirect?: string }
}

// An async handler that drops the reply its redirect sent resolves to undefined, and Fastify then
// sends a second time; every send runs the onSend chain, so the count shows the double send.
async function countingHarness(oauthConfig?: OAuthConfig): Promise<{ onSendRuns: () => number }> {
  harness = await makeAuthHarness({
    webOrigins: [WEB_ORIGIN],
    ...(oauthConfig ? { oauthConfig } : {}),
  })
  let runs = 0
  harness.app.addHook("onSend", async (_request, _reply, payload) => {
    runs += 1
    return payload
  })
  return {
    onSendRuns: () => {
      const n = runs
      runs = 0
      return n
    },
  }
}

describe("the web OAuth start routes", () => {
  it("T23: GET /auth/google/start redirects to the provider and sends once", async () => {
    const { onSendRuns } = await countingHarness()
    const res = await harness!.app.inject({
      method: "GET",
      url: `/auth/google/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    expect(location.origin).toBe("https://accounts.google.com")
    const state = location.searchParams.get("state")
    expect(state).toBeTruthy()
    const handshake = readHandshake(res.headers["set-cookie"])
    expect(handshake.state).toBe(state)
    expect(handshake.redirect).toBe("/reports/7")
    expect(onSendRuns()).toBe(1)
  })

  it("T23: GET /auth/apple/start redirects to the provider and sends once", async () => {
    const { onSendRuns } = await countingHarness(OAUTH_WITH_APPLE_WEB)
    const res = await harness!.app.inject({
      method: "GET",
      url: `/auth/apple/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    expect(location.origin).toBe("https://appleid.apple.com")
    const state = location.searchParams.get("state")
    expect(state).toBeTruthy()
    const handshake = readHandshake(res.headers["set-cookie"])
    expect(handshake.state).toBe(state)
    expect(handshake.redirect).toBe("/reports/7")
    expect(onSendRuns()).toBe(1)
  })
})

describe("the web OAuth callbacks when the user cancels at the provider", () => {
  it("T24: the Google cancel redirects to the captured target and sends once", async () => {
    const { onSendRuns } = await countingHarness()
    const start = await harness!.app.inject({
      method: "GET",
      url: `/auth/google/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    const state = new URL(start.headers.location as string).searchParams.get("state")!
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!
    onSendRuns()

    const res = await harness!.app.inject({
      method: "GET",
      url: `/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: `civfix_oauth=${encodeURIComponent(handshake)}` },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/reports/7")
    expect(onSendRuns()).toBe(1)
  })

  it("T24: the Apple form_post cancel redirects to the captured target and sends once", async () => {
    const { onSendRuns } = await countingHarness(OAUTH_WITH_APPLE_WEB)
    const start = await harness!.app.inject({
      method: "GET",
      url: `/auth/apple/start?redirect=${encodeURIComponent("/events")}`,
    })
    const state = new URL(start.headers.location as string).searchParams.get("state")!
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!
    onSendRuns()

    const res = await harness!.app.inject({
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
    expect(onSendRuns()).toBe(1)
  })
})
