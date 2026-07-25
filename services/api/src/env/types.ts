import type { TrustProxyValue } from "./parsers.js"

/**
 * The validated, typed environment.
 *
 * [BOOT] = required to boot in production (a USE_FAKE_* flag bypasses the gated ones).
 * [OPT]  = optional; a feature degrades or is disabled when absent.
 */
export interface Env {
  NODE_ENV: "development" | "test" | "production"
  PORT: number
  PUBLIC_API_URL: string
  /** CORS allowlist, parsed from a comma list in WEB_ORIGINS. */
  WEB_ORIGINS: string[]
  DATABASE_URL: string
  REDIS_URL: string
  SESSION_SIGNING_KEY: string
  ANON_TOKEN_SIGNING_KEY: string
  /**
   * Which upstream hops Fastify trusts for X-Forwarded-* (drives request.ip). Defaults to the internal
   * loopback+private ranges so a client-supplied X-Forwarded-For from the public internet is never
   * honored. See env/parsers.parseTrustProxy.
   */
  TRUST_PROXY: TrustProxyValue

  // R2 is MEDIA ONLY (report photos/videos), NOT map tiles (the map uses the CARTO Voyager raster
  // basemap loaded directly by the clients). [BOOT] unless USE_FAKE_STORAGE.
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  /**
   * DEDICATED R2 bucket for the inbound-mail buffer (the Cloudflare Email Worker writes raw .eml +
   * extracted attachments here).
   *
   * SECURITY (H10): raw inbound mail is citizen<->city correspondence and must NEVER share a bucket with
   * the CDN-published media bucket. It is [OPT] only while R2_PUBLIC_BASE is unset (nothing is publicly
   * addressable then); as soon as R2_PUBLIC_BASE is set with real storage this becomes [BOOT] and must
   * differ from R2_BUCKET. loadEnv enforces both halves.
   */
  R2_INBOUND_BUCKET?: string
  R2_PUBLIC_BASE?: string

  // Map basemap tuning (all [OPT]): these only adjust what GET /map/tileinfo advertises; the clients
  // hardcode the CARTO Voyager raster and need no config.
  /** OPTIONAL override of the default CARTO Voyager raster XYZ template advertised by tileinfo. [OPT] */
  TILES_RASTER_URL?: string
  TILES_MIN_ZOOM: number
  TILES_MAX_ZOOM: number
  /** Map bounds [west, south, east, north] advertised by tileinfo. */
  TILES_BOUNDS: [number, number, number, number]

  // US Census Geocoder write-time jurisdiction fallback [OPT]: both carry defaults (NOT [BOOT]).
  CENSUS_GEOCODER_URL: string
  /** AbortController timeout (ms) for the Census fallback; kept short so a slow API never blocks report creation. */
  CENSUS_GEOCODER_TIMEOUT_MS: number

  // OCI SMTP mailer: [BOOT] unless USE_FAKE_MAILER.
  OCI_EMAIL_SMTP_HOST: string
  OCI_EMAIL_SMTP_PORT: number
  OCI_EMAIL_SMTP_USER: string
  OCI_EMAIL_SMTP_PASS: string
  MAIL_FROM_NOREPLY: string
  MAIL_FROM_OUTREACH: string
  /** From address for Home Turf form mail (notification + confirmation). Defaults to "donotreply@civfix.org". */
  HOME_TURF_MAIL_FROM: string
  /** Recipient of the Home Turf sign-up notification email. Defaults to "roman@reachoutla.org". */
  HOME_TURF_NOTIFY_TO: string

  /**
   * Allowlist of emails authorized to sign in to the admin dashboard (lowercased + de-duped). NOT [BOOT]:
   * an EMPTY allowlist means NO ONE can log in to admin (login returns generic { sent: true }, verify rejects).
   */
  ADMIN_EMAILS: string[]
  /** Reply domain for reply+{threadToken}@{MAIL_REPLY_DOMAIN} inbound addresses. Defaults to "civfix.org". */
  MAIL_REPLY_DOMAIN: string
  /** At most one outreach per jurisdiction per this many days. Defaults to 7. */
  OUTREACH_THROTTLE_DAYS: number
  /** Cron for the daily outreach digest sweep ("outreach.digest" pg-boss job). */
  OUTREACH_DIGEST_CRON: string
  /** Cron for the inbound-mail reconciliation sweep ("inbound.sweep" pg-boss job). */
  INBOUND_SWEEP_CRON: string

  /**
   * Cloudflare Access team domain — BOTH the expected JWT `iss` and the JWKS base. The admin Access
   * exchange route is enabled ONLY when both this and CF_ACCESS_AUD are present. [OPT]
   */
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  /** Permitted Access service-token client IDs. Parsed + reserved only; service-token exchange not yet wired. [OPT] */
  CF_ACCESS_SERVICE_TOKENS: string[]

  CF_TURNSTILE_SECRET?: string
  CF_EMAIL_WEBHOOK_SECRET?: string
  CF_API_TOKEN?: string

  /** Mapbox server token for reverse geocoding [OPT] - reverse falls back to Photon when unset. */
  MAPBOX_TOKEN?: string

  APPLE_OAUTH_CLIENT_ID?: string
  APPLE_OAUTH_TEAM_ID?: string
  APPLE_OAUTH_KEY_ID?: string
  APPLE_OAUTH_PRIVATE_KEY?: string
  /**
   * Additional accepted audience for the NATIVE Apple id_token, beyond APPLE_OAUTH_CLIENT_ID. A native iOS
   * "Sign in with Apple" identity token's `aud` is the app bundle id (e.g. `org.civfix.community`). Set this
   * to that bundle id so native sign-in verifies even when APPLE_OAUTH_CLIENT_ID is configured to the WEB
   * Services ID (org.civfix.web) instead of the bundle id — mirrors GOOGLE_OAUTH_IOS_CLIENT_ID. [OPT]
   */
  APPLE_OAUTH_IOS_CLIENT_ID?: string
  /**
   * The Apple "Services ID" used for Sign in with Apple on the WEB (e.g. `org.civfix.web`). It is a
   * SEPARATE identifier from APPLE_OAUTH_CLIENT_ID (the native app's bundle id): the web id_token's `aud`
   * is this Services ID, and it is the OAuth `client_id` of the web redirect flow. Reuses the same team
   * id / key id / .p8 private key as the native config. When unset, the web Apple button's start endpoint
   * returns "not configured" (the native/mobile Apple flow is unaffected). [OPT]
   */
  APPLE_OAUTH_WEB_CLIENT_ID?: string

  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REDIRECT_URI?: string
  /**
   * iOS / Android native OAuth client ids — separate Google clients whose minted ID-token `aud` the
   * backend accepts as valid audiences alongside GOOGLE_OAUTH_CLIENT_ID. [OPT]
   */
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

  // [OPT] Expo access token for the Expo push service. Push to Expo-managed mobile apps works WITHOUT it
  // (the mobile app mints ExponentPushToken[...] tokens); set it to enable Expo's enhanced push security.
  EXPO_ACCESS_TOKEN?: string

  GLITCHTIP_DSN?: string
  GLITCHTIP_DATABASE_URL?: string

  /**
   * Reviewer-OTP bypass: when true, `reviewer@civfix.org` signs in WITHOUT any email being sent, creating
   * a fully set-up citizen account on first use (for App Review of a mobile build already in review).
   *
   * SECURITY (C1): this is an authentication bypass. It defaults to **false** in every environment, and
   * turning it on in production additionally requires BOTH:
   *   - REVIEWER_OTP_BYPASS_ACK=true — an explicit second opt-in so no single typo'd/copied value can
   *     re-enable a login backdoor on a production box; and
   *   - REVIEWER_OTP_CODE — a per-review, high-entropy secret (>= REVIEWER_OTP_CODE_MIN_LENGTH chars).
   * A production boot with the bypass on and either of those missing FAILS CLOSED (loadEnv throws).
   */
  /**
   * Require a server-issued, single-use nonce on the NATIVE Apple/Google sign-in routes (H1). Defaults
   * false: the shipped native clients do not send one yet, and requiring it before they do is a total
   * sign-in outage recoverable only by an App Store release. A presented nonce is ALWAYS redeemed and
   * enforced regardless of this flag — the flag only decides whether an ABSENT nonce is fatal. [OPT]
   */
  OAUTH_REQUIRE_NONCE: boolean
  REVIEWER_OTP_BYPASS: boolean
  /**
   * Second, deliberate opt-in required to run REVIEWER_OTP_BYPASS in production (see above). Meaningless
   * on its own — it only unlocks the bypass, it never enables it. [OPT]
   */
  REVIEWER_OTP_BYPASS_ACK: boolean
  /**
   * The secret code the reviewer account signs in with. NO DEFAULT and never hardcoded: the auth layer
   * refuses to wire the bypass when this is absent or shorter than REVIEWER_OTP_CODE_MIN_LENGTH, so the
   * old world-readable `000000` constant cannot come back. Rotate it per review submission. [OPT]
   */
  REVIEWER_OTP_CODE?: string

  USE_FAKE_STORAGE: boolean
  USE_FAKE_MAILER: boolean
  USE_FAKE_PUSH: boolean
  USE_FAKE_ABUSE_NSFW: boolean
  USE_FAKE_CHAT: boolean
  USE_FAKE_JOBS: boolean
  /**
   * Use the in-memory FakeUserChannel instead of the Redis-backed one for the per-user realtime
   * invalidate-signal channel. Defaults ON outside production, OFF in production. Adds no new [BOOT] var
   * (the real impl needs only Redis, already required when chat is real).
   */
  USE_FAKE_USER_CHANNEL: boolean

  /**
   * Opt-in real NSFW scoring. Default false EVEN in production: with the flag off (or on but with no
   * model wired) RealAbuseChecks.nsfwScore returns benign (0), so default-flag production publishes media
   * instead of holding all of it. The media-worker reads the same flag from its own env.
   */
  USE_REAL_NSFW: boolean
}
