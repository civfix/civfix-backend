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
 * verifyOtp(email, code, ip):
 *   - THROTTLE (per-account + per-IP): before touching the code it checks a per-email AND a per-IP
 *     failed-verify counter; once either exceeds its window cap, verification is LOCKED (generic
 *     unauthorized) so an attacker cannot keep guessing across freshly-issued codes. This is the OUTER
 *     bound that the per-code 3-attempt lock (below) sits inside.
 *   - loads the latest unconsumed, non-expired code; missing -> unauthorized;
 *   - enforces a 3-attempt ceiling ATOMICALLY: it increments attempts FIRST and gates on the returned
 *     value, so concurrent verifies cannot all slip past a stale read (TOCTOU-safe); a code that has
 *     used its attempts is locked even with the right code;
 *   - verifies with argon2 (constant-time);
 *   - every failure mode bumps the per-email + per-IP throttle counters; a success does not;
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
 * Verify-attempt throttle (P1-1): a per-email AND per-IP failed-verify lockout that bounds brute force
 * ACROSS codes, beyond the per-code 3-attempt lock. Window is 15 minutes. Once an email accrues
 * OTP_VERIFY_EMAIL_FAIL_MAX failures (or an IP accrues OTP_VERIFY_IP_FAIL_MAX across any emails) in the
 * window, verification is locked and returns the generic unauthorized envelope. Only FAILED verifies
 * count; a success never consumes throttle budget.
 */
export const OTP_VERIFY_FAIL_WINDOW_SECONDS = 15 * 60
/** Failed verifies per email per window before OTP sign-in is locked for that email. */
export const OTP_VERIFY_EMAIL_FAIL_MAX = 10
/** Failed verifies per IP per window before OTP verification is locked from that network. */
export const OTP_VERIFY_IP_FAIL_MAX = 30

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
   * AppError for every failure mode: throttle lockout, no active code, locked (attempts exhausted), or
   * wrong code. `ip` drives the per-IP verify-failure throttle; pass null when unknown.
   */
  async verifyOtp(email: string, code: string, ip: string | null): Promise<string> {
    const normalized = email.trim().toLowerCase()
    const now = new Date(this.now())

    // OUTER bound (P1-1): per-email + per-IP failed-verify throttle. If either is already over its cap,
    // verification is locked - an attacker cannot keep guessing across newly-issued codes. Checked
    // BEFORE any per-code work (no argon2 hash is spent for a locked-out caller).
    if (await this.verifyThrottleTripped(normalized, ip)) {
      throw AppError.unauthorized("Too many attempts. Try again later.")
    }

    const record = await this.store.findLatestActive(normalized, now)
    if (!record) {
      await this.bumpVerifyFailure(normalized, ip)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    // INNER bound (P1-3, TOCTOU-safe): increment attempts FIRST and gate on the RETURNED count, so two
    // concurrent verifies cannot both read a stale pre-increment value and both slip past the ceiling.
    // The Nth attempt (1..MAX) is allowed to verify; once the count EXCEEDS MAX the code is locked.
    const attempts = await this.store.incrementAttempts(record.id)
    if (attempts > OTP_MAX_ATTEMPTS) {
      // Already exhausted by prior (possibly concurrent) attempts: lock it, even with the right code.
      await this.store.markConsumed(record.id, now)
      await this.bumpVerifyFailure(normalized, ip)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    const ok = await argonVerify(record.codeHash, code)
    if (!ok) {
      // This attempt consumed a slot; lock the code once the ceiling is reached.
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.store.markConsumed(record.id, now)
      }
      await this.bumpVerifyFailure(normalized, ip)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    // Success: single-use consume, then find-or-create the account. A verified OTP proves the email,
    // so a newly created account is marked email_verified. A success spends no throttle budget.
    await this.store.markConsumed(record.id, now)
    const existing = await this.users.findByEmail(normalized)
    if (existing) return existing.id
    const created = await this.users.create(normalized, {
      displayName: defaultDisplayName(normalized),
      role: "citizen",
      emailVerified: true,
    })
    return created.id
  }

  /**
   * Whether the per-email or per-IP failed-verify counter is already at/over its cap for the current
   * window. Reads (does not increment) so a legitimate verify is not itself penalized.
   */
  private async verifyThrottleTripped(normalizedEmail: string, ip: string | null): Promise<boolean> {
    const emailCount = await this.readCounter(`otp:vf:email:${normalizedEmail}`)
    if (emailCount >= OTP_VERIFY_EMAIL_FAIL_MAX) return true
    if (ip) {
      const ipCount = await this.readCounter(`otp:vf:ip:${ip}`)
      if (ipCount >= OTP_VERIFY_IP_FAIL_MAX) return true
    }
    return false
  }

  /** Increment the per-email + per-IP failed-verify counters (window-anchored on first hit). */
  private async bumpVerifyFailure(normalizedEmail: string, ip: string | null): Promise<void> {
    await this.cache.incr(`otp:vf:email:${normalizedEmail}`, OTP_VERIFY_FAIL_WINDOW_SECONDS)
    if (ip) {
      await this.cache.incr(`otp:vf:ip:${ip}`, OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
  }

  /** Read an integer counter from the cache (0 when absent / unparseable). */
  private async readCounter(key: string): Promise<number> {
    const raw = await this.cache.get(key)
    if (raw === null) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
}

/** Derive a friendly default display name from an email local-part (e.g. "jane.doe" -> "jane.doe"). */
function defaultDisplayName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "citizen"
}
