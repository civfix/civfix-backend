import { describe, it, expect, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Mailer } from "@civfix/shared/interfaces"
import { AppError, ErrorCode } from "@civfix/shared"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryOtpStore, InMemoryUserStore } from "../../src/auth/stores.js"
import {
  OtpService,
  OTP_TTL_SECONDS,
  OTP_EMAIL_WINDOW_SECONDS,
  OTP_IP_MAX_PER_WINDOW,
  OTP_MAX_ATTEMPTS,
  OTP_VERIFY_CODE_FAIL_MAX,
  OTP_VERIFY_IP_FAIL_MAX,
} from "../../src/auth/otp.js"
import {
  reviewerOtpConfigFromEnv,
  REVIEWER_OTP_MIN_CODE_LENGTH,
} from "../../src/auth/auth-services.js"
import type { Container } from "../../src/di.js"

class FlakyMailer implements Mailer {
  failures: number
  readonly sent: { to: string; code: string }[] = []
  constructor(failures: number) {
    this.failures = failures
  }
  sendOtp(to: string, code: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error("smtp down"))
    }
    this.sent.push({ to, code })
    return Promise.resolve()
  }
  sendTransactional(_to: string, _template: string, _vars: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
  sendOutbound(): Promise<{ messageId: string }> {
    return Promise.resolve({ messageId: "<flaky@civfix.test>" })
  }
}

const EMAIL = "Jane.Doe@example.com"
const IP = "203.0.113.9"

const REVIEWER_EMAIL = "reviewer@civfix.org"
const REVIEWER_CODE = "T2fZ8qsvXm4Ld9RbKcNw1yPu"
const REVIEWER = { email: REVIEWER_EMAIL, code: REVIEWER_CODE }

vi.setConfig({ testTimeout: 30_000 })

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

function makeReviewerOtp(startMs = 1_700_000_000_000) {
  const clockRef = { value: startMs }
  const now = (): number => clockRef.value
  const store = new InMemoryOtpStore()
  const users = new InMemoryUserStore()
  const cache = new InMemoryCacheClient(now)
  const mailer = new FakeMailer()
  const service = new OtpService({ store, users, cache, mailer, now, reviewer: REVIEWER })
  return { service, store, users, cache, mailer, advance: (ms: number) => (clockRef.value += ms) }
}

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
    expect(rows[0]!.codeHash).not.toContain(code)
    expect(rows[0]!.codeHash.startsWith("$argon2id$")).toBe(true)
  })

  it("enforces the 1-per-60s per-email cooldown", async () => {
    const { service, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
    advance((OTP_EMAIL_WINDOW_SECONDS + 1) * 1000)
    await expect(service.issueOtp(EMAIL, IP)).resolves.toBeTruthy()
  })

  it("enforces the 10-per-hour per-IP cap across distinct emails", async () => {
    const { service } = makeOtp()
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

    await expectAppError(service.verifyOtp(EMAIL, firstCode, IP), ErrorCode.UNAUTHORIZED)
    const active = store.all().filter((r) => r.consumedAt === null)
    expect(active.length).toBe(1)
  })

  it("P1-7: a mailer failure does NOT lock out a legitimate immediate retry (cooldown rolled back)", async () => {
    const clockRef = { value: 1_700_000_000_000 }
    const now = (): number => clockRef.value
    const store = new InMemoryOtpStore()
    const users = new InMemoryUserStore()
    const cache = new InMemoryCacheClient(now)
    const mailer = new FlakyMailer(1)
    const service = new OtpService({ store, users, cache, mailer, now })

    await expect(service.issueOtp(EMAIL, IP)).rejects.toThrow()
    expect(await cache.get(`otp:rl:email:${EMAIL.toLowerCase()}`)).toBeNull()

    const res = await service.issueOtp(EMAIL, IP)
    expect(res.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)
    expect(mailer.sent.length).toBe(1)
    expect(mailer.sent[0]!.code).toMatch(/^\d{6}$/)

    expect(await cache.get(`otp:rl:email:${EMAIL.toLowerCase()}`)).not.toBeNull()
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
  })

  it("G17: a successful verify RELEASES the per-email cooldown (deletion can request a code at once)", async () => {
    const { service, cache, mailer } = makeOtp()
    const key = `otp:rl:email:${EMAIL.toLowerCase()}`

    await service.issueOtp(EMAIL, IP)
    expect(await cache.get(key)).not.toBeNull()
    await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)
    expect(await cache.get(key)).toBeNull()

    await expect(service.issueOtp(EMAIL, IP)).resolves.toBeTruthy()
    const codes = mailer.sent.filter((m) => m.to === EMAIL.toLowerCase() && m.code !== undefined)
    expect(codes).toHaveLength(2)
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
  })

  it("G17: a FAILED verify does not release the cooldown (no inbox proof, no extra mail)", async () => {
    const { service, cache, mailer } = makeOtp()
    const key = `otp:rl:email:${EMAIL.toLowerCase()}`
    await service.issueOtp(EMAIL, IP)
    const real = sentCode(mailer, EMAIL)
    const wrong = real === "123456" ? "654321" : "123456"

    await expectAppError(service.verifyOtp(EMAIL, wrong, IP), ErrorCode.UNAUTHORIZED)
    expect(await cache.get(key)).not.toBeNull()
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
  })

  it("P1-7: a per-IP cap rejection does not burn the per-email window", async () => {
    const { service } = makeOtp()
    for (let i = 0; i < OTP_IP_MAX_PER_WINDOW; i++) {
      await service.issueOtp(`filler${i}@example.com`, IP)
    }
    await expectAppError(service.issueOtp("victim@example.com", IP), ErrorCode.RATE_LIMITED)
    await expect(service.issueOtp("victim@example.com", "198.51.100.7")).resolves.toBeTruthy()
  })
})

describe("OtpService.verifyOtp", () => {
  it("accepts the correct code, is single-use, and find-or-creates the user", async () => {
    const { service, mailer, users } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)

    const userId = await service.verifyOtp(EMAIL, code, IP)
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    const user = await users.findById(userId)
    expect(user?.role).toBe("citizen")

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

  it("P1-4: two concurrent verifies of one code -> exactly ONE winner, the loser gets a clean 401 (no 500, no duplicate user)", async () => {
    const { service, mailer, users, store, cache } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)
    const row = store.all()[0]!
    const createSpy = vi.spyOn(users, "create")

    const results = await Promise.allSettled([
      service.verifyOtp(EMAIL, code, IP),
      service.verifyOtp(EMAIL, code, IP),
    ])
    const won = results.filter((r) => r.status === "fulfilled")
    const lost = results.filter((r) => r.status === "rejected")
    expect(won.length).toBe(1)
    expect(lost.length).toBe(1)

    expect(row.attempts).toBe(2)

    const err = (lost[0] as PromiseRejectedResult).reason
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(ErrorCode.UNAUTHORIZED)
    expect((err as AppError).httpStatus).toBe(401)
    expect((err as AppError).message).toBe("Invalid or expired code.")

    const userId = (won[0] as PromiseFulfilledResult<string>).value
    expect(createSpy).toHaveBeenCalledTimes(1)
    const user = await users.findByEmail(EMAIL)
    expect(user).not.toBeNull()
    expect(user!.id).toBe(userId)
    expect(user!.emailVerified).toBe(true)

    expect(store.all().filter((r) => r.consumedAt === null).length).toBe(0)
    expect(await cache.get(`otp:vf:code:${row.id}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBeNull()
  })

  it("P1-4: users.create is idempotent on email (concurrent create -> one row, same id)", async () => {
    const { users } = makeOtp()
    const [u1, u2] = await Promise.all([
      users.create("dup@example.com", { displayName: "Dup One", emailVerified: true }),
      users.create("dup@example.com", { displayName: "Dup Two", emailVerified: true }),
    ])
    expect(u1.id).toBe(u2.id)
    const [n1, n2] = await Promise.all([
      users.create(null, { displayName: "No Email A" }),
      users.create(null, { displayName: "No Email B" }),
    ])
    expect(n1.id).not.toBe(n2.id)
  })
})

describe("OtpService.verifyOtp throttle (P1-1)", () => {
  it("L2: wrong guesses from an ATTACKER do NOT lock the owner out of a freshly-issued code", async () => {
    const { service, mailer } = makeOtp()
    for (let i = 0; i < 20; i++) {
      await expectAppError(
        service.verifyOtp(EMAIL, "000000", "198.51.100.7"),
        ErrorCode.UNAUTHORIZED,
      )
    }

    await service.issueOtp(EMAIL, null)
    const fresh = sentCode(mailer, EMAIL)
    const userId = await service.verifyOtp(EMAIL, fresh, IP)
    expect(typeof userId).toBe("string")
  })

  it("L2: failures still lock the SPECIFIC code they were aimed at", async () => {
    const { service, store, mailer, cache, advance } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)
    const wrong = code === "000000" ? "111111" : "000000"
    const row = store.all()[0]!

    for (let i = 0; i < OTP_VERIFY_CODE_FAIL_MAX; i++) {
      await cache.incr(`otp:vf:code:${row.id}`, 900)
    }
    const err = await expectAppError(service.verifyOtp(EMAIL, code, IP), ErrorCode.UNAUTHORIZED)
    expect(err.message).toMatch(/Too many incorrect attempts/i)
    expect(store.all()[0]!.consumedAt).not.toBeNull()
    expect(wrong).not.toBe(code)

    advance(OTP_EMAIL_WINDOW_SECONDS * 1000 + 1)
    await service.issueOtp(EMAIL, null)
    const next = sentCode(mailer, EMAIL)
    expect(typeof (await service.verifyOtp(EMAIL, next, IP))).toBe("string")
  })

  it("locks by IP across DISTINCT emails after OTP_VERIFY_IP_FAIL_MAX failures", async () => {
    const { service } = makeOtp()
    for (let i = 0; i < OTP_VERIFY_IP_FAIL_MAX; i++) {
      await service.verifyOtp(`probe${i}@example.com`, "123456", IP).catch(() => {})
    }
    const err = await expectAppError(
      service.verifyOtp("victim@example.com", "123456", IP),
      ErrorCode.UNAUTHORIZED,
    )
    expect(err.message).toMatch(/Too many attempts/i)
  })

  it("a successful verify does not consume throttle budget", async () => {
    const { service, store, mailer, cache } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const codeId = store.all()[0]!.id
    await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)
    expect(await cache.get(`otp:vf:code:${codeId}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBeNull()
  })

  it("no throttle counter is ever keyed on an email address (L2 invariant)", async () => {
    const { service, cache } = makeOtp()
    for (let i = 0; i < 3; i++) {
      await expectAppError(service.verifyOtp(EMAIL, "000000", IP), ErrorCode.UNAUTHORIZED)
    }
    expect(await cache.get(`otp:vf:email:${EMAIL.toLowerCase()}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBe("3")
  })
})

describe("OtpService reviewer-OTP bypass", () => {
  it("issueOtp for the reviewer email sends no email, stores no code, and is not rate-limited", async () => {
    const { service, store, mailer, cache } = makeReviewerOtp()
    const res1 = await service.issueOtp(REVIEWER_EMAIL, IP)
    expect(res1.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)
    expect(mailer.lastOtpFor(REVIEWER_EMAIL)).toBeUndefined()
    expect(store.all().length).toBe(0)
    expect(await cache.get(`otp:rl:email:${REVIEWER_EMAIL}`)).toBeNull()
    const res2 = await service.issueOtp(REVIEWER_EMAIL, IP)
    expect(res2.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)
  })

  it("verifyOtp with the reviewer code creates a fully set-up citizen account", async () => {
    const { service, users, store } = makeReviewerOtp()
    const userId = await service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP)
    const user = await users.findById(userId)
    expect(user).not.toBeNull()
    expect(user!.email).toBe(REVIEWER_EMAIL)
    expect(user!.emailVerified).toBe(true)
    expect(user!.handle).toBe("reviewer")
    expect(user!.displayName).toBe("Reviewer Reviewer")
    expect(user!.profileComplete).toBe(true)
    expect(user!.role).toBe("citizen")
    expect(store.all().length).toBe(0)
  })

  it("verifyOtp is idempotent for the reviewer (same account on repeat sign-in)", async () => {
    const { service, users } = makeReviewerOtp()
    const id1 = await service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP)
    const id2 = await service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP)
    expect(id2).toBe(id1)
    expect(await users.findByEmail(REVIEWER_EMAIL)).not.toBeNull()
  })

  it("verifyOtp rejects a wrong code for the reviewer and creates no account", async () => {
    const { service, users } = makeReviewerOtp()
    await expectAppError(service.verifyOtp(REVIEWER_EMAIL, "123456", IP), ErrorCode.UNAUTHORIZED)
    expect(await users.findByEmail(REVIEWER_EMAIL)).toBeNull()
  })

  it("C1: a wrong reviewer guess SPENDS throttle budget (the bypass is not un-rate-limited)", async () => {
    const { service, cache } = makeReviewerOtp()
    await expectAppError(service.verifyOtp(REVIEWER_EMAIL, "123456", IP), ErrorCode.UNAUTHORIZED)
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBe("1")
  })

  it("C1: the reviewer path is BEHIND the per-IP throttle, so it cannot be ground down", async () => {
    const { service, users } = makeReviewerOtp()
    for (let i = 0; i < OTP_VERIFY_IP_FAIL_MAX; i++) {
      await service.verifyOtp(`probe${i}@example.com`, "123456", IP).catch(() => {})
    }
    const err = await expectAppError(
      service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP),
      ErrorCode.UNAUTHORIZED,
    )
    expect(err.message).toMatch(/Too many attempts/i)
    expect(await users.findByEmail(REVIEWER_EMAIL)).toBeNull()
  })

  it("the reviewer code does NOT grant access to any other email", async () => {
    const { service, users } = makeReviewerOtp()
    await expectAppError(
      service.verifyOtp("someoneelse@example.com", REVIEWER_CODE, IP),
      ErrorCode.UNAUTHORIZED,
    )
    expect(await users.findByEmail("someoneelse@example.com")).toBeNull()
  })

  it("matches the reviewer email case-insensitively", async () => {
    const { service, users } = makeReviewerOtp()
    const id = await service.verifyOtp("Reviewer@CivFix.org", REVIEWER_CODE, IP)
    const user = await users.findById(id)
    expect(user!.handle).toBe("reviewer")
    expect(user!.email).toBe(REVIEWER_EMAIL)
  })

  it("when the bypass is NOT configured, the reviewer email behaves like a normal email", async () => {
    const { service, users } = makeOtp()
    await expectAppError(
      service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP),
      ErrorCode.UNAUTHORIZED,
    )
    expect(await users.findByEmail(REVIEWER_EMAIL)).toBeNull()
  })

  it("C1: the historic hardcoded code no longer signs anyone in", async () => {
    const { service, users } = makeReviewerOtp()
    await expectAppError(service.verifyOtp(REVIEWER_EMAIL, "000000", IP), ErrorCode.UNAUTHORIZED)
    expect(await users.findByEmail(REVIEWER_EMAIL)).toBeNull()
  })
})

describe("reviewerOtpConfigFromEnv (C1 wiring)", () => {
  const longCode = "T2fZ8qsvXm4Ld9RbKcNw1yPu"
  const envWith = (extra: Record<string, unknown>): Container["env"] =>
    ({ REVIEWER_OTP_BYPASS: true, ...extra }) as unknown as Container["env"]

  it("wires the bypass ONLY with an explicit true flag AND a long env-supplied code", () => {
    const cfg = reviewerOtpConfigFromEnv(envWith({ REVIEWER_OTP_CODE: longCode }))
    expect(cfg).toEqual({ email: "reviewer@civfix.org", code: longCode })
    expect(cfg!.code.length).toBeGreaterThanOrEqual(REVIEWER_OTP_MIN_CODE_LENGTH)
  })

  it("refuses to wire anything when the flag is not EXPLICITLY true", () => {
    for (const flag of [undefined, null, "true", "1", 1, "yes"]) {
      expect(
        reviewerOtpConfigFromEnv({
          REVIEWER_OTP_BYPASS: flag,
          REVIEWER_OTP_CODE: longCode,
        } as unknown as Container["env"]),
      ).toBeNull()
    }
  })

  it("refuses to wire anything when the code is missing, empty, or too short to be a secret", () => {
    expect(reviewerOtpConfigFromEnv(envWith({}))).toBeNull()
    expect(reviewerOtpConfigFromEnv(envWith({ REVIEWER_OTP_CODE: "" }))).toBeNull()
    expect(reviewerOtpConfigFromEnv(envWith({ REVIEWER_OTP_CODE: "000000" }))).toBeNull()
    expect(reviewerOtpConfigFromEnv(envWith({ REVIEWER_OTP_CODE: "a".repeat(19) }))).toBeNull()
    expect(reviewerOtpConfigFromEnv(envWith({ REVIEWER_OTP_CODE: 1234567890 }))).toBeNull()
  })
})

describe("OtpService.verifyOtp attempt ceiling is atomic (P1-3)", () => {
  it("fires K concurrent wrong guesses; the live code is still rejected and the code ends locked", async () => {
    const { service, store, mailer } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const correct = sentCode(mailer, EMAIL)
    const wrong = correct === "000000" ? "111111" : "000000"

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.verifyOtp(EMAIL, wrong, IP)),
    )
    expect(results.every((r) => r.status === "rejected")).toBe(true)

    const row = store.all()[0]!
    expect(row.consumedAt).not.toBeNull()
    expect(row.attempts).toBeGreaterThanOrEqual(OTP_MAX_ATTEMPTS)

    await expectAppError(service.verifyOtp(EMAIL, correct, IP), ErrorCode.UNAUTHORIZED)
  })

  it("increment-first gating: attempts is bumped on a wrong guess and surfaced atomically", async () => {
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
    expect(new Set([a, b, c]).size).toBe(3)
    expect(Math.max(a, b, c)).toBe(3)
  })
})

describe("OTP per-IP counters normalize IPv6 to the /64 (F004)", () => {
  const IPV6_A = "2001:db8:0:1::a"
  const IPV6_B = "2001:db8:0:1::b"

  it("two addresses in one /64 share the issuance cap", async () => {
    const { service } = makeOtp()
    for (let i = 0; i < OTP_IP_MAX_PER_WINDOW; i++) {
      await service.issueOtp(`user${i}@example.com`, i % 2 === 0 ? IPV6_A : IPV6_B)
    }
    await expectAppError(service.issueOtp("overflow@example.com", IPV6_B), ErrorCode.RATE_LIMITED)
  })

  it("two addresses in one /64 share the verify-failure throttle", async () => {
    const { service } = makeOtp()
    for (let i = 0; i < OTP_VERIFY_IP_FAIL_MAX; i++) {
      await expectAppError(
        service.verifyOtp(`v${i}@example.com`, "000000", i % 2 === 0 ? IPV6_A : IPV6_B),
        ErrorCode.UNAUTHORIZED,
      )
    }
    const err = await expectAppError(
      service.verifyOtp("locked@example.com", "000000", IPV6_A),
      ErrorCode.UNAUTHORIZED,
    )
    expect(err.message).toMatch(/too many attempts/i)
  })
})
