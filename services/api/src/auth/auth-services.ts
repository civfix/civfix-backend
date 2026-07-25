
import type { Container } from "../di.js"
import type { OAuthProvider, UserDTO } from "@civfix/shared"
import { RedisCacheClient, type CacheClient } from "./cache.js"
import { SessionService } from "./session-service.js"
import {
  OtpService,
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
  cache: CacheClient
  enabledProviders: OAuthProvider[]
}

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
  verifier?: JwksVerifier
  now?: () => number
  logger?: OtpLogger
  reviewer?: ReviewerOtpConfig
}

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
    cache: opts.cache,
    enabledProviders: enabledProvidersFromConfig(opts.oauthConfig),
  }
}

export function buildAuthServicesFromContainer(container: Container): AuthServices {
  const stores = new PgAuthStores(container.getDb().db)
  const cache = new RedisCacheClient(container.getRedis())
  const reviewerConfig = reviewerOtpConfigFromEnv(container.env)
  return buildAuthServices({
    stores,
    cache,
    mailer: container.mailer,
    oauthConfig: oauthConfigFromEnv(container.env),
    ...(reviewerConfig !== null ? { reviewer: reviewerConfig } : {}),
  })
}

/**
 * Minimum length of an environment-supplied reviewer code. The reviewer credential is a full sign-in to
 * a real account, so it must be a secret of session-token calibre, not a memorable string: anything short
 * enough to type from memory is short enough to grind through the (deliberately generous) OTP verify
 * rate limits. 20 characters of the base64url alphabet is >100 bits.
 */
export const REVIEWER_OTP_MIN_CODE_LENGTH = 20

/**
 * Decide whether to wire the reviewer-OTP bypass, from the environment ONLY (C1).
 *
 * Two independent things must BOTH be true, and the failure mode of either is "no bypass at all":
 *   1. REVIEWER_OTP_BYPASS is EXPLICITLY true. The old wiring tested `!== false`, so an unset, empty,
 *      misspelled or otherwise unparsed value left a production authentication bypass switched ON.
 *   2. REVIEWER_OTP_CODE is supplied by the environment and long enough to be a real secret. There is
 *      no default and no source constant to fall back to, so a deployment that forgets the code gets a
 *      disabled bypass rather than a guessable one.
 *
 * The env value is read defensively (the loaded Env type may not declare it yet) precisely because the
 * safe answer to "not present" is to disable the feature.
 */
export function reviewerOtpConfigFromEnv(env: Container["env"]): ReviewerOtpConfig | null {
  if (env.REVIEWER_OTP_BYPASS !== true) return null
  const code = (env as { REVIEWER_OTP_CODE?: string }).REVIEWER_OTP_CODE
  if (typeof code !== "string") return null
  const trimmed = code.trim()
  if (trimmed.length < REVIEWER_OTP_MIN_CODE_LENGTH) return null
  return { email: REVIEWER_OTP_EMAIL, code: trimmed }
}

export function oauthConfigFromEnv(env: Container["env"]): OAuthConfig {
  const config: OAuthConfig = {}
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI) {
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
    const appleExtraAudiences = [env.APPLE_OAUTH_IOS_CLIENT_ID].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
    config.apple = {
      clientId: env.APPLE_OAUTH_CLIENT_ID,
      teamId: env.APPLE_OAUTH_TEAM_ID,
      keyId: env.APPLE_OAUTH_KEY_ID,
      privateKey: env.APPLE_OAUTH_PRIVATE_KEY,
      redirectUri: `${env.PUBLIC_API_URL}/auth/apple/callback`,
      ...(env.APPLE_OAUTH_WEB_CLIENT_ID
        ? { webClientId: env.APPLE_OAUTH_WEB_CLIENT_ID }
        : {}),
      ...(appleExtraAudiences.length > 0 ? { extraAudiences: appleExtraAudiences } : {}),
    }
  }
  return config
}

export function toUserDTO(user: UserRecord, now: Date = new Date()): UserDTO {
  return {
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
    locale: resolveLocale(user.locale),
  }
}
