import type { TrustProxyValue } from "./parsers.js"
import type { CommsEnv } from "./comms-env.js"
import type { PaymentsEnv } from "./payments-env.js"
import type { RegistrationEnv } from "./registration-env.js"

export interface Env extends CommsEnv, PaymentsEnv, RegistrationEnv {
  NODE_ENV: "development" | "test" | "production"
  PORT: number
  PUBLIC_API_URL: string
  WEB_ORIGINS: string[]
  DATABASE_URL: string
  REDIS_URL: string
  SESSION_SIGNING_KEY: string
  ANON_TOKEN_SIGNING_KEY: string
  TRUST_PROXY: TrustProxyValue

  SHUTDOWN_DRAIN_MS: number

  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  R2_INBOUND_BUCKET?: string
  R2_PUBLIC_BASE?: string

  LOCAL_STORAGE_DIR?: string
  LOCAL_STORAGE_SIGNING_KEY?: string

  TILES_RASTER_URL?: string
  TILES_MIN_ZOOM: number
  TILES_MAX_ZOOM: number
  TILES_BOUNDS: [number, number, number, number]

  CENSUS_GEOCODER_URL: string
  CENSUS_GEOCODER_TIMEOUT_MS: number

  OCI_EMAIL_SMTP_HOST: string
  OCI_EMAIL_SMTP_PORT: number
  OCI_EMAIL_SMTP_TIMEOUT_MS: number
  OUTBOUND_SEND_MIN_THROUGHPUT_BPS: number
  VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS: number
  OCI_EMAIL_SMTP_USER: string
  OCI_EMAIL_SMTP_PASS: string
  MAIL_FROM_NOREPLY: string
  MAIL_FROM_OUTREACH: string
  HOME_TURF_MAIL_FROM: string
  HOME_TURF_NOTIFY_TO: string

  ADMIN_EMAILS: string[]
  MAIL_REPLY_DOMAIN: string
  OUTREACH_THROTTLE_DAYS: number
  OUTREACH_DIGEST_CRON: string
  INBOUND_SWEEP_CRON: string
  GUEST_RETENTION_CRON: string

  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_SMS_FROM: string
  SMS_GUEST_ENABLED: boolean
  SMS_DAILY_CAP: number

  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_SERVICE_TOKENS: string[]

  CF_TURNSTILE_SECRET?: string
  CF_TURNSTILE_HOSTNAMES: string[]
  CF_EMAIL_WEBHOOK_SECRET?: string
  CF_API_TOKEN?: string

  MAPBOX_TOKEN?: string

  APPLE_OAUTH_CLIENT_ID?: string
  APPLE_OAUTH_TEAM_ID?: string
  APPLE_OAUTH_KEY_ID?: string
  APPLE_OAUTH_PRIVATE_KEY?: string
  APPLE_OAUTH_IOS_CLIENT_ID?: string
  APPLE_OAUTH_WEB_CLIENT_ID?: string

  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REDIRECT_URI?: string
  GOOGLE_OAUTH_IOS_CLIENT_ID?: string
  GOOGLE_OAUTH_ANDROID_CLIENT_ID?: string

  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_PRIVATE_KEY?: string
  APNS_BUNDLE_ID?: string
  APNS_PRODUCTION?: boolean

  FCM_SERVICE_ACCOUNT_JSON?: string
  FCM_PROJECT_ID?: string

  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string

  EXPO_ACCESS_TOKEN?: string

  GLITCHTIP_DSN?: string
  GLITCHTIP_DATABASE_URL?: string

  OAUTH_REQUIRE_NONCE: boolean
  REVIEWER_OTP_BYPASS: boolean
  REVIEWER_OTP_BYPASS_ACK: boolean
  REVIEWER_OTP_CODE?: string

  USE_FAKE_STORAGE: boolean
  USE_FAKE_MAILER: boolean
  USE_FAKE_PUSH: boolean
  USE_FAKE_ABUSE_NSFW: boolean
  USE_FAKE_CHAT: boolean
  USE_FAKE_JOBS: boolean
  USE_FAKE_USER_CHANNEL: boolean

  USE_FAKE_GEOCODER: boolean

  USE_FAKE_SMS: boolean

  USE_FAKE_PAYMENTS: boolean

  USE_REAL_NSFW: boolean
}
