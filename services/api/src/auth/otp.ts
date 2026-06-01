/**
 * Email one-time-passcode sign-in (plan section 8).
 *
 * issueOtp(email, ip):
 *   - rate limits FIRST: at most 1 request per 60s per email, and 10 per hour per IP (Redis counters
 *     via the CacheClient seam, so the windows are testable with an injectable clock);
 *   - mints a 6-digit code with a cryptographically uniform, modulo-bias-free draw;
 *   - stores ONLY the argon2id hash of the code in email_otps (expires in 5 min, attempts 0);
 *   - invalidates any prior unconsumed codes for that email (resend supersedes);
 *   - sends the code through the Mailer seam (FakeMailer captures it in dev/test).
 *
 * verifyOtp(email, code):
 *   - loads the latest unconsumed, non-expired code; missing -> unauthorized;
 *   - enforces a 3-attempt ceiling: a code that has already used its attempts is locked;
 *   - verifies with argon2 (constant-time); a wrong code increments attempts (and locks at 3);
 *   - on success marks the code consumed (single-use) and find-or-creates the user, returning userId.
 */

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2"
import { AppError } from "@civfix/shared"
import { generateNumericCode } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import type { OtpStore, UserStore } from "./stores.js"
import type { Mailer } from "@civfix/shared/interfaces"

/** OTP code length (digits). */
export const OTP_CODE_LENGTH = 6
/** Code lifetime: 5 minutes. */
export const OTP_TTL_SECONDS = 5 * 60
/** Maximum verify attempts before a code is locked. */
export const OTP_MAX_ATTEMPTS = 3
/** Per-email resend cooldown: 1 request / 60s. */
export const OTP_EMAIL_WINDOW_SECONDS = 60
/** Per-IP cap: 10 requests / hour. */
export const OTP_IP_WINDOW_SECONDS = 60 * 60
export const OTP_IP_MAX_PER_WINDOW = 10

/**
 * argon2 algorithm id. The library exports `Algorithm` as a `const enum`, which `isolatedModules`
 * forbids referencing across modules, so we use its stable numeric value: Argon2id = 2.
 */
const ARGON2ID = 2

/**
 * argon2id parameters. Interactive-grade: a 6-digit code lives 5 minutes and is attempt-limited, so
 * we do not need the heaviest cost. These mirror sensible defaults (64 MiB, 3 passes).
 */
const ARGON_OPTS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const

export interface OtpServiceOptions {
  store: OtpStore
  users: UserStore
  cache: CacheClient
  mailer: Mailer
  now?: () => number
}

export interface IssueResult {
  /** Seconds the caller must wait before a resend is allowed (the per-email window). */
  resendAfterSec: number
}

export class OtpService {
  private readonly store: OtpStore
  private readonly users: UserStore
  private readonly cache: CacheClient
  private readonly mailer: Mailer
  private readonly now: () => number

  constructor(opts: OtpServiceOptions) {
    this.store = opts.store
    this.users = opts.users
    this.cache = opts.cache
    this.mailer = opts.mailer
    this.now = opts.now ?? Date.now
  }

  /**
   * Issue (or resend) a code to `email`. `ip` drives the per-IP hourly cap; pass null when unknown
   * (the per-IP limit is then skipped, e.g. trusted internal callers).
   */
  async issueOtp(email: string, ip: string | null): Promise<IssueResult> {
    const normalized = email.trim().toLowerCase()

    // Per-email cooldown: the counter key carries the window TTL; a second hit inside 60s trips it.
    const emailKey = `otp:rl:email:${normalized}`
    const emailHits = await this.cache.incr(emailKey, OTP_EMAIL_WINDOW_SECONDS)
    if (emailHits > 1) {
      throw AppError.rateLimited("Please wait before requesting another code.")
    }

    // Per-IP hourly cap.
    if (ip) {
      const ipKey = `otp:rl:ip:${ip}`
      const ipHits = await this.cache.incr(ipKey, OTP_IP_WINDOW_SECONDS)
      if (ipHits > OTP_IP_MAX_PER_WINDOW) {
        throw AppError.rateLimited("Too many code requests from this network.")
      }
    }

    // Supersede any prior unconsumed codes, then store the new one (hash only).
    await this.store.invalidateActiveForEmail(normalized)
    const code = generateNumericCode(OTP_CODE_LENGTH)
    const codeHash = await argonHash(code, ARGON_OPTS)
    await this.store.insert({
      email: normalized,
      codeHash,
      expiresAt: new Date(this.now() + OTP_TTL_SECONDS * 1000),
    })

    await this.mailer.sendOtp(normalized, code)
    return { resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }
  }

  /**
   * Verify a presented code for `email`. Returns the userId on success (find-or-create). Throws an
   * AppError for every failure mode: no active code, locked (attempts exhausted), or wrong code.
   */
  async verifyOtp(email: string, code: string): Promise<string> {
    const normalized = email.trim().toLowerCase()
    const now = new Date(this.now())

    const record = await this.store.findLatestActive(normalized, now)
    if (!record) {
      throw AppError.unauthorized("Invalid or expired code.")
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      // Already exhausted: lock it so it cannot be retried, even with the right code.
      await this.store.markConsumed(record.id, now)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    const ok = await argonVerify(record.codeHash, code)
    if (!ok) {
      const attempts = await this.store.incrementAttempts(record.id)
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.store.markConsumed(record.id, now)
      }
      throw AppError.unauthorized("Invalid or expired code.")
    }

    // Success: single-use consume, then find-or-create the account.
    await this.store.markConsumed(record.id, now)
    const existing = await this.users.findByEmail(normalized)
    if (existing) return existing.id
    const created = await this.users.create(normalized, {
      displayName: defaultDisplayName(normalized),
      role: "citizen",
    })
    return created.id
  }
}

/** Derive a friendly default display name from an email local-part (e.g. "jane.doe" -> "jane.doe"). */
function defaultDisplayName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "citizen"
}
