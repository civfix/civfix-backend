/**
 * Environment loader for the civfix API.
 *
 * This file is the single source of truth for backend configuration. Later steps READ from the
 * exported `Env` type and the `env` singleton; they do not redefine env vars here.
 *
 * Conventions used in the comments below:
 *   [BOOT] required for the server to boot in production.
 *   [OPT]  optional; a feature degrades or is disabled when it is absent.
 *
 * Behavior:
 *   - In production (NODE_ENV === "production"), every [BOOT] var must be present or `loadEnv()`
 *     throws a single aggregated error listing every missing var.
 *   - Outside production, the loader provides insecure DEV DEFAULTS for the signing keys and
 *     defaults all USE_FAKE_* flags to ON, so the server boots fully offline with no credentials.
 *   - A [BOOT] var that is gated by a USE_FAKE_* flag is only required when that fake is OFF.
 */

import { z } from "zod"

/** Parse "1"/"true"/"yes"/"on" (case-insensitive) as true; everything else false. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Split a comma list into a trimmed, non-empty array. */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Parse a non-negative integer from an env string, falling back when blank/invalid. Used for the
 * optional tile zoom levels; an unparseable value silently uses the default rather than blocking boot
 * (these are [OPT], not [BOOT]).
 */
function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse a "west,south,east,north" bounds string into a 4-tuple. Falls back to `fallback` unless the
 * input is exactly four finite numbers. [OPT], so a malformed value degrades to the default.
 */
function parseBounds(
  raw: string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (raw === undefined || raw.trim() === "") return fallback
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

/**
 * Insecure development defaults. NEVER used when NODE_ENV === "production": the production branch
 * requires the real values and throws if they are missing.
 */
const DEV_SESSION_SIGNING_KEY = "dev-insecure-session-signing-key-do-not-use-in-prod"
const DEV_ANON_TOKEN_SIGNING_KEY = "dev-insecure-anon-token-signing-key-do-not-use-in-prod"

/**
 * Map-tile defaults. Used by GET /map/tileinfo when the corresponding TILES_* vars are unset so the
 * route never 500s on missing config. Bounds are the continental-US-ish envelope [west, south, east,
 * north]; zoom range covers a typical web slippy map.
 */
const TILES_MIN_ZOOM_DEFAULT = 1
const TILES_MAX_ZOOM_DEFAULT = 19
const TILES_BOUNDS_DEFAULT: [number, number, number, number] = [-125, 24, -66, 50]

const NodeEnvSchema = z.enum(["development", "test", "production"]).default("development")

/**
 * The validated, typed environment. Field comments carry the [BOOT]/[OPT] marker and the fake flag
 * (if any) that bypasses the requirement.
 */
export interface Env {
  // ----- core [BOOT] -----
  NODE_ENV: "development" | "test" | "production"
  PORT: number
  PUBLIC_API_URL: string
  /** CORS allowlist, parsed from a comma list in WEB_ORIGINS. */
  WEB_ORIGINS: string[]
  DATABASE_URL: string
  REDIS_URL: string
  SESSION_SIGNING_KEY: string
  ANON_TOKEN_SIGNING_KEY: string

  // ----- storage (R2): [BOOT] unless USE_FAKE_STORAGE -----
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  R2_PUBLIC_BASE?: string

  // ----- map tiles (all [OPT]; the /map/tileinfo route degrades to a documented default) -----
  /** PMTiles archive URL (vector basemap). Absent -> tileinfo returns "" and a raster/style fallback. */
  TILES_PMTILES_URL?: string
  /** Raster XYZ tile template (e.g. https://.../{z}/{x}/{y}.png). Fallback when PMTiles is absent. */
  TILES_RASTER_URL?: string
  /** Full MapLibre style JSON URL. Optional alternative the client may prefer over pmtiles/raster. */
  TILES_STYLE_URL?: string
  /** Min zoom advertised by tileinfo. Defaults to TILES_MIN_ZOOM_DEFAULT. */
  TILES_MIN_ZOOM: number
  /** Max zoom advertised by tileinfo. Defaults to TILES_MAX_ZOOM_DEFAULT. */
  TILES_MAX_ZOOM: number
  /** Map bounds [west, south, east, north] advertised by tileinfo. Defaults to TILES_BOUNDS_DEFAULT. */
  TILES_BOUNDS: [number, number, number, number]

  // ----- mailer (OCI SMTP): [BOOT] unless USE_FAKE_MAILER -----
  OCI_EMAIL_SMTP_HOST: string
  OCI_EMAIL_SMTP_PORT: number
  OCI_EMAIL_SMTP_USER: string
  OCI_EMAIL_SMTP_PASS: string
  MAIL_FROM_NOREPLY: string
  MAIL_FROM_OUTREACH: string

  // ----- feature / integration [OPT] -----
  CF_TURNSTILE_SECRET?: string
  CF_EMAIL_WEBHOOK_SECRET?: string
  CF_API_TOKEN?: string

  APPLE_OAUTH_CLIENT_ID?: string
  APPLE_OAUTH_TEAM_ID?: string
  APPLE_OAUTH_KEY_ID?: string
  APPLE_OAUTH_PRIVATE_KEY?: string

  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REDIRECT_URI?: string

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

  GLITCHTIP_DSN?: string
  GLITCHTIP_DATABASE_URL?: string

  // ----- fake-seam flags -----
  USE_FAKE_STORAGE: boolean
  USE_FAKE_MAILER: boolean
  USE_FAKE_PUSH: boolean
  USE_FAKE_ABUSE_NSFW: boolean
  USE_FAKE_CHAT: boolean
  USE_FAKE_JOBS: boolean

  /**
   * Opt-in real NSFW scoring. Default false EVEN in production: with the flag off (or on but with no
   * model wired) RealAbuseChecks.nsfwScore returns benign (0), so default-flag production publishes
   * media instead of holding all of it. Flipping this to true is a flag-gated follow-up that also
   * requires a real model behind the seam. The media-worker reads the same flag from its own env.
   */
  USE_REAL_NSFW: boolean
}

/** Optional-string schema that treats "" as undefined so blank env entries do not satisfy [BOOT]. */
const optStr = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined))

const PortSchema = z.coerce.number().int().positive().max(65535)

/**
 * Load and validate process environment into a typed `Env`. Throws an aggregated Error when any
 * required value is missing or invalid. Pass an explicit `source` (defaults to process.env) for
 * tests so they do not have to mutate the real environment.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = []

  const nodeEnvParsed = NodeEnvSchema.safeParse(source.NODE_ENV)
  if (!nodeEnvParsed.success) {
    errors.push("NODE_ENV: must be one of development | test | production")
  }
  const nodeEnv = nodeEnvParsed.success ? nodeEnvParsed.data : "development"
  const isProd = nodeEnv === "production"

  // Fake flags. Default ON outside production so the server boots offline; OFF in production.
  const useFakeStorage = parseBool(source.USE_FAKE_STORAGE, !isProd)
  const useFakeMailer = parseBool(source.USE_FAKE_MAILER, !isProd)
  const useFakePush = parseBool(source.USE_FAKE_PUSH, !isProd)
  const useFakeAbuseNsfw = parseBool(source.USE_FAKE_ABUSE_NSFW, !isProd)
  const useFakeChat = parseBool(source.USE_FAKE_CHAT, !isProd)
  const useFakeJobs = parseBool(source.USE_FAKE_JOBS, !isProd)
  // Real NSFW is opt-in and defaults OFF in ALL environments (production publishes benign by default).
  const useRealNsfw = parseBool(source.USE_REAL_NSFW, false)

  /**
   * Require a [BOOT] string. `gatedOff` true means a fake bypasses it (so it is only required when
   * the fake is OFF). Returns the value, "" when missing (callers do not read missing-and-recorded
   * values because an error is already queued).
   */
  function reqStr(key: keyof NodeJS.ProcessEnv, opts: { gatedOff?: boolean } = {}): string {
    const gatedOff = opts.gatedOff ?? false
    const raw = source[key as string]
    const value = typeof raw === "string" ? raw.trim() : ""
    const required = isProd && !gatedOff
    if (value.length === 0 && required) {
      errors.push(`${String(key)}: required [BOOT] variable is missing`)
    }
    return value
  }

  function reqPort(key: string, fallback: number): number {
    const raw = source[key]
    if (raw === undefined || raw === "") return fallback
    const parsed = PortSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(`${key}: must be an integer between 1 and 65535`)
      return fallback
    }
    return parsed.data
  }

  // ----- core [BOOT] -----
  const PORT = reqPort("PORT", 8080)
  const PUBLIC_API_URL = reqStr("PUBLIC_API_URL")
  const WEB_ORIGINS = parseCsv(source.WEB_ORIGINS)
  if (isProd && WEB_ORIGINS.length === 0) {
    errors.push("WEB_ORIGINS: required [BOOT] CORS allowlist (comma list) is missing")
  }
  const DATABASE_URL = reqStr("DATABASE_URL")
  const REDIS_URL = reqStr("REDIS_URL")

  // Signing keys: dev defaults outside prod, hard-required in prod.
  let SESSION_SIGNING_KEY = (source.SESSION_SIGNING_KEY ?? "").trim()
  let ANON_TOKEN_SIGNING_KEY = (source.ANON_TOKEN_SIGNING_KEY ?? "").trim()
  if (isProd) {
    if (SESSION_SIGNING_KEY.length === 0) {
      errors.push("SESSION_SIGNING_KEY: required [BOOT] variable is missing")
    }
    if (ANON_TOKEN_SIGNING_KEY.length === 0) {
      errors.push("ANON_TOKEN_SIGNING_KEY: required [BOOT] variable is missing")
    }
  } else {
    if (SESSION_SIGNING_KEY.length === 0) SESSION_SIGNING_KEY = DEV_SESSION_SIGNING_KEY
    if (ANON_TOKEN_SIGNING_KEY.length === 0) ANON_TOKEN_SIGNING_KEY = DEV_ANON_TOKEN_SIGNING_KEY
  }

  // ----- storage (R2) -----
  const R2_ACCOUNT_ID = reqStr("R2_ACCOUNT_ID", { gatedOff: useFakeStorage })
  const R2_ACCESS_KEY_ID = reqStr("R2_ACCESS_KEY_ID", { gatedOff: useFakeStorage })
  const R2_SECRET_ACCESS_KEY = reqStr("R2_SECRET_ACCESS_KEY", { gatedOff: useFakeStorage })
  const R2_BUCKET = reqStr("R2_BUCKET", { gatedOff: useFakeStorage })

  // ----- mailer (OCI SMTP) -----
  const OCI_EMAIL_SMTP_HOST = reqStr("OCI_EMAIL_SMTP_HOST", { gatedOff: useFakeMailer })
  const OCI_EMAIL_SMTP_PORT = reqPort("OCI_EMAIL_SMTP_PORT", 587)
  const OCI_EMAIL_SMTP_USER = reqStr("OCI_EMAIL_SMTP_USER", { gatedOff: useFakeMailer })
  const OCI_EMAIL_SMTP_PASS = reqStr("OCI_EMAIL_SMTP_PASS", { gatedOff: useFakeMailer })

  if (errors.length > 0) {
    const header =
      `Invalid environment for civfix API (NODE_ENV=${nodeEnv}). ` +
      `${errors.length} problem(s) found:`
    throw new Error([header, ...errors.map((e) => `  - ${e}`)].join("\n"))
  }

  const env: Env = {
    NODE_ENV: nodeEnv,
    PORT,
    PUBLIC_API_URL,
    WEB_ORIGINS,
    DATABASE_URL,
    REDIS_URL,
    SESSION_SIGNING_KEY,
    ANON_TOKEN_SIGNING_KEY,

    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    ...(optStr.parse(source.R2_PUBLIC_BASE) !== undefined
      ? { R2_PUBLIC_BASE: source.R2_PUBLIC_BASE!.trim() }
      : {}),
    ...(optStr.parse(source.TILES_PMTILES_URL) !== undefined
      ? { TILES_PMTILES_URL: source.TILES_PMTILES_URL!.trim() }
      : {}),
    ...(optStr.parse(source.TILES_RASTER_URL) !== undefined
      ? { TILES_RASTER_URL: source.TILES_RASTER_URL!.trim() }
      : {}),
    ...(optStr.parse(source.TILES_STYLE_URL) !== undefined
      ? { TILES_STYLE_URL: source.TILES_STYLE_URL!.trim() }
      : {}),
    TILES_MIN_ZOOM: parseIntOr(source.TILES_MIN_ZOOM, TILES_MIN_ZOOM_DEFAULT),
    TILES_MAX_ZOOM: parseIntOr(source.TILES_MAX_ZOOM, TILES_MAX_ZOOM_DEFAULT),
    TILES_BOUNDS: parseBounds(source.TILES_BOUNDS, TILES_BOUNDS_DEFAULT),

    OCI_EMAIL_SMTP_HOST,
    OCI_EMAIL_SMTP_PORT,
    OCI_EMAIL_SMTP_USER,
    OCI_EMAIL_SMTP_PASS,
    MAIL_FROM_NOREPLY: (source.MAIL_FROM_NOREPLY ?? "").trim() || "no-reply@civfix.org",
    MAIL_FROM_OUTREACH: (source.MAIL_FROM_OUTREACH ?? "").trim() || "outreach@civfix.org",

    ...optGroup(source, [
      "CF_TURNSTILE_SECRET",
      "CF_EMAIL_WEBHOOK_SECRET",
      "CF_API_TOKEN",
      "APPLE_OAUTH_CLIENT_ID",
      "APPLE_OAUTH_TEAM_ID",
      "APPLE_OAUTH_KEY_ID",
      "APPLE_OAUTH_PRIVATE_KEY",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
      "APNS_KEY_ID",
      "APNS_TEAM_ID",
      "APNS_PRIVATE_KEY",
      "APNS_BUNDLE_ID",
      "FCM_SERVICE_ACCOUNT_JSON",
      "FCM_PROJECT_ID",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
      "GLITCHTIP_DSN",
      "GLITCHTIP_DATABASE_URL",
    ]),
    ...(source.APNS_PRODUCTION !== undefined && source.APNS_PRODUCTION !== ""
      ? { APNS_PRODUCTION: parseBool(source.APNS_PRODUCTION, false) }
      : {}),

    USE_FAKE_STORAGE: useFakeStorage,
    USE_FAKE_MAILER: useFakeMailer,
    USE_FAKE_PUSH: useFakePush,
    USE_FAKE_ABUSE_NSFW: useFakeAbuseNsfw,
    USE_FAKE_CHAT: useFakeChat,
    USE_FAKE_JOBS: useFakeJobs,
    USE_REAL_NSFW: useRealNsfw,
  }

  return env
}

/** Build a partial object of the present optional string keys, trimming values. */
function optGroup(
  source: NodeJS.ProcessEnv,
  keys: ReadonlyArray<keyof Env & string>,
): Partial<Env> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim()
    }
  }
  return out as Partial<Env>
}

let cached: Env | undefined

/**
 * Lazily-loaded, cached singleton env. Importing this module does NOT load env; the first property
 * access does, so tests can call `loadEnv(customSource)` without tripping process.env validation.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    if (cached === undefined) cached = loadEnv()
    return cached[prop as keyof Env]
  },
  has(_target, prop: string) {
    if (cached === undefined) cached = loadEnv()
    return prop in cached
  },
  ownKeys() {
    if (cached === undefined) cached = loadEnv()
    return Reflect.ownKeys(cached)
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    if (cached === undefined) cached = loadEnv()
    return Object.getOwnPropertyDescriptor(cached, prop)
  },
})

/** Test/HMR helper: drop the cached singleton so the next access reloads from process.env. */
export function resetEnvCache(): void {
  cached = undefined
}
