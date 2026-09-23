import { z } from "zod"
import type { Env } from "./env/types.js"
import { loadCommsEnv } from "./env/comms-env.js"
import { loadRegistrationEnv } from "./env/registration-env.js"
import { makeEnvReader, type EnvReader } from "./env/reader.js"
import {
  checkDatabaseTls,
  checkGeocoderDatabase,
  loadAccessLists,
  loadApnsProduction,
  loadCoreEnv,
  loadFeedRanking,
  loadHomeRegion,
  loadLocalStorage,
  loadMailEnv,
  loadR2Env,
  loadScheduleEnv,
  loadSigningKeys,
  loadSmsEnv,
  loadTrustProxy,
  loadTuningEnv,
  type FakeFlags,
} from "./env/core-env.js"
import { parseBool, parseBounds } from "./env/parsers.js"

export type { Env } from "./env/types.js"
export { DEFAULT_TRUSTED_PROXY_CIDRS, SHUTDOWN_DRAIN_MS_MAX } from "./env/parsers.js"

export const REVIEWER_OTP_CODE_MIN_LENGTH = 20

const TILES_BOUNDS_DEFAULT: [number, number, number, number] = [-125, 24, -66, 50]

const NODE_ENVS = ["development", "test", "production"] as const
const NodeEnvSchema = z.enum(NODE_ENVS).default("development")

const OPTIONAL_STRING_KEYS: ReadonlyArray<keyof Env> = [
  "R2_INBOUND_BUCKET",
  "R2_PUBLIC_BASE",
  "TILES_RASTER_URL",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "CF_TURNSTILE_SECRET",
  "CF_EMAIL_WEBHOOK_SECRET",
  "CF_API_TOKEN",
  "MAPBOX_TOKEN",
  "APPLE_OAUTH_CLIENT_ID",
  "APPLE_OAUTH_TEAM_ID",
  "APPLE_OAUTH_KEY_ID",
  "APPLE_OAUTH_PRIVATE_KEY",
  "APPLE_OAUTH_WEB_CLIENT_ID",
  "APPLE_OAUTH_IOS_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_IOS_CLIENT_ID",
  "GOOGLE_OAUTH_ANDROID_CLIENT_ID",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_PRIVATE_KEY",
  "APNS_BUNDLE_ID",
  "FCM_SERVICE_ACCOUNT_JSON",
  "FCM_PROJECT_ID",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "EXPO_ACCESS_TOKEN",
  "GLITCHTIP_DSN",
  "GLITCHTIP_DATABASE_URL",
]

export const FAKE_SEAM_FLAGS: ReadonlyArray<{ flag: keyof FakeFlags; consequence: string }> = [
  { flag: "USE_FAKE_STORAGE", consequence: "uploaded media is kept in memory and lost on restart" },
  { flag: "USE_FAKE_MAILER", consequence: "every outbound email is silently dropped" },
  { flag: "USE_FAKE_PUSH", consequence: "every push notification is silently dropped" },
  { flag: "USE_FAKE_ABUSE_NSFW", consequence: "NSFW and abuse checks always pass" },
  { flag: "USE_FAKE_CHAT", consequence: "chat is in-process only: no persistence, no fan-out" },
  {
    flag: "USE_FAKE_JOBS",
    consequence:
      "background jobs run in-process and die with the request: media stays 'validating', data exports " +
      "and report autoforwards never complete",
  },
  {
    flag: "USE_FAKE_USER_CHANNEL",
    consequence: "realtime per-user signals never reach other API processes",
  },
  {
    flag: "USE_FAKE_GEOCODER",
    consequence:
      'every report is labeled "Los Angeles, CA" and that label is persisted as civic record',
  },
  {
    flag: "USE_FAKE_SMS",
    consequence:
      "guest-RSVP verification texts are swallowed and guests can never verify (turn SMS off with " +
      "SMS_GUEST_ENABLED=false instead)",
  },
]

function deriveFakeFlags(source: NodeJS.ProcessEnv, isProd: boolean): FakeFlags {
  const flags = { USE_REAL_NSFW: parseBool(source.USE_REAL_NSFW, false) } as FakeFlags
  for (const { flag } of FAKE_SEAM_FLAGS) {
    flags[flag] = parseBool(source[flag], !isProd)
  }
  return flags
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = []

  const nodeEnvParsed = NodeEnvSchema.safeParse(source.NODE_ENV)
  if (!nodeEnvParsed.success) {
    errors.push(`NODE_ENV: must be one of ${NODE_ENVS.join(" | ")}`)
  }
  const nodeEnv = nodeEnvParsed.success ? nodeEnvParsed.data : "development"
  const isProd = nodeEnv === "production"
  const r = makeEnvReader(source, errors, isProd)

  const fakeFlags = deriveFakeFlags(source, isProd)
  if (isProd) {
    for (const { flag, consequence } of FAKE_SEAM_FLAGS) {
      if (fakeFlags[flag]) {
        errors.push(`${flag}: must not be true in production; ${consequence}`)
      }
    }
  }

  const core = loadCoreEnv(r)
  const signingKeys = loadSigningKeys(r)
  checkDatabaseTls(r, core.DATABASE_URL)
  const TRUST_PROXY = loadTrustProxy(r)
  const homeRegion = loadHomeRegion(r)
  const FEED_RANKING = loadFeedRanking(r, "FEED_RANKING")
  const localStorage = loadLocalStorage(r, core.PUBLIC_API_URL)
  checkGeocoderDatabase(r, fakeFlags, core.DATABASE_URL)
  const r2 = loadR2Env(r, fakeFlags.USE_FAKE_STORAGE, localStorage.usesLocalStorage)
  const mail = loadMailEnv(r, fakeFlags.USE_FAKE_MAILER)
  const sms = loadSmsEnv(r, fakeFlags.USE_FAKE_SMS)
  const schedules = loadScheduleEnv(r)
  const authFlags = loadAuthFlags(r)
  const tuning = loadTuningEnv(r)
  const apns = loadApnsProduction(r)
  const comms = loadCommsEnv(source, errors)
  const registration = loadRegistrationEnv(source, errors)

  if (errors.length > 0) {
    const header =
      `Invalid environment for civfix API (NODE_ENV=${nodeEnv}). ` +
      `${errors.length} problem(s) found:`
    throw new Error([header, ...errors.map((e) => `  - ${e}`)].join("\n"))
  }

  return {
    NODE_ENV: nodeEnv,
    ...core,
    ...signingKeys,
    TRUST_PROXY,
    ...r2,
    ...localStorage.fields,
    TILES_BOUNDS: parseBounds(source.TILES_BOUNDS, TILES_BOUNDS_DEFAULT),
    ...homeRegion,
    FEED_RANKING,
    ...mail,
    ...sms,
    ...schedules,
    ...authFlags,
    ...tuning,
    ...loadAccessLists(r),
    ...optionalStrings(source, OPTIONAL_STRING_KEYS),
    ...apns,
    ...fakeFlags,
    ...comms,
    ...registration,
  }
}

function loadAuthFlags(
  r: EnvReader,
): Pick<
  Env,
  | "OAUTH_REQUIRE_NONCE"
  | "WS_ALLOW_QUERY_TOKEN"
  | "REVIEWER_OTP_BYPASS"
  | "REVIEWER_OTP_BYPASS_ACK"
  | "REVIEWER_OTP_CODE"
> {
  const { source } = r
  const REVIEWER_OTP_BYPASS = parseBool(source.REVIEWER_OTP_BYPASS, false)
  const REVIEWER_OTP_BYPASS_ACK = parseBool(source.REVIEWER_OTP_BYPASS_ACK, false)
  const REVIEWER_OTP_CODE = (source.REVIEWER_OTP_CODE ?? "").trim()
  checkReviewerBypass(r, {
    bypass: REVIEWER_OTP_BYPASS,
    acknowledged: REVIEWER_OTP_BYPASS_ACK,
    code: REVIEWER_OTP_CODE,
  })
  return {
    OAUTH_REQUIRE_NONCE: parseBool(source.OAUTH_REQUIRE_NONCE, false),
    WS_ALLOW_QUERY_TOKEN: parseBool(source.WS_ALLOW_QUERY_TOKEN, false),
    REVIEWER_OTP_BYPASS,
    REVIEWER_OTP_BYPASS_ACK,
    ...(REVIEWER_OTP_CODE.length > 0 ? { REVIEWER_OTP_CODE } : {}),
  }
}

function checkReviewerBypass(
  r: EnvReader,
  reviewer: { bypass: boolean; acknowledged: boolean; code: string },
): void {
  if (reviewer.code.length > 0 && reviewer.code.length < REVIEWER_OTP_CODE_MIN_LENGTH) {
    r.errors.push(
      `REVIEWER_OTP_CODE: must be at least ${REVIEWER_OTP_CODE_MIN_LENGTH} characters ` +
        "(it is a login secret, not a 6-digit OTP)",
    )
  }
  if (!r.isProd || !reviewer.bypass) return
  if (!reviewer.acknowledged) {
    r.errors.push(
      "REVIEWER_OTP_BYPASS: refusing to enable an authentication bypass in production without the " +
        "explicit second opt-in REVIEWER_OTP_BYPASS_ACK=true",
    )
  }
  if (reviewer.code.length === 0) {
    r.errors.push(
      "REVIEWER_OTP_CODE: required whenever REVIEWER_OTP_BYPASS is on in production (a per-review, " +
        `rotated secret of at least ${REVIEWER_OTP_CODE_MIN_LENGTH} characters)`,
    )
  }
}

function optionalStrings(source: NodeJS.ProcessEnv, keys: ReadonlyArray<keyof Env>): Partial<Env> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim()
    }
  }
  return out
}

let cached: Env | undefined

function loadedEnv(): Env {
  cached ??= loadEnv()
  return cached
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    if (prop === "toJSON") return () => "[civfix env: redacted]"
    return loadedEnv()[prop as keyof Env]
  },
  has(_target, prop: string) {
    return prop in loadedEnv()
  },
  ownKeys() {
    return Reflect.ownKeys(loadedEnv())
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    return Object.getOwnPropertyDescriptor(loadedEnv(), prop)
  },
})

export function isProd(): boolean {
  return env.NODE_ENV === "production"
}
