import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ErrorCode } from "@civfix/contract"
import { OAuthService, PROVIDER_APPLE, PROVIDER_GOOGLE } from "../../src/auth/oauth.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"
import { InMemoryOAuthIdentityStore, InMemoryUserStore } from "../../src/auth/stores.js"
import type { VerifiedIdToken } from "../../src/auth/jwks.js"
import { makeAuthHarness, StubJwksVerifier, type AuthHarness } from "../helpers/auth.js"

// Drives the real arctic token exchange against a stubbed provider endpoint, so an arctic major that
// changes the request it sends or the errors it throws shows up here. Every provider failure maps to the
// same 500 INTERNAL as before, and no session is issued.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token"
const WEB_ORIGIN = "https://app.civfix.org"

const APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()

const OAUTH_CONFIG: OAuthConfig = {
  google: {
    clientId: "test-google-client",
    clientSecret: "test-google-secret",
    redirectUri: "http://localhost:8080/auth/google/callback",
  },
  apple: {
    clientId: "test-apple-client",
    teamId: "TEAMID",
    keyId: "KEYID",
    privateKey: APPLE_PRIVATE_KEY,
    redirectUri: "http://localhost:8080/auth/apple/callback",
    webClientId: "org.civfix.web",
  },
}

interface TokenCall {
  url: string
  method: string
  body: URLSearchParams
}

type ProviderAnswer = { status: number; body: string; contentType: string } | Error

function json(status: number, body: unknown): ProviderAnswer {
  return { status, body: JSON.stringify(body), contentType: "application/json" }
}

function html(status: number, body: string): ProviderAnswer {
  return { status, body, contentType: "text/html" }
}

function stubTokenEndpoint(expectedUrl: string, answer: ProviderAnswer): TokenCall[] {
  const calls: TokenCall[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url !== expectedUrl) throw new Error(`unexpected fetch to ${request.url}`)
    calls.push({
      url: request.url,
      method: request.method,
      body: new URLSearchParams(await request.text()),
    })
    if (answer instanceof Error) throw answer
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": answer.contentType },
    })
  })
  return calls
}

function claims(sub: string, email: string | null = null): VerifiedIdToken {
  return { sub, email, emailVerified: email !== null, name: null, picture: null }
}

function makeService() {
  const users = new InMemoryUserStore()
  const oauthStore = new InMemoryOAuthIdentityStore()
  const verifier = new StubJwksVerifier()
  const service = new OAuthService({ config: OAUTH_CONFIG, oauthStore, users, verifier })
  return { service, oauthStore, verifier }
}

let harness: AuthHarness | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const line of lines) {
    if (!line.startsWith(`${name}=`)) continue
    return decodeURIComponent(line.split(";")[0]!.slice(name.length + 1))
  }
  return null
}

async function startHandshake(
  h: AuthHarness,
  provider: "google" | "apple",
): Promise<{ state: string; cookie: string }> {
  const start = await h.app.inject({ method: "GET", url: `/auth/${provider}/start` })
  expect(start.statusCode).toBe(302)
  const state = new URL(start.headers.location as string).searchParams.get("state")!
  const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!
  return { state, cookie: `civfix_oauth=${encodeURIComponent(handshake)}` }
}

async function googleCallbackWith(answer: ProviderAnswer) {
  harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_CONFIG })
  const { state, cookie } = await startHandshake(harness, "google")
  const calls = stubTokenEndpoint(GOOGLE_TOKEN_URL, answer)
  const res = await harness.app.inject({
    method: "GET",
    url: `/auth/google/callback?code=bad-code&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  })
  return { res, calls }
}

async function appleCallbackWith(answer: ProviderAnswer) {
  harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_CONFIG })
  const { state, cookie } = await startHandshake(harness, "apple")
  const calls = stubTokenEndpoint(APPLE_TOKEN_URL, answer)
  const res = await harness.app.inject({
    method: "POST",
    url: "/auth/apple/callback",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    payload: new URLSearchParams({ code: "bad-code", state }).toString(),
  })
  return { res, calls }
}

describe("Google code exchange", () => {
  it("T10: a successful exchange signs in the identity the id token names", async () => {
    const { service, oauthStore, verifier } = makeService()
    verifier.register("g-id", claims("g-sub", "g@example.com"))
    const calls = stubTokenEndpoint(
      GOOGLE_TOKEN_URL,
      json(200, { access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: "g-id" }),
    )
    const verifierString = "v".repeat(43)

    const user = await service.completeGoogleCallback("good-code", verifierString)

    const identity = await oauthStore.findByProvider(PROVIDER_GOOGLE, "g-sub")
    expect(identity?.userId).toBe(user.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.body.get("code")).toBe("good-code")
    expect(calls[0]!.body.get("code_verifier")).toBe(verifierString)
  })

  it("T11: a bad code (400 invalid_grant) is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await googleCallbackWith(
      json(400, { error: "invalid_grant", error_description: "Bad Request" }),
    )
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })

  it("T12: a provider 503 with an HTML body is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await googleCallbackWith(html(503, "<html>busy</html>"))
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })

  it("T13: a network failure is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await googleCallbackWith(new TypeError("fetch failed"))
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })
})

describe("Apple code exchange", () => {
  it("T14: a successful exchange signs in the identity the id token names", async () => {
    const { service, oauthStore, verifier } = makeService()
    verifier.register("a-id", claims("a-sub"))
    const calls = stubTokenEndpoint(
      APPLE_TOKEN_URL,
      json(200, { access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: "a-id" }),
    )

    const user = await service.completeAppleCallback("good-code")

    const identity = await oauthStore.findByProvider(PROVIDER_APPLE, "a-sub")
    expect(identity?.userId).toBe(user.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.get("code")).toBe("good-code")
  })

  it("T15: a bad code (400 invalid_grant) is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await appleCallbackWith(json(400, { error: "invalid_grant" }))
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })

  it("T16: a provider 503 with an HTML body is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await appleCallbackWith(html(503, "<html>busy</html>"))
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })
})
