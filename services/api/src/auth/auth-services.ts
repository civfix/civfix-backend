import type { Container } from "../di.js"
import type { OAuthProvider, UserDTO } from "@civfix/shared"
import type { Mailer } from "@civfix/shared/interfaces"
import { RedisCacheClient, type CacheClient } from "./cache.js"
import { SessionService, type SessionLogger } from "./session-service.js"
import {
  OtpService,
  REVIEWER_OTP_EMAIL,
  type OtpAuditSink,
  type OtpLogger,
  type ReviewerOtpConfig,
} from "./otp.js"
import { OAuthService, type OAuthConfig } from "./oauth.js"
import type { JwksVerifier } from "./jwks.js"
import {
  handleChangeableAtFrom,
  type AuthStores,
  type UserRecord,
  type UserStore,
} from "./stores.js"
import { PgAuthStores } from "./pg-stores.js"
import { REVIEWER_OTP_CODE_MIN_LENGTH } from "../env.js"
import { resolveLocale } from "../i18n/locales.js"
import { writeAudit } from "../services/admin/audit.js"
import { dataExportSupportEmail } from "../services/data-export-jobs.js"

export interface AuthServices {
  sessions: SessionService
  otp: OtpService
  oauth: OAuthService
  users: UserStore
  cache: CacheClient
  enabledProviders: OAuthProvider[]
}

function enabledProvidersFromConfig(config: OAuthConfig): OAuthProvider[] {
  const providers: OAuthProvider[] = []
  if (config.apple) providers.push("apple")
  if (config.google) providers.push("google")
  providers.push("email")
  return providers
}

export interface BuildAuthServicesOptions {
  stores: AuthStores
  cache: CacheClient
  mailer: Mailer
  oauthConfig: OAuthConfig
  verifier?: JwksVerifier
  now?: () => number
  logger?: OtpLogger & SessionLogger
  reviewer?: ReviewerOtpConfig
  supportEmail?: string
  audit?: OtpAuditSink
}

export function buildAuthServices(opts: BuildAuthServicesOptions): AuthServices {
  const now = opts.now
  const sessions = new SessionService({
    store: opts.stores.sessions,
    cache: opts.cache,
    users: opts.stores.users,
    ...(now ? { now } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  })
  const otp = new OtpService({
    store: opts.stores.otps,
    users: opts.stores.users,
    identities: opts.stores.oauth,
    cache: opts.cache,
    mailer: opts.mailer,
    ...(now ? { now } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    ...(opts.supportEmail !== undefined ? { supportEmail: opts.supportEmail } : {}),
    ...(opts.audit ? { audit: opts.audit } : {}),
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

export function buildAuthServicesFromContainer(
  container: Container,
  opts: { logger?: OtpLogger & SessionLogger } = {},
): AuthServices {
  const stores = new PgAuthStores(container.getDb().db, {
    certificateObjects: container.storage,
    notifier: container.getNotificationService(),
    jobs: container.jobs,
    ...(opts.logger ? { logger: opts.logger } : {}),
  })
  const cache = new RedisCacheClient(container.getRedis())
  const reviewerConfig = reviewerOtpConfigFromEnv(container.env)
  return buildAuthServices({
    stores,
    cache,
    mailer: container.mailer,
    oauthConfig: oauthConfigFromEnv(container.env),
    supportEmail: dataExportSupportEmail(container.env),
    audit: async (input) => {
      await writeAudit(container.getDb().sql, input)
    },
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(reviewerConfig !== null ? { reviewer: reviewerConfig } : {}),
  })
}

export const REVIEWER_OTP_MIN_CODE_LENGTH = REVIEWER_OTP_CODE_MIN_LENGTH

export function reviewerOtpConfigFromEnv(env: Container["env"]): ReviewerOtpConfig | null {
  if (env.REVIEWER_OTP_BYPASS !== true) return null
  const code = env.REVIEWER_OTP_CODE
  if (typeof code !== "string") return null
  const trimmed = code.trim()
  if (trimmed.length < REVIEWER_OTP_CODE_MIN_LENGTH) return null
  return { email: REVIEWER_OTP_EMAIL, code: trimmed }
}

export function oauthConfigFromEnv(env: Container["env"]): OAuthConfig {
  const config: OAuthConfig = {}
  if (
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REDIRECT_URI
  ) {
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
      ...(env.APPLE_OAUTH_WEB_CLIENT_ID ? { webClientId: env.APPLE_OAUTH_WEB_CLIENT_ID } : {}),
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
    ...(user.showVolunteerHours !== null ? { showVolunteerHours: user.showVolunteerHours } : {}),
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    locale: resolveLocale(user.locale),
    primaryOrganizationId: user.primaryOrganizationId,
  }
}
