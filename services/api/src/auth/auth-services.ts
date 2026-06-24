/**
 * The auth service bundle: the single object the auth routes + context hook depend on.
 *
 * Bundling SessionService + OtpService + OAuthService (plus the UserStore used to render UserDTOs)
 * behind one factory is what makes the subsystem testable offline. Production wires Postgres stores +
 * a Redis-backed cache + the real mailer; tests wire the in-memory stores + in-memory cache +
 * FakeMailer and inject the bundle straight into buildServer. Neither path special-cases the other.
 */

import type { Container } from "../di.js"
import type { OAuthProvider, UserDTO } from "@civfix/shared"
import { RedisCacheClient, type CacheClient } from "./cache.js"
import { SessionService } from "./session-service.js"
import {
  OtpService,
  REVIEWER_OTP_CODE,
  REVIEWER_OTP_EMAIL,
  type OtpLogger,
  type ReviewerOtpConfig,
} from "./otp.js"
import { OAuthService, type OAuthConfig } from "./oauth.js"
import type { JwksVerifier } from "./jwks.js"
import { handleChangeableAtFrom, type AuthStores, type UserRecord, type UserStore } from "./stores.js"
import { PgAuthStores } from "./pg-stores.js"
import { resolveLocale } from "../i18n/locales.js"

export interface AuthServices {
  sessions: SessionService
  otp: OtpService
  oauth: OAuthService
  users: UserStore
  /**
   * Sign-in providers the server has configured, surfaced on /auth/session so the web can show only
   * the buttons that will work. Derived best-effort from the OAuth config (apple/google) plus email,
   * which is always available (OTP). Order is stable: apple, google, email.
   */
  enabledProviders: OAuthProvider[]
}

/**
 * Derive the enabled sign-in providers from the OAuth config. `email` (OTP) is always available;
 * `apple`/`google` are included only when their credentials are present. Best-effort and non-breaking.
 */
export function enabledProvidersFromConfig(config: OAuthConfig): OAuthProvider[] {
  const providers: OAuthProvider[] = []
  if (config.apple) providers.push("apple")
  if (config.google) providers.push("google")
  providers.push("email")
  return providers
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
  /** Optional logger (the pino instance); wired in production so the OTP service can warn. */
  logger?: OtpLogger
  /** Reviewer-OTP bypass config; omit to disable (the offline/test default). */
  reviewer?: ReviewerOtpConfig
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
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
  })
  const oauth = new OAuthService({
    config: opts.oauthConfig,
    oauthStore: opts.stores.oauth,
    users: opts.stores.users,
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  })
  return {
    sessions,
    otp,
    oauth,
    users: opts.stores.users,
    enabledProviders: enabledProvidersFromConfig(opts.oauthConfig),
  }
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
    // Reviewer-OTP bypass is ON unless explicitly disabled (REVIEWER_OTP_BYPASS=false).
    ...(container.env.REVIEWER_OTP_BYPASS !== false
      ? { reviewer: { email: REVIEWER_OTP_EMAIL, code: REVIEWER_OTP_CODE } }
      : {}),
  })
}

/** Project the OAuth credentials out of env into the OAuthService config (omitting absent providers). */
export function oauthConfigFromEnv(env: Container["env"]): OAuthConfig {
  const config: OAuthConfig = {}
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI) {
    // The native mobile SDK can present a token whose audience is the iOS or Android OAuth client id
    // (separate Google clients from the web one). Accept those alongside the web client id.
    const extraAudiences = [
      env.GOOGLE_OAUTH_IOS_CLIENT_ID,
      env.GOOGLE_OAUTH_ANDROID_CLIENT_ID,
    ].filter((id): id is string => typeof id === "string" && id.length > 0)
    config.google = {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      ...(extraAudiences.length > 0 ? { extraAudiences } : {}),
    }
  }
  if (
    env.APPLE_OAUTH_CLIENT_ID &&
    env.APPLE_OAUTH_TEAM_ID &&
    env.APPLE_OAUTH_KEY_ID &&
    env.APPLE_OAUTH_PRIVATE_KEY
  ) {
    // The native iOS Apple id_token's aud is the app bundle id (APPLE_OAUTH_IOS_CLIENT_ID, e.g.
    // org.civfix.community). Accept it alongside clientId so native sign-in verifies even when clientId is
    // set to the WEB Services ID (org.civfix.web) — mirrors the Google iOS/Android extraAudiences above.
    const appleExtraAudiences = [env.APPLE_OAUTH_IOS_CLIENT_ID].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
    config.apple = {
      clientId: env.APPLE_OAUTH_CLIENT_ID,
      teamId: env.APPLE_OAUTH_TEAM_ID,
      keyId: env.APPLE_OAUTH_KEY_ID,
      privateKey: env.APPLE_OAUTH_PRIVATE_KEY,
      // Apple reuses the Google-style redirect under the same public API host when web flow is on.
      redirectUri: `${env.PUBLIC_API_URL}/auth/apple/callback`,
      // The Services ID (web client id). When present the web redirect flow + web button light up; when
      // absent only the native/mobile token flow works. Reuses the same team/key/.p8 as above.
      ...(env.APPLE_OAUTH_WEB_CLIENT_ID
        ? { webClientId: env.APPLE_OAUTH_WEB_CLIENT_ID }
        : {}),
      ...(appleExtraAudiences.length > 0 ? { extraAudiences: appleExtraAudiences } : {}),
    }
  }
  return config
}

/**
 * Render a user row to the wire DTO. The UUID `id` is carried as a HIDDEN internal key (cache/follow/DM);
 * the user-facing identifier is `handle`. `handleChangeableAt` is the ISO timestamp the user may next
 * change their @handle (null = changeable now), derived from handle_changed_at + 30 days. `now` is
 * injectable so tests can drive that cooldown clock deterministically.
 *
 * This is the SINGLE serializer every sign-in path renders the user through (OTP verify, Apple, Google,
 * the Google web callback, and GET /auth/session), so the first-run gate flag is computed in exactly one
 * place and can never diverge between providers. The clients' first-run gate triggers ONLY on an explicit
 * `profileComplete === false`, so we coerce the stored column to a definite boolean here: a brand-new
 * account (OTP or OAuth) is created with profile_complete=false and MUST serialize as `false` (not
 * undefined), or the OAuth signups would silently skip the "finish setting up your account" step the OTP
 * signups get.
 */
export function toUserDTO(user: UserRecord, now: Date = new Date()): UserDTO {
  const base: UserDTO = {
    id: user.id,
    displayName: user.displayName,
    handle: user.handle,
    handleChangeableAt: handleChangeableAtFrom(user.handleChangedAt, now),
    email: user.email,
    avatarUrl: user.avatarUrl,
    profileComplete: user.profileComplete === true,
    allowDirectMessages: user.allowDirectMessages,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  }
  // Attach the user's chosen UI/message locale (clamped to a supported code {en,es,de,ko}) so a fresh
  // authed client seeds its UI from the server source of truth. Attached via a structural widen — not an
  // inline literal — so this compiles whether or not the currently-installed @civfix/shared `UserDTO`
  // carries `locale` yet (the shared contract step adds it; this stays forward-compatible against an
  // older pinned dist that would otherwise reject `locale` as an excess property).
  ;(base as UserDTO & { locale: string }).locale = resolveLocale(user.locale)
  return base
}
