/**
 * Offline auth test harness.
 *
 * Builds a real Fastify app (via buildServer) but injects an in-memory auth bundle: in-memory stores
 * + in-memory cache + FakeMailer + a stub JWKS verifier. This exercises the full request path
 * (routing, validation, transport selection, CSRF, the context hook, the session service) with NO
 * database and NO Redis, so the whole auth flow runs GREEN locally without Docker.
 */

import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import type { JwksVerifier, VerifiedIdToken, VerifyParams } from "../../src/auth/jwks.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"

/** A JWKS verifier stub: maps a fixed set of opaque "tokens" to canned verified claims. */
export class StubJwksVerifier implements JwksVerifier {
  private readonly tokens = new Map<string, VerifiedIdToken>()

  /** Register a token string that should verify to the given claims. */
  register(token: string, claims: VerifiedIdToken): void {
    this.tokens.set(token, claims)
  }

  verify(idToken: string, _params: VerifyParams): Promise<VerifiedIdToken> {
    const claims = this.tokens.get(idToken)
    if (!claims) {
      return Promise.reject(new Error("stub verifier: unknown token"))
    }
    return Promise.resolve(claims)
  }
}

export interface AuthHarness {
  app: FastifyInstance
  mailer: FakeMailer
  cache: InMemoryCacheClient
  stores: ReturnType<typeof makeInMemoryStores>
  services: AuthServices
  verifier: StubJwksVerifier
  /** Current epoch ms used by the injected services; advance with `advance()`. */
  nowMs: { value: number }
  advance(ms: number): void
}

export interface MakeAuthHarnessOptions {
  /** OAuth credentials to expose (defaults to enabling both providers so token flows are testable). */
  oauthConfig?: OAuthConfig
  /** Starting epoch ms for the injectable clock. */
  startMs?: number
}

const DEFAULT_OAUTH_CONFIG: OAuthConfig = {
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
  },
}

/** Build the offline auth harness. Remember to `await harness.app.close()` in afterEach. */
export async function makeAuthHarness(opts: MakeAuthHarnessOptions = {}): Promise<AuthHarness> {
  const nowMs = { value: opts.startMs ?? Date.now() }
  const now = (): number => nowMs.value

  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(now)
  const mailer = new FakeMailer()
  const verifier = new StubJwksVerifier()

  const services = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: opts.oauthConfig ?? DEFAULT_OAUTH_CONFIG,
    verifier,
    now,
  })

  const app = await buildServer({ env: loadEnv(), authServices: services })

  return {
    app,
    mailer,
    cache,
    stores,
    services,
    verifier,
    nowMs,
    advance(ms: number) {
      nowMs.value += ms
    },
  }
}
