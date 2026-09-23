/**
 * Offline auth test harness.
 *
 * Builds a real Fastify app (via buildServer) but injects an in-memory auth bundle: in-memory stores
 * + in-memory cache + FakeMailer + a stub JWKS verifier. This exercises the full request path
 * (routing, validation, transport selection, CSRF, the context hook, the session service) with NO
 * database and NO Redis, so the whole auth flow runs GREEN locally without Docker.
 */

import type { FastifyInstance } from "fastify"
import type { SessionResponse, UserDTO } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer, type BuildServerOptions } from "../../src/server.js"
import { buildContainer, type Container } from "../../src/di.js"
import { loadEnv, type Env } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import type { JwksVerifier, VerifiedIdToken, VerifyParams } from "../../src/auth/jwks.js"
import type { OAuthConfig } from "../../src/auth/oauth.js"

/** A JWKS verifier stub: maps a fixed set of opaque "tokens" to canned verified claims. */
export class StubJwksVerifier implements JwksVerifier {
  private readonly tokens = new Map<string, VerifiedIdToken>()
  /** Optional per-token bound nonce: when set, verify enforces params.expectedNonce against it (P2-3). */
  private readonly nonces = new Map<string, string>()

  /** Register a token string that should verify to the given claims (optionally bound to a nonce). */
  register(token: string, claims: VerifiedIdToken, boundNonce?: string): void {
    this.tokens.set(token, claims)
    if (boundNonce !== undefined) this.nonces.set(token, boundNonce)
  }

  verify(idToken: string, params: VerifyParams): Promise<VerifiedIdToken> {
    const claims = this.tokens.get(idToken)
    if (!claims) {
      return Promise.reject(new Error("stub verifier: unknown token"))
    }
    // Mirror the real verifier's nonce binding (P2-3): when the caller expects a nonce, it must match the
    // token's bound nonce, else reject. A token with no bound nonce but an expectedNonce is a mismatch.
    if (params.expectedNonce !== undefined) {
      const bound = this.nonces.get(idToken)
      if (bound !== params.expectedNonce) {
        return Promise.reject(new (class extends Error {})("stub verifier: nonce mismatch"))
      }
    }
    return Promise.resolve(claims)
  }
}

/** What a completed OTP sign-in gives a test: the bearer token plus the session's user DTO. */
export interface SignedIn {
  /** Bearer token for `authorization: Bearer <token>` (see `bearer`). */
  token: string
  /** Convenience alias for `user.id`, the field most call sites actually want. */
  userId: string
  user: UserDTO
}

/**
 * Sign a user in through the REAL email-OTP flow against an offline app: request a code, read it out of
 * the FakeMailer, verify it as a mobile client (which returns the bearer token in the body instead of
 * setting cookies). Creates the account on first use, exactly as production first sign-in does.
 *
 * Throws — with the offending status + body — if any leg fails. ~10 unit suites hand-rolled this and all
 * of them non-null-asserted their way past a failure, so a broken sign-in surfaced later as a puzzling
 * 401 on the endpoint actually under test rather than here.
 */
export async function signIn(
  app: FastifyInstance,
  mailer: FakeMailer,
  email: string,
): Promise<SignedIn> {
  const requested = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { email },
  })
  if (requested.statusCode !== 200) {
    throw new Error(`signIn(${email}): otp/request ${requested.statusCode} ${requested.body}`)
  }
  const code = mailer.lastOtpFor(email)
  if (code === null || code === undefined) {
    throw new Error(`signIn(${email}): no OTP was mailed`)
  }
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  if (verified.statusCode !== 200) {
    throw new Error(`signIn(${email}): otp/verify ${verified.statusCode} ${verified.body}`)
  }
  const body = verified.json() as SessionResponse
  if (typeof body.token !== "string" || body.token === "") {
    throw new Error(`signIn(${email}): otp/verify returned no bearer token (${verified.body})`)
  }
  return { token: body.token, userId: body.user.id, user: body.user }
}

/** The bearer header for a signed-in token. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export interface AuthHarness {
  app: FastifyInstance
  mailer: FakeMailer
  cache: InMemoryCacheClient
  stores: ReturnType<typeof makeInMemoryStores>
  services: AuthServices
  verifier: StubJwksVerifier
  /** The env the app + container were built from. */
  env: Env
  /** The DI container the app is running on (the caller's, when one was supplied). */
  container: Container
  /** Current epoch ms used by the injected services; advance with `advance()`. */
  nowMs: { value: number }
  advance(ms: number): void
  /** `signIn(app, mailer, email)` bound to this harness. */
  signIn(email: string): Promise<SignedIn>
}

export interface MakeAuthHarnessOptions {
  /** OAuth credentials to expose (defaults to enabling both providers so token flows are testable). */
  oauthConfig?: OAuthConfig
  /** Starting epoch ms for the injectable clock. */
  startMs?: number
  /** WEB_ORIGINS allowlist to load into env (e.g. to test the OAuth redirect allowlist). */
  webOrigins?: string[]
  /** Enforce the H1 mandatory-nonce gate on native sign-in (OAUTH_REQUIRE_NONCE). Defaults off, as in prod. */
  requireOauthNonce?: boolean
  /**
   * Extra env variables for loadEnv, layered on top of (and able to override) the harness's minimal
   * source — see HARNESS_ENV_SOURCE for what that source is and why the harness never reads process.env.
   */
  env?: Record<string, string>
  /**
   * buildServer options passed straight through: the route-service overrides (`cleanupOverrides`,
   * `notificationOverrides`, `reportOverrides`, ...) plus an optional pre-built `container` when the test
   * needs a handle on a seam (e.g. `container.chatService as FakeChatService`). `env` and `authServices`
   * are owned by the harness and cannot be set here.
   */
  server?: Omit<BuildServerOptions, "env" | "authServices">
}

/**
 * The env every harness app is loaded from. loadEnv REPLACES process.env when given a source, and this
 * source is passed on EVERY path — including `makeAuthHarness()` with no options — so an offline test can
 * never inherit a developer's shell: a real DATABASE_URL, REDIS_URL or set of R2 credentials must not be
 * reachable from a suite that believes it is talking to fakes.
 *
 * The USE_FAKE_* flags are spelled out rather than left to loadEnv's non-production defaults (which also
 * resolve to ON for NODE_ENV=test) so a caller that overrides NODE_ENV to exercise a production-only
 * branch still gets the offline seams instead of loadEnv demanding R2 and SMTP credentials. `opts.env` is
 * layered on top, so any of these can be overridden deliberately.
 */
const HARNESS_ENV_SOURCE: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  USE_FAKE_STORAGE: "1",
  USE_FAKE_MAILER: "1",
  USE_FAKE_PUSH: "1",
  USE_FAKE_ABUSE_NSFW: "1",
  USE_FAKE_CHAT: "1",
  USE_FAKE_JOBS: "1",
  USE_FAKE_USER_CHANNEL: "1",
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
  const notificationRepo = opts.server?.notificationOverrides?.repo
  if (notificationRepo) {
    stores.users.cascadeErasureTo(async (userId) => {
      await notificationRepo.deletePushTokensForUser(userId)
      await notificationRepo.deleteAllNotificationsForUser(userId)
    })
  }
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

  const envSource: Record<string, string> = { ...HARNESS_ENV_SOURCE, ...(opts.env ?? {}) }
  if (opts.webOrigins !== undefined) envSource.WEB_ORIGINS = opts.webOrigins.join(",")
  if (opts.requireOauthNonce === true) envSource.OAUTH_REQUIRE_NONCE = "true"
  // ALWAYS an explicit source (see HARNESS_ENV_SOURCE): loadEnv(undefined) would read process.env, and a
  // developer's DATABASE_URL / REDIS_URL / R2 credentials must never reach an offline app.
  const env = loadEnv(envSource)
  // Built explicitly (rather than left to buildServer) so the caller can reach the container's seams —
  // container.chatService / container.pushSender are the fakes several suites assert against.
  const container = opts.server?.container ?? buildContainer(env)
  const app = await buildServer({ ...opts.server, env, container, authServices: services })

  return {
    app,
    mailer,
    cache,
    stores,
    services,
    verifier,
    env,
    container,
    nowMs,
    advance(ms: number) {
      nowMs.value += ms
    },
    signIn: (email: string) => signIn(app, mailer, email),
  }
}
