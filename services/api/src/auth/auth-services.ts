/**
 * The auth service bundle: the single object the auth routes + context hook depend on.
 *
 * Bundling SessionService + OtpService + OAuthService (plus the UserStore used to render UserDTOs)
 * behind one factory is what makes the subsystem testable offline. Production wires Postgres stores +
 * a Redis-backed cache + the real mailer; tests wire the in-memory stores + in-memory cache +
 * FakeMailer and inject the bundle straight into buildServer. Neither path special-cases the other.
 */

import type { Container } from "../di.js"
import type { UserDTO } from "@civfix/shared"
import { RedisCacheClient, type CacheClient } from "./cache.js"
import { SessionService } from "./session-service.js"
import { OtpService } from "./otp.js"
import { OAuthService, type OAuthConfig } from "./oauth.js"
import type { JwksVerifier } from "./jwks.js"
import type { AuthStores, UserRecord, UserStore } from "./stores.js"
import { PgAuthStores } from "./pg-stores.js"

export interface AuthServices {
  sessions: SessionService
  otp: OtpService
  oauth: OAuthService
  users: UserStore
}

export interface BuildAuthServicesOptions {
  stores: AuthStores
  cache: CacheClient
  mailer: import("@civfix/shared/interfaces").Mailer
  oauthConfig: OAuthConfig
  /** Optional JWKS verifier override (tests). Production uses the default remote verifier. */
  verifier?: JwksVerifier
  /** Optional clock override (tests). */
  now?: () => number
}

/** Assemble the auth services from already-constructed seams. Pure wiring; no I/O. */
export function buildAuthServices(opts: BuildAuthServicesOptions): AuthServices {
  const now = opts.now
  const sessions = new SessionService({
    store: opts.stores.sessions,
    cache: opts.cache,
    ...(now ? { now } : {}),
  })
  const otp = new OtpService({
    store: opts.stores.otps,
    users: opts.stores.users,
    cache: opts.cache,
    mailer: opts.mailer,
    ...(now ? { now } : {}),
  })
  const oauth = new OAuthService({
    config: opts.oauthConfig,
    oauthStore: opts.stores.oauth,
    users: opts.stores.users,
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  })
  return { sessions, otp, oauth, users: opts.stores.users }
}

/**
 * Production wiring: build the auth services from the DI container. Uses the real Postgres stores
 * (forcing creation of the lazy DB handle) and the Redis-backed cache (forcing the Redis client),
 * plus the container's selected mailer (real OCI or FakeMailer per USE_FAKE_MAILER).
 */
export function buildAuthServicesFromContainer(container: Container): AuthServices {
  const stores = new PgAuthStores(container.getDb().db)
  const cache = new RedisCacheClient(container.getRedis())
  return buildAuthServices({
    stores,
    cache,
    mailer: container.mailer,
    oauthConfig: oauthConfigFromEnv(container.env),
  })
}

/** Project the OAuth credentials out of env into the OAuthService config (omitting absent providers). */
export function oauthConfigFromEnv(env: Container["env"]): OAuthConfig {
  const config: OAuthConfig = {}
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI) {
    config.google = {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    }
  }
  if (
    env.APPLE_OAUTH_CLIENT_ID &&
    env.APPLE_OAUTH_TEAM_ID &&
    env.APPLE_OAUTH_KEY_ID &&
    env.APPLE_OAUTH_PRIVATE_KEY
  ) {
    config.apple = {
      clientId: env.APPLE_OAUTH_CLIENT_ID,
      teamId: env.APPLE_OAUTH_TEAM_ID,
      keyId: env.APPLE_OAUTH_KEY_ID,
      privateKey: env.APPLE_OAUTH_PRIVATE_KEY,
      // Apple reuses the Google-style redirect under the same public API host when web flow is on.
      redirectUri: `${env.PUBLIC_API_URL}/auth/apple/callback`,
    }
  }
  return config
}

/** Render a user row to the wire DTO. */
export function toUserDTO(user: UserRecord): UserDTO {
  return {
    id: user.id,
    displayName: user.displayName,
    handle: user.handle,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  }
}
