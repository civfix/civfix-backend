import { afterEach, describe, expect, it, vi } from "vitest"
import { ErrorCode } from "@civfix/contract"
import { OAuthService, PROVIDER_APPLE, PROVIDER_GOOGLE } from "../../src/auth/oauth.js"
import { InMemoryOAuthIdentityStore, InMemoryUserStore } from "../../src/auth/stores.js"
import type { VerifiedIdToken } from "../../src/auth/jwks.js"
import { makeAuthHarness, StubJwksVerifier, type AuthHarness } from "../helpers/auth.js"
import {
  APPLE_TOKEN_URL,
  GOOGLE_TOKEN_URL,
  OAUTH_CONFIG,
  WEB_ORIGIN,
  appleCallback,
  cookieValue,
  googleCallback,
  html,
  json,
  stubTokenEndpoint,
  type ProviderAnswer,
} from "../helpers/oauth-provider.js"

// Drives the real arctic token exchange against a stubbed provider endpoint, so an arctic major that
// changes the request it sends or the errors it throws shows up here. A provider that is unreachable or
// answers with something other than an OAuth error maps to the same 500 INTERNAL, and no session is
// issued; a refused code is oauth-callback-code-refused.test.ts.

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

async function googleCallbackWith(answer: ProviderAnswer) {
  harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_CONFIG })
  return googleCallback(harness, answer)
}

async function appleCallbackWith(answer: ProviderAnswer) {
  harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN], oauthConfig: OAUTH_CONFIG })
  return appleCallback(harness, answer)
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

  it("T16: a provider 503 with an HTML body is a 500 INTERNAL with no session", async () => {
    const { res, calls } = await appleCallbackWith(html(503, "<html>busy</html>"))
    expect(calls).toHaveLength(1)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe(ErrorCode.INTERNAL)
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })
})
