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

/** A Mailer that throws on the first N sends (to simulate a transient SMTP hiccup), then succeeds. */
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

// The reviewer bypass: a known email + an ENVIRONMENT-SUPPLIED secret code that never mails/stores
// anything (App Review can sign in without a new mobile build). The code is deliberately a long random
// string here, not a memorable one — there is no fixed code in the product any more (C1), so a test that
// hard-coded "000000" would be re-encoding the very backdoor that was removed.
const REVIEWER_EMAIL = "reviewer@civfix.org"
const REVIEWER_CODE = "T2fZ8qsvXm4Ld9RbKcNw1yPu"
const REVIEWER = { email: REVIEWER_EMAIL, code: REVIEWER_CODE }

// Every OTP issue/verify pays a real argon2id hash (under NODE_ENV=test at the argon2 minimum cost —
// see ARGON_OPTS_TEST in src/auth/otp.ts; full 64 MiB / 3 passes everywhere else), and several tests
// here chain or fan out multiple of them concurrently. Under full-suite concurrency the vitest worker
// pool saturates the CPU, so a correct-but-starved run can exceed the default 5s per-test timeout and
// flip to a (flaky) failure. The assertions are all on BEHAVIOR (injected-clock windows, attempt
// ceilings), never on elapsed wall-clock, so a generous file-level timeout keeps the suite
// deterministic regardless of how loaded the host is.
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

/** Like makeOtp, but wires the reviewer-OTP bypass config into the service. */
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
    const mailer = new FlakyMailer(1) // first send throws, second succeeds
    const service = new OtpService({ store, users, cache, mailer, now })

    // First attempt: the mailer throws. The caller sees the error...
    await expect(service.issueOtp(EMAIL, IP)).rejects.toThrow()
    // ...but the per-email cooldown was rolled back, so it is NOT set.
    expect(await cache.get(`otp:rl:email:${EMAIL.toLowerCase()}`)).toBeNull()

    // An IMMEDIATE retry (same email, well within the 60s window) is allowed and succeeds - the user is
    // not stuck for 60s with no code. The second send delivers a real code.
    const res = await service.issueOtp(EMAIL, IP)
    expect(res.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)
    expect(mailer.sent.length).toBe(1)
    expect(mailer.sent[0]!.code).toMatch(/^\d{6}$/)

    // After a SUCCESSFUL issue the cooldown IS set, so a third immediate request is rate-limited.
    expect(await cache.get(`otp:rl:email:${EMAIL.toLowerCase()}`)).not.toBeNull()
    await expectAppError(service.issueOtp(EMAIL, IP), ErrorCode.RATE_LIMITED)
  })

  it("P1-7: a per-IP cap rejection does not burn the per-email window", async () => {
    const { service } = makeOtp()
    // Exhaust the per-IP cap with DISTINCT emails (so no per-email window is touched for `victim`).
    for (let i = 0; i < OTP_IP_MAX_PER_WINDOW; i++) {
      await service.issueOtp(`filler${i}@example.com`, IP)
    }
    // `victim` has never requested a code, but shares the (now-capped) IP. The request is IP-rate-limited.
    await expectAppError(service.issueOtp("victim@example.com", IP), ErrorCode.RATE_LIMITED)
    // Because the per-IP check runs BEFORE the per-email increment, victim's own per-email window was NOT
    // consumed: from a DIFFERENT IP (under the cap) they can immediately get a code.
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

  it("P1-4: two concurrent verifies for the same brand-new email resolve to the SAME user (no 500)", async () => {
    const { service, mailer, users } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const code = sentCode(mailer, EMAIL)

    // Fire two verifies concurrently. Both read the (unconsumed) code before either consumes it, both
    // verify the correct code, both find no existing user, and both attempt to create one. The
    // find-or-create must be idempotent on email: NEITHER throws a unique-violation 500, and BOTH resolve
    // to the same account (the duplicate INSERT is absorbed by ON CONFLICT (email) DO NOTHING + re-select).
    const [a, b] = await Promise.all([
      service.verifyOtp(EMAIL, code, IP),
      service.verifyOtp(EMAIL, code, IP),
    ])
    expect(a).toBe(b)
    const user = await users.findByEmail(EMAIL)
    expect(user).not.toBeNull()
    expect(user!.id).toBe(a)
  })

  it("P1-4: users.create is idempotent on email (concurrent create -> one row, same id)", async () => {
    // Direct proof of the primitive the fix relies on: two creates for the same email converge on one
    // row (mirrors the Pg store's ON CONFLICT (email) DO NOTHING + re-select).
    const { users } = makeOtp()
    const [u1, u2] = await Promise.all([
      users.create("dup@example.com", { displayName: "Dup One", emailVerified: true }),
      users.create("dup@example.com", { displayName: "Dup Two", emailVerified: true }),
    ])
    expect(u1.id).toBe(u2.id)
    // A null email never conflicts: two null-email creates are distinct rows.
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
    // The attacker (a different network, so the victim's own IP budget is untouched) fires far more wrong
    // guesses at the victim's ADDRESS than the old per-email lockout allowed. This is the whole DoS: it
    // costs the attacker nothing and needs no access to the mailbox.
    for (let i = 0; i < 20; i++) {
      await expectAppError(
        service.verifyOtp(EMAIL, "000000", "198.51.100.7"),
        ErrorCode.UNAUTHORIZED,
      )
    }

    // The legitimate owner requests a code and signs in immediately: the address is NOT a lockout key.
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

    // Pre-load the per-code counter to its cap (the cache-side backstop), then present the CORRECT code:
    // it is refused and the code is consumed, so this one issued code is dead...
    for (let i = 0; i < OTP_VERIFY_CODE_FAIL_MAX; i++) {
      await cache.incr(`otp:vf:code:${row.id}`, 900)
    }
    const err = await expectAppError(service.verifyOtp(EMAIL, code, IP), ErrorCode.UNAUTHORIZED)
    expect(err.message).toMatch(/Too many incorrect attempts/i)
    expect(store.all()[0]!.consumedAt).not.toBeNull()
    expect(wrong).not.toBe(code)

    // ...while the ACCOUNT is untouched: a newly-issued code verifies normally.
    advance(OTP_EMAIL_WINDOW_SECONDS * 1000 + 1) // clear the resend cooldown, not a lockout
    await service.issueOtp(EMAIL, null)
    const next = sentCode(mailer, EMAIL)
    expect(typeof (await service.verifyOtp(EMAIL, next, IP))).toBe("string")
  })

  it("locks by IP across DISTINCT emails after OTP_VERIFY_IP_FAIL_MAX failures", async () => {
    const { service } = makeOtp()
    // No active code for any of these emails -> each verify is a failure that burns IP budget. The
    // per-IP counter is the primary brute-force bound now that no counter is keyed on an address.
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
    const { service, store, mailer, cache } = makeOtp()
    await service.issueOtp(EMAIL, IP)
    const codeId = store.all()[0]!.id
    await service.verifyOtp(EMAIL, sentCode(mailer, EMAIL), IP)
    // No failed-verify counter was created for the code or the IP on the happy path.
    expect(await cache.get(`otp:vf:code:${codeId}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBeNull()
  })

  it("no throttle counter is ever keyed on an email address (L2 invariant)", async () => {
    const { service, cache } = makeOtp()
    for (let i = 0; i < 3; i++) {
      await expectAppError(service.verifyOtp(EMAIL, "000000", IP), ErrorCode.UNAUTHORIZED)
    }
    // The old key shape is gone: nothing an attacker sends can create a lockout aimed at an address.
    expect(await cache.get(`otp:vf:email:${EMAIL.toLowerCase()}`)).toBeNull()
    expect(await cache.get(`otp:vf:ip:${IP}`)).toBe("3")
  })
})

describe("OtpService reviewer-OTP bypass", () => {
  it("issueOtp for the reviewer email sends no email, stores no code, and is not rate-limited", async () => {
    const { service, store, mailer, cache } = makeReviewerOtp()
    const res1 = await service.issueOtp(REVIEWER_EMAIL, IP)
    expect(res1.resendAfterSec).toBe(OTP_EMAIL_WINDOW_SECONDS)
    // Nothing was mailed and nothing was persisted: the code is never sent or stored.
    expect(mailer.lastOtpFor(REVIEWER_EMAIL)).toBeUndefined()
    expect(store.all().length).toBe(0)
    // No per-email cooldown was consumed, so an immediate repeat request is NOT rate-limited.
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
    // The OTP store was never touched (no code was ever issued/consumed for the reviewer).
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
    // Burn the network's verify budget on unrelated addresses...
    for (let i = 0; i < OTP_VERIFY_IP_FAIL_MAX; i++) {
      await service.verifyOtp(`probe${i}@example.com`, "123456", IP).catch(() => {})
    }
    // ...and the reviewer credential is now refused from that network even though it is correct: the
    // bypass used to short-circuit ahead of every throttle, which made it the one unbounded credential.
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
    const { service, users } = makeOtp() // no reviewer config wired
    await expectAppError(service.verifyOtp(REVIEWER_EMAIL, REVIEWER_CODE, IP), ErrorCode.UNAUTHORIZED)
    expect(await users.findByEmail(REVIEWER_EMAIL)).toBeNull()
  })

  it("C1: the historic hardcoded code no longer signs anyone in", async () => {
    // The exact credential that was published in the README and compiled into the binary. It must be
    // just another wrong guess now, even with the bypass fully wired.
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
    // The old wiring tested `!== false`, so every one of these left the bypass ON in production.
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
