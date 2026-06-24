import { describe, it, expect } from "vitest"
import { OAuthService, PROVIDER_GOOGLE, PROVIDER_APPLE } from "../../src/auth/oauth.js"
import type { JwksVerifier, VerifiedIdToken, VerifyParams } from "../../src/auth/jwks.js"
import { InMemoryOAuthIdentityStore, InMemoryUserStore } from "../../src/auth/stores.js"
import { oauthConfigFromEnv } from "../../src/auth/auth-services.js"
import type { Env } from "../../src/env/types.js"

class StubVerifier implements JwksVerifier {
  private readonly map = new Map<string, VerifiedIdToken>()
  register(token: string, claims: VerifiedIdToken): void {
    this.map.set(token, claims)
  }
  verify(idToken: string, _params: VerifyParams): Promise<VerifiedIdToken> {
    const c = this.map.get(idToken)
    return c ? Promise.resolve(c) : Promise.reject(new Error("unknown token"))
  }
}

function claims(sub: string, email: string | null, name?: string): VerifiedIdToken {
  return { sub, email, emailVerified: true, name: name ?? null, picture: null }
}

/** Verifier that records the params it was called with, so tests can assert the accepted audience set. */
class CapturingVerifier implements JwksVerifier {
  lastParams: VerifyParams | null = null
  constructor(private readonly result: VerifiedIdToken) {}
  verify(_idToken: string, params: VerifyParams): Promise<VerifiedIdToken> {
    this.lastParams = params
    return Promise.resolve(this.result)
  }
}

function makeService() {
  const users = new InMemoryUserStore()
  const oauth = new InMemoryOAuthIdentityStore()
  const verifier = new StubVerifier()
  const service = new OAuthService({
    config: {
      google: {
        clientId: "gid",
        clientSecret: "gsecret",
        redirectUri: "http://localhost/cb",
      },
      apple: {
        clientId: "aid",
        teamId: "team",
        keyId: "key",
        privateKey: "pk",
        redirectUri: "http://localhost/apple/cb",
      },
    },
    oauthStore: oauth,
    users,
    verifier,
  })
  return { service, users, oauth, verifier }
}

describe("OAuthService", () => {
  it("creates a new user + identity on first Google sign-in, reuses on the second", async () => {
    const { service, verifier, users } = makeService()
    verifier.register("g-token", claims("google-sub-1", "person@example.com", "Person One"))

    const u1 = await service.signInWithGoogleIdToken("g-token")
    expect(u1.displayName).toBe("Person One")
    expect(u1.role).toBe("citizen")

    // Second sign-in with the SAME provider subject returns the same user (no duplicate).
    const u2 = await service.signInWithGoogleIdToken("g-token")
    expect(u2.id).toBe(u1.id)
    expect(await users.findById(u1.id)).not.toBeNull()
  })

  it("links a new provider identity to an existing account that owns the email", async () => {
    const { service, verifier, oauth } = makeService()
    // First, an email-only account via Google.
    verifier.register("g1", claims("g-sub", "shared@example.com", "Shared"))
    const viaGoogle = await service.signInWithGoogleIdToken("g1")

    // Now Apple sign-in with a DIFFERENT subject but the SAME verified email links to that account.
    verifier.register("a1", claims("apple-sub", "shared@example.com"))
    const viaApple = await service.signInWithAppleIdToken("a1", undefined)

    expect(viaApple.id).toBe(viaGoogle.id)
    // Both identities now point at the one user.
    const gid = await oauth.findByProvider(PROVIDER_GOOGLE, "g-sub")
    const aid = await oauth.findByProvider(PROVIDER_APPLE, "apple-sub")
    expect(gid?.userId).toBe(viaGoogle.id)
    expect(aid?.userId).toBe(viaGoogle.id)
  })

  it("creates separate users when emails differ", async () => {
    const { service, verifier } = makeService()
    verifier.register("g-a", claims("sub-a", "a@example.com"))
    verifier.register("g-b", claims("sub-b", "b@example.com"))
    const a = await service.signInWithGoogleIdToken("g-a")
    const b = await service.signInWithGoogleIdToken("g-b")
    expect(a.id).not.toBe(b.id)
  })

  it("handles a token with no email (Apple private relay omitted) by creating a user", async () => {
    const { service, verifier } = makeService()
    verifier.register("a-noemail", claims("apple-sub-2", null))
    const u = await service.signInWithAppleIdToken("a-noemail", "Hidden User")
    expect(u.displayName).toBe("Hidden User")
  })

  it("reports providers as enabled when configured", () => {
    const { service } = makeService()
    expect(service.googleEnabled).toBe(true)
    expect(service.appleEnabled).toBe(true)
  })

  it("accepts a native Apple token whose aud is the bundle id via extraAudiences", async () => {
    // clientId is the WEB Services ID; the native bundle id is supplied as an extra audience. The native
    // id_token (aud = bundle id) must still verify — the bundle id is in the accepted audience set.
    const verifier = new CapturingVerifier(claims("apple-native-sub", "native@example.com", "Native User"))
    const service = new OAuthService({
      config: {
        apple: {
          clientId: "org.civfix.web",
          teamId: "team",
          keyId: "key",
          privateKey: "pk",
          redirectUri: "http://localhost/apple/cb",
          extraAudiences: ["org.civfix.community"],
        },
      },
      oauthStore: new InMemoryOAuthIdentityStore(),
      users: new InMemoryUserStore(),
      verifier,
    })

    const user = await service.signInWithAppleIdToken("native-token", undefined)
    expect(user.displayName).toBe("Native User")
    // The bundle id is offered to the verifier alongside the (web) clientId.
    expect(verifier.lastParams?.audiences).toEqual(["org.civfix.web", "org.civfix.community"])
  })
})

describe("oauthConfigFromEnv", () => {
  function envWith(overrides: Partial<Env>): Env {
    return { PUBLIC_API_URL: "https://api.civfix.org", ...overrides } as unknown as Env
  }

  it("maps APPLE_OAUTH_IOS_CLIENT_ID to apple.extraAudiences", () => {
    const config = oauthConfigFromEnv(
      envWith({
        APPLE_OAUTH_CLIENT_ID: "org.civfix.web",
        APPLE_OAUTH_TEAM_ID: "team",
        APPLE_OAUTH_KEY_ID: "key",
        APPLE_OAUTH_PRIVATE_KEY: "pk",
        APPLE_OAUTH_IOS_CLIENT_ID: "org.civfix.community",
      }),
    )
    expect(config.apple?.extraAudiences).toEqual(["org.civfix.community"])
  })

  it("omits apple.extraAudiences when APPLE_OAUTH_IOS_CLIENT_ID is unset", () => {
    const config = oauthConfigFromEnv(
      envWith({
        APPLE_OAUTH_CLIENT_ID: "org.civfix.community",
        APPLE_OAUTH_TEAM_ID: "team",
        APPLE_OAUTH_KEY_ID: "key",
        APPLE_OAUTH_PRIVATE_KEY: "pk",
      }),
    )
    expect(config.apple?.extraAudiences).toBeUndefined()
  })
})
