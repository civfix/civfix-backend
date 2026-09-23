import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2"
import { AppError } from "@civfix/shared"
import { constantTimeStringEqual, generateNumericCode } from "./crypto.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import type { CacheClient } from "./cache.js"
import type { OtpStore, UserStore } from "./stores.js"
import type { Mailer } from "@civfix/shared/interfaces"

export const OTP_CODE_LENGTH = 6
export const OTP_TTL_SECONDS = 5 * 60
export const OTP_MAX_ATTEMPTS = 3
export const OTP_EMAIL_WINDOW_SECONDS = 60
export const OTP_IP_WINDOW_SECONDS = 60 * 60
export const OTP_IP_MAX_PER_WINDOW = 10

export const OTP_VERIFY_FAIL_WINDOW_SECONDS = 15 * 60
export const OTP_VERIFY_CODE_FAIL_MAX = 5
export const OTP_VERIFY_IP_FAIL_MAX = 30

const ARGON2ID = 2

const ARGON_OPTS_FULL = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const

const ARGON_OPTS_TEST = {
  algorithm: ARGON2ID,
  memoryCost: 8,
  timeCost: 1,
  parallelism: 1,
} as const

export const ARGON_OPTS = process.env.NODE_ENV === "test" ? ARGON_OPTS_TEST : ARGON_OPTS_FULL

export function hashOtpCode(code: string): Promise<string> {
  return argonHash(code, ARGON_OPTS)
}

export function verifyOtpCode(codeHash: string, code: string): Promise<boolean> {
  return argonVerify(codeHash, code)
}

export const REVIEWER_OTP_EMAIL = "reviewer@civfix.org"
export const REVIEWER_HANDLE = "reviewer"
export const REVIEWER_DISPLAY_NAME = "Reviewer Reviewer"

export interface ReviewerOtpConfig {
  email: string
  code: string
}

export interface OtpLogger {
  warn(obj: unknown, msg?: string): void
}

type LocaleAwareMailer = Mailer & {
  sendOtp(to: string, code: string, locale?: string): Promise<void>
}

export interface OtpServiceOptions {
  store: OtpStore
  users: UserStore
  cache: CacheClient
  mailer: Mailer
  now?: () => number
  logger?: OtpLogger
  reviewer?: ReviewerOtpConfig
}

export interface IssueResult {
  resendAfterSec: number
}

export class OtpService {
  private readonly store: OtpStore
  private readonly users: UserStore
  private readonly cache: CacheClient
  private readonly mailer: LocaleAwareMailer
  private readonly now: () => number
  private readonly logger?: OtpLogger
  private readonly reviewer: ReviewerOtpConfig | null

  constructor(opts: OtpServiceOptions) {
    this.store = opts.store
    this.users = opts.users
    this.cache = opts.cache
    this.mailer = opts.mailer
    this.now = opts.now ?? Date.now
    this.logger = opts.logger
    this.reviewer = opts.reviewer
      ? { email: opts.reviewer.email.trim().toLowerCase(), code: opts.reviewer.code }
      : null
  }

  private isReviewerEmail(normalizedEmail: string): boolean {
    return this.reviewer !== null && normalizedEmail === this.reviewer.email
  }

  async issueOtp(email: string, ip: string | null): Promise<IssueResult> {
    const normalized = email.trim().toLowerCase()

    if (this.isReviewerEmail(normalized)) {
      return { resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }
    }

    const ipBucket = ip === null ? null : normalizeIp(ip)
    if (ipBucket) {
      const ipKey = `otp:rl:ip:${ipBucket}`
      const ipHits = await this.cache.incr(ipKey, OTP_IP_WINDOW_SECONDS)
      if (ipHits > OTP_IP_MAX_PER_WINDOW) {
        throw AppError.rateLimited("Too many code requests from this network.")
      }
    }

    const emailKey = emailCooldownKey(normalized)
    const emailHits = await this.cache.incr(emailKey, OTP_EMAIL_WINDOW_SECONDS)
    if (emailHits > 1) {
      throw AppError.rateLimited("Please wait before requesting another code.")
    }

    try {
      await this.store.invalidateActiveForEmail(normalized)
      const code = generateNumericCode(OTP_CODE_LENGTH)
      const codeHash = await hashOtpCode(code)
      await this.store.insert({
        email: normalized,
        codeHash,
        expiresAt: new Date(this.now() + OTP_TTL_SECONDS * 1000),
      })
      const account = await this.users.findByEmail(normalized)
      await this.mailer.sendOtp(normalized, code, account?.locale)
    } catch (err) {
      if (emailHits === 1) {
        await this.cache.del(emailKey).catch((delErr: unknown) => {
          this.logger?.warn(
            { err: delErr },
            "otp: failed to release per-email cooldown after issue error",
          )
        })
      }
      throw err
    }

    return { resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }
  }

  async verifyOtp(email: string, code: string, ip: string | null): Promise<string> {
    const normalized = email.trim().toLowerCase()
    const now = new Date(this.now())
    const ipBucket = ip === null ? null : normalizeIp(ip)

    if (await this.ipThrottleTripped(ipBucket)) {
      throw AppError.unauthorized("Too many attempts. Try again later.")
    }

    if (this.isReviewerEmail(normalized)) {
      if (this.reviewer !== null && constantTimeStringEqual(code, this.reviewer.code)) {
        return this.ensureReviewerUser(normalized)
      }
      await this.bumpVerifyFailure(null, ipBucket)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    const record = await this.store.findLatestActive(normalized, now)
    if (!record) {
      await this.bumpVerifyFailure(null, ipBucket)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    if ((await this.readCounter(codeFailKey(record.id))) >= OTP_VERIFY_CODE_FAIL_MAX) {
      await this.store.markConsumed(record.id, now)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    const attempts = await this.store.incrementAttempts(record.id)
    if (attempts > OTP_MAX_ATTEMPTS) {
      await this.store.markConsumed(record.id, now)
      await this.bumpVerifyFailure(record.id, ipBucket)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    const ok = await verifyOtpCode(record.codeHash, code)
    if (!ok) {
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.store.markConsumed(record.id, now)
      }
      await this.bumpVerifyFailure(record.id, ipBucket)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    const claimed = await this.store.markConsumed(record.id, now)
    if (!claimed) {
      throw AppError.unauthorized("Invalid or expired code.")
    }
    await this.cache.del(emailCooldownKey(normalized)).catch((err: unknown) => {
      this.logger?.warn(
        { err },
        "otp: failed to release per-email cooldown after successful verify",
      )
    })
    const existing = await this.users.findByEmail(normalized)
    if (existing) return existing.id
    const created = await this.users.create(normalized, {
      displayName: defaultDisplayName(normalized),
      role: "citizen",
      emailVerified: true,
    })
    return created.id
  }

  private async ensureReviewerUser(normalizedEmail: string): Promise<string> {
    const existing = await this.users.findByEmail(normalizedEmail)
    if (existing) return existing.id
    const created = await this.users.create(normalizedEmail, {
      displayName: REVIEWER_DISPLAY_NAME,
      role: "citizen",
      emailVerified: true,
      handle: REVIEWER_HANDLE,
      profileComplete: true,
    })
    return created.id
  }

  private async ipThrottleTripped(ip: string | null): Promise<boolean> {
    if (!ip) return false
    return (await this.readCounter(ipFailKey(ip))) >= OTP_VERIFY_IP_FAIL_MAX
  }

  private async bumpVerifyFailure(codeId: string | null, ip: string | null): Promise<void> {
    if (codeId !== null) {
      await this.cache.incr(codeFailKey(codeId), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
    if (ip) {
      await this.cache.incr(ipFailKey(ip), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
  }

  private async readCounter(key: string): Promise<number> {
    const raw = await this.cache.get(key)
    if (raw === null) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
}

function emailCooldownKey(normalizedEmail: string): string {
  return `otp:rl:email:${normalizedEmail}`
}

function codeFailKey(codeId: string): string {
  return `otp:vf:code:${codeId}`
}

function ipFailKey(ip: string): string {
  return `otp:vf:ip:${ip}`
}

function defaultDisplayName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "citizen"
}
