import { isCronish } from "./parsers.js"

export interface RegistrationEnv {
  TICKET_TOKEN_SECRET: string
  WAITLIST_EXPIRE_CRON: string
  CHECKIN_NOSHOW_CRON: string
}

export const TICKET_TOKEN_SECRET_MIN_LENGTH = 32

export const WAITLIST_EXPIRE_CRON_DEFAULT = "*/10 * * * *"

export const CHECKIN_NOSHOW_CRON_DEFAULT = "*/30 * * * *"

export function loadRegistrationEnv(
  source: Record<string, string | undefined>,
  errors: string[],
): RegistrationEnv {
  const isProd = (source.NODE_ENV ?? "").trim() === "production"

  function reqStr(key: string, opts: { gatedOff?: boolean } = {}): string {
    const raw = source[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value.length === 0 && isProd && !(opts.gatedOff ?? false)) {
      errors.push(`${key}: required [BOOT] variable is missing`)
    }
    return value
  }

  function reqCron(key: string, fallback: string): string {
    const value = (source[key] ?? "").trim() || fallback
    if (!isCronish(value)) {
      errors.push(`${key}: must be a 5- or 6-field cron expression`)
    }
    return value
  }

  const TICKET_TOKEN_SECRET = reqStr("TICKET_TOKEN_SECRET")
  if (isProd && TICKET_TOKEN_SECRET === DEVELOPMENT_TICKET_TOKEN_SECRET) {
    errors.push("TICKET_TOKEN_SECRET: must not be the insecure dev default in production")
  }
  if (
    isProd &&
    TICKET_TOKEN_SECRET.length > 0 &&
    TICKET_TOKEN_SECRET.length < TICKET_TOKEN_SECRET_MIN_LENGTH
  ) {
    errors.push(
      `TICKET_TOKEN_SECRET: must be at least ${TICKET_TOKEN_SECRET_MIN_LENGTH} characters: ` +
        "it is the only thing standing between a guessed string and a forged event ticket",
    )
  }

  return {
    TICKET_TOKEN_SECRET:
      TICKET_TOKEN_SECRET.length > 0 || isProd
        ? TICKET_TOKEN_SECRET
        : DEVELOPMENT_TICKET_TOKEN_SECRET,
    WAITLIST_EXPIRE_CRON: reqCron("WAITLIST_EXPIRE_CRON", WAITLIST_EXPIRE_CRON_DEFAULT),
    CHECKIN_NOSHOW_CRON: reqCron("CHECKIN_NOSHOW_CRON", CHECKIN_NOSHOW_CRON_DEFAULT),
  }
}

export const DEVELOPMENT_TICKET_TOKEN_SECRET = "dev-insecure-ticket-token-secret-do-not-use-in-prod"
