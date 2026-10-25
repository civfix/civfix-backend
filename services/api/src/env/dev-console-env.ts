import {
  RUNTIME_FLAGS,
  runtimeFlagValueSchema,
  type AdminDevEnvironment,
  type RuntimeFlagDef,
  type RuntimeFlagKey,
  type RuntimeFlagValue,
} from "@civfix/contract"
import { REVIEWER_OTP_EMAIL } from "../auth/otp.js"
import type { Env } from "./types.js"
import type { EnvReader } from "./reader.js"
import { parseBool, parseCsvLower } from "./parsers.js"

const DEV_TEST_OTP_CODE_MIN_LENGTH = 20

const CIVFIX_ENVS: ReadonlySet<string> = new Set(["prod", "staging"])
const DEV_TOOLS_ENVIRONMENTS: ReadonlySet<AdminDevEnvironment> = new Set(["staging", "local"])
const PRODUCTION_API_HOST = "api.civfix.org"
const TEST_EMAIL_DOMAIN = "@civfix.org"

/** The env value each runtime flag falls back to, present only for a flag whose env var is set non-empty. */
export type RuntimeFlagEnvFallbacks = Partial<Record<RuntimeFlagKey, RuntimeFlagValue>>

export type DevConsoleEnv = Pick<
  Env,
  | "environment"
  | "devToolsEnabled"
  | "DEV_TEST_EMAILS"
  | "DEV_TEST_OTP_CODE"
  | "devTestEmailsDropped"
  | "runtimeFlagEnvFallbacks"
>

export function loadDevConsoleEnv(
  r: EnvReader,
  context: { publicApiUrl: string; adminEmails: readonly string[] },
): DevConsoleEnv {
  const environment = loadEnvironment(r)
  const devToolsEnabled = loadDevToolsEnabled(r, environment, context.publicApiUrl)
  return {
    environment,
    devToolsEnabled,
    ...(devToolsEnabled
      ? loadTestAccounts(r, context.adminEmails)
      : { DEV_TEST_EMAILS: [], devTestEmailsDropped: 0 }),
    runtimeFlagEnvFallbacks: loadRuntimeFlagEnvFallbacks(r),
  }
}

// NODE_ENV is production on both boxes, so only CIVFIX_ENV tells them apart; a production process
// without it cannot say which box it is on.
function loadEnvironment(r: EnvReader): AdminDevEnvironment {
  const raw = r.trimmed("CIVFIX_ENV")
  if (raw.length === 0) return r.isProd ? "unknown" : "local"
  if (CIVFIX_ENVS.has(raw)) return raw as AdminDevEnvironment
  r.errors.push("CIVFIX_ENV: must be prod or staging (or empty)")
  return r.isProd ? "unknown" : "local"
}

// A refusal at boot, not an acknowledgement flag: nothing can switch the test tools on in production.
function loadDevToolsEnabled(
  r: EnvReader,
  environment: AdminDevEnvironment,
  publicApiUrl: string,
): boolean {
  if (!parseBool(r.source.DEV_TOOLS_ENABLED, false)) return false
  if (!DEV_TOOLS_ENVIRONMENTS.has(environment)) {
    r.errors.push(
      `DEV_TOOLS_ENABLED: must not be true when the environment is ${environment} ` +
        "(dev tools run only on staging or a local machine)",
    )
    return false
  }
  if (hostOf(publicApiUrl) === PRODUCTION_API_HOST) {
    r.errors.push(
      `DEV_TOOLS_ENABLED: must not be true when PUBLIC_API_URL is the production API (${PRODUCTION_API_HOST})`,
    )
    return false
  }
  return true
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}

// Errors and the boot warning never quote an address: the test accounts stay out of the boot log.
function loadTestAccounts(
  r: EnvReader,
  adminEmails: readonly string[],
): Pick<Env, "DEV_TEST_EMAILS" | "DEV_TEST_OTP_CODE" | "devTestEmailsDropped"> {
  const listed = parseCsvLower(r.source.DEV_TEST_EMAILS)
  const emails = listed.filter(isCivfixAddress)
  if (emails.includes(REVIEWER_OTP_EMAIL)) {
    r.errors.push(
      "DEV_TEST_EMAILS: must not list the App Store reviewer address (it has its own sign-in code)",
    )
  }
  const admins = new Set(adminEmails)
  if (emails.some((email) => admins.has(email))) {
    r.errors.push("DEV_TEST_EMAILS: must not list an address that is also in ADMIN_EMAILS")
  }
  const code = r.trimmed("DEV_TEST_OTP_CODE")
  if (code.length > 0 && code.length < DEV_TEST_OTP_CODE_MIN_LENGTH) {
    r.errors.push(
      `DEV_TEST_OTP_CODE: must be at least ${DEV_TEST_OTP_CODE_MIN_LENGTH} characters ` +
        "(it is a login secret, not a 6-digit OTP)",
    )
  } else if (code.length === 0 && emails.length > 0) {
    r.errors.push("DEV_TEST_OTP_CODE: required whenever DEV_TEST_EMAILS lists an address")
  }
  return {
    DEV_TEST_EMAILS: emails,
    devTestEmailsDropped: listed.length - emails.length,
    ...(code.length > 0 ? { DEV_TEST_OTP_CODE: code } : {}),
  }
}

function isCivfixAddress(email: string): boolean {
  const at = email.indexOf("@")
  return at > 0 && email.slice(at) === TEST_EMAIL_DOMAIN
}

// Booleans go through parseBool so a fallback means exactly what the env switch has always meant.
function loadRuntimeFlagEnvFallbacks(r: EnvReader): RuntimeFlagEnvFallbacks {
  const fallbacks: RuntimeFlagEnvFallbacks = {}
  for (const flag of RUNTIME_FLAGS as readonly RuntimeFlagDef[]) {
    if (flag.envFallback === null) continue
    const raw = r.trimmed(flag.envFallback)
    if (raw.length === 0) continue
    const key = flag.key as RuntimeFlagKey
    if (flag.type === "boolean") {
      fallbacks[key] = parseBool(raw, flag.default)
      continue
    }
    const parsed = runtimeFlagValueSchema(key).safeParse(raw)
    if (parsed.success) fallbacks[key] = parsed.data
    else r.errors.push(`${flag.envFallback}: not a valid value for the ${flag.key} runtime flag`)
  }
  return fallbacks
}
