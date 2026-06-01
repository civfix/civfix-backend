import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { AppError, ErrorCode } from "@civfix/shared"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryOtpStore, InMemoryUserStore } from "../../src/auth/stores.js"
import {
  OtpService,
  OTP_TTL_SECONDS,
  OTP_EMAIL_WINDOW_SECONDS,
  OTP_IP_MAX_PER_WINDOW,
  OTP_MAX_ATTEMPTS,
  OTP_VERIFY_EMAIL_FAIL_MAX,
  OTP_VERIFY_IP_FAIL_MAX,
} from "../../src/auth/otp.js"

const EMAIL = "Jane.Doe@example.com"
const IP = "203.0.113.9"

function makeOtp(startMs = 1_700_000_000_000) {
  const clockRef = { value: startMs }
  const now = (): number => clockRef.value
  const store = new InMemoryOtpStore()
  const users = new InMemoryUserStore()
  const cache = new InMemoryCacheClient(now)
  const mailer = new FakeMailer()
  const service = new OtpService({ store, users, cache, mailer, now })
  return {
    service,
    store,
    users,
    cache,
    mailer,
    advance: (ms: number) => (clockRef.value += ms),
  }
}

/** Pull the code captured by the FakeMailer for an address (case-insensitively normalized). */
function sentCode(mailer: FakeMailer, email: string): string {
  const code = mailer.lastOtpFor(email.toLowerCase())
  if (!code) throw new Error(`no OTP captured for ${email}`)
  return code
}

async function expectAppError(p: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(code)
    return err as AppError
  }
  throw new Error(`expected AppError(${code}) but promise resolved`)
}

describe("OtpService.issueOtp", () => {
  it("issues a 6-digit code, stores only a hash, and mails the plaintext", async () => {
    const { service, store, mailer } = makeOtp()
    const res = await service.issueOtp(EMAIL, IP)
    expect(res.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)

    const code = sentCode(mailer, EMAIL)
    expect(code).toMatch(/^\d{6}$/)

    const rows = store.all()
    expect(rows.length).toBe(1)
    // The stored value is an argon2 hash, NOT the code.
    expect(rows[0]!.codeHash).not.toContain(code)
    expect(rows[0]!.codeHash.startsWith("$argon2id$")).toBe(true)
  })

  it("enforces the 1-per-60s per-email cooldown", async () => {
    const { service, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    // Immediate resend is rejected.
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
    // After the window passes it is allowed again.
    advance((OTP_EMAIL_WINDOW_SECONDS + 1) * 1000)
    await expect(service.issueOtp(EMAIL, IP)).resolves.toBeTruthy()
  })

  it("enforces the 10-per-hour per-IP cap across distinct emails", async () => {
    const { service } = makeOtp()
    // Use distinct emails so the per-email cooldown never trips; only the per-IP cap should.
    for (let i = 0; i < OTP_IP_MAX_PER_WINDOW; i++) {
      await expect(service.issueOtp(`user${i}@example.com`, IP)).resolves.toBeTruthy()
    }
    await expectAppError(service.issueOtp("overflow@example.com", IP), ErrorCode.RATE_LIMITED)
  })

  it("resend invalidates the prior unconsumed code", async () => {
    const { service, store, mailer, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const firstCode = sentCode(mailer, EMAIL)

    advance((OTP_EMAIL_WINDOW_SECONDS + 1) * 1000)
    await service.issueOtp(EMAIL, IP)

    // The old code can no longer be verified (superseded), but the new one can.
    await expectAppError(service.verifyOtp(EMAIL, firstCode, IP), ErrorCode.UNAUTHORIZED)
    // Exactly one active (unconsumed) row remains.
    const active = store.all().filter((r) => r.consumedAt === null)
    expect(active.length).toBe(1)
  })
})

describe("OtpService.verifyOtp", () => {
  it("accepts the correct code, is single-use, and find-or-creates the user", async () => {
    const { service, mailer, users } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)

    const userId = await service.verifyOtp(EMAIL, code, IP)
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    // The user was created with the citizen role.
    const user = await users.findById(userId)
    expect(user?.role).toBe("citizen")

    // Single-use: the same code cannot be redeemed twice.
    await expectAppError(service.verifyOtp(EMAIL, code, IP), ErrorCode.UNAUTHORIZED)
  })

  it("returns the same user for a repeat email sign-in (find-or-create)", async () => {
    const { service, mailer, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const id1 = await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)

    advance((OTP_EMAIL_WINDOW_SECONDS + 1) * 1000)
    mailer.reset()
    await service.issueOtp(EMAIL, IP)
    const id2 = await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)

    expect(id2).toBe(id1)
  })

  it("rejects a wrong code, increments attempts, and locks after 3 tries", async () => {
    const { service, store, mailer } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const correct = sentCode(mailer, EMAIL)
    const wrong = correct === "000000" ? "111111" : "000000"

    await expectAppError(service.verifyOtp(EMAIL, wrong, IP), ErrorCode.UNAUTHORIZED)
    await expectAppError(service.verifyOtp(EMAIL, wrong, IP), ErrorCode.UNAUTHORIZED)
    await expectAppError(service.verifyOtp(EMAIL, wrong, IP), ErrorCode.UNAUTHORIZED)

    // After 3 failed attempts the code is locked/consumed, so even the CORRECT code is rejected.
    await expectAppError(service.verifyOtp(EMAIL, correct, IP), ErrorCode.UNAUTHORIZED)

    const row = store.all()[0]!
    expect(row.attempts).toBeGreaterThanOrEqual(3)
    expect(row.consumedAt).not.toBeNull()
  })

  it("rejects an expired code", async () => {
    const { service, mailer, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)

    advance((OTP_TTL_SECONDS + 1) * 1000)
    await expectAppError(service.verifyOtp(EMAIL, code, IP), ErrorCode.UNAUTHORIZED)
  })

  it("rejects when there is no active code at all", async () => {
    const { service } = makeOtp()
    await expectAppError(
      service.verifyOtp("nobody@example.com", "123456", IP),
      ErrorCode.UNAUTHORIZED,
    )
  })
})

// ---------------------------------------------------------------------------
// P1-1: per-email + per-IP verify-failure throttle (brute-force lockout across codes)
// ---------------------------------------------------------------------------

describe("OtpService.verifyOtp throttle (P1-1)", () => {
  it("locks an email after OTP_VERIFY_EMAIL_FAIL_MAX failed verifies, even across fresh codes", async () => {
    const { service, mailer } = makeOtp()
    // Accrue per-email verify FAILURES. We use "no active code" verifies (fast: they skip argon2) - the
    // per-email throttle counter increments on EVERY failure mode, so this is the same cross-code bound
    // an attacker hits when churning codes. (A wrong-code path would also count but pays an argon2 verify
    // per try, which is needlessly slow for this assertion.)
    for (let i = 0; i < OTP_VERIFY_EMAIL_FAIL_MAX; i++) {
      await expectAppError(service.verifyOtp(EMAIL, "000000", IP), ErrorCode.UNAUTHORIZED)
    }

    // Now even the CORRECT code for a freshly-issued code is rejected: the email is locked out. (Proves
    // the throttle is a CROSS-CODE bound: a brand-new valid code cannot be used while the email is locked.)
    await service.issueOtp(EMAIL, null)
    const fresh = sentCode(mailer, EMAIL)
    const err = await expectAppError(service.verifyOtp(EMAIL, fresh, IP), ErrorCode.UNAUTHORIZED)
    expect(err.message).toMatch(/Too many attempts/i)
  })

  it("locks by IP across DISTINCT emails after OTP_VERIFY_IP_FAIL_MAX failures", async () => {
    const { service } = makeOtp()
    // No active code for any of these emails -> each verify is a failure that burns IP budget. Distinct
    // emails so the per-email cap never trips first; only the per-IP cap can lock.
    for (let i = 0; i < OTP_VERIFY_IP_FAIL_MAX; i++) {
      await service.verifyOtp(`probe${i}@example.com`, "123456", IP).catch(() => {})
    }
    // The next IP-bound verify (a different email) is locked by the per-IP throttle.
    const err = await expectAppError(
      service.verifyOtp("victim@example.com", "123456", IP),
      ErrorCode.UNAUTHORIZED,
    )
    expect(err.message).toMatch(/Too many attempts/i)
  })

  it("a successful verify does not consume throttle budget", async () => {
    const { service, mailer, cache } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)
    // No failed-verify counter was created for the email or the IP on the happy path.
    expect(await cache.get(`otp:vf:email:${EMAIL.toLowerCase()}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P1-3: concurrent verifies cannot bypass the 3-attempt ceiling (atomic attempts)
// ---------------------------------------------------------------------------

describe("OtpService.verifyOtp attempt ceiling is atomic (P1-3)", () => {
  it("fires K concurrent wrong guesses; the live code is still rejected and the code ends locked", async () => {
    const { service, store, mailer } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const correct = sentCode(mailer, EMAIL)
    const wrong = correct === "000000" ? "111111" : "000000"

    // 8 concurrent wrong verifies on attempts=0. The increment-then-gate path means at most MAX of them
    // can run argonVerify; all are rejected (the code is wrong) and the row is consumed at the ceiling.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.verifyOtp(EMAIL, wrong, IP)),
    )
    expect(results.every((r) => r.status === "rejected")).toBe(true)

    // The code is consumed (locked) and attempts advanced to at least the ceiling - it cannot be
    // brute-forced beyond MAX guesses by parallelism.
    const row = store.all()[0]!
    expect(row.consumedAt).not.toBeNull()
    expect(row.attempts).toBeGreaterThanOrEqual(OTP_MAX_ATTEMPTS)

    // Even the correct code no longer works (the single live code was locked by the burst).
    await expectAppError(service.verifyOtp(EMAIL, correct, IP), ErrorCode.UNAUTHORIZED)
  })

  it("increment-first gating: attempts is bumped on a wrong guess and surfaced atomically", async () => {
    // Direct proof of the atomic primitive the fix relies on: incrementAttempts returns the NEW value,
    // so two callers reading the SAME row get strictly increasing, distinct counts (never a stale tie).
    const { store } = makeOtp()
    const rec = await store.insert({
      email: "atomic@example.com",
      codeHash: "x",
      expiresAt: new Date(Date.now() + 60_000),
    })
    const [a, b, c] = await Promise.all([
      store.incrementAttempts(rec.id),
      store.incrementAttempts(rec.id),
      store.incrementAttempts(rec.id),
    ])
    expect(new Set([a, b, c]).size).toBe(3) // all distinct -> no lost update
    expect(Math.max(a, b, c)).toBe(3)
  })
})
