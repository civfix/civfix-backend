import { makeEnvReader, type EnvSource } from "./reader.js"

export interface RegistrationEnv {
  TICKET_TOKEN_SECRET: string
  WAITLIST_EXPIRE_CRON: string
  CHECKIN_NOSHOW_CRON: string
}

export const DEVELOPMENT_TICKET_TOKEN_SECRET = "dev-insecure-ticket-token-secret-do-not-use-in-prod"

const TICKET_TOKEN_SECRET_MIN_LENGTH = 32

const WAITLIST_EXPIRE_CRON_DEFAULT = "*/10 * * * *"

const CHECKIN_NOSHOW_CRON_DEFAULT = "*/30 * * * *"

export function loadRegistrationEnv(source: EnvSource, errors: string[]): RegistrationEnv {
  const isProd = (source.NODE_ENV ?? "").trim() === "production"
  const r = makeEnvReader(source, errors, isProd)

  const TICKET_TOKEN_SECRET = r.requiredString("TICKET_TOKEN_SECRET")
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
    WAITLIST_EXPIRE_CRON: r.cron("WAITLIST_EXPIRE_CRON", WAITLIST_EXPIRE_CRON_DEFAULT),
    CHECKIN_NOSHOW_CRON: r.cron("CHECKIN_NOSHOW_CRON", CHECKIN_NOSHOW_CRON_DEFAULT),
  }
}
