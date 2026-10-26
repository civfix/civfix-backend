import { describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/seams"
import { AppError } from "@civfix/contract"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  InMemoryOAuthIdentityStore,
  InMemoryOtpStore,
  InMemoryUserStore,
  type UserRecord,
} from "../../src/auth/stores.js"
import {
  OTP_VERIFY_IP_FAIL_MAX,
  OtpService,
  type DevTestOtpConfig,
  type ReviewerOtpConfig,
} from "../../src/auth/otp.js"
import { devTestOtpConfigFromEnv } from "../../src/auth/auth-services.js"
import { loadEnv } from "../../src/env.js"

vi.setConfig({ testTimeout: 30_000 })

const CODE = "Qm7vT2xRk9LpW4sZc8NbY3hD"
const REVIEWER_CODE = "T2fZ8qsvXm4Ld9RbKcNw1yPu"
const REVIEWER: ReviewerOtpConfig = { email: "reviewer@civfix.org", code: REVIEWER_CODE }
const TESTER_EMAIL = "tester@civfix.org"
const NEW_TESTER_EMAIL = "new.tester@civfix.org"
const IP = "203.0.113.9"
const IP_FAIL_KEY = `otp:vf:ip:${IP}`
const INVALID = "Invalid or expired code."

const TEST_ACCOUNTS: DevTestOtpConfig = { emails: [TESTER_EMAIL, NEW_TESTER_EMAIL], code: CODE }

const DEV_TOOLS_ON_ENV = {
  NODE_ENV: "test",
  CIVFIX_ENV: "staging",
  DEV_TOOLS_ENABLED: "true",
  ADMIN_EMAILS: "o@civfix.org,p@civfix.org",
  DEV_TEST_EMAILS: "Tester@civfix.org,new.tester@civfix.org",
  DEV_TEST_OTP_CODE: CODE,
}
const { DEV_TOOLS_ENABLED: _on, ...DEV_TOOLS_OFF_ENV } = DEV_TOOLS_ON_ENV

interface Harness {
  service: OtpService
  users: InMemoryUserStore
  otps: InMemoryOtpStore
  cache: InMemoryCacheClient
  mailer: FakeMailer
  tester: UserRecord
}

async function harness(
  opts: {
    testAccounts?: DevTestOtpConfig | null
    reviewer?: ReviewerOtpConfig
    testerRole?: "citizen" | "operator"
  } = {},
): Promise<Harness> {
  const now = (): number => 1_800_000_000_000
  const users = new InMemoryUserStore()
  const otps = new InMemoryOtpStore()
  const cache = new InMemoryCacheClient(now)
  const mailer = new FakeMailer()
  const testAccounts = opts.testAccounts === undefined ? TEST_ACCOUNTS : opts.testAccounts
  const service = new OtpService({
    store: otps,
    users,
    identities: new InMemoryOAuthIdentityStore(),
    cache,
    mailer,
    now,
    ...(testAccounts !== null ? { testAccounts } : {}),
    ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
  })
  const tester = await users.create(TESTER_EMAIL, {
    displayName: "Tester",
    role: opts.testerRole ?? "citizen",
    emailVerified: true,
    handle: "tester",
    profileComplete: true,
  })
  return { service, users, otps, cache, mailer, tester }
}

async function ipFailures(h: Harness): Promise<number> {
  return Number.parseInt((await h.cache.get(IP_FAIL_KEY)) ?? "0", 10)
}

async function expectUnauthorized(promise: Promise<unknown>, message: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(AppError)
  expect((err as AppError).httpStatus).toBe(401)
  expect((err as AppError).code).toBe("UNAUTHORIZED")
  expect((err as AppError).message).toBe(message)
}

async function expectNewTester(h: Harness, id: string, handle: string): Promise<void> {
  const created = await h.users.findById(id)
  expect(created).toMatchObject({
    email: NEW_TESTER_EMAIL,
    role: "citizen",
    emailVerified: true,
    profileComplete: false,
    handle,
  })
}

describe("test-account sign-in: issueOtp", () => {
  it("T32: a test address gets no email and no stored code", async () => {
    const h = await harness()
    expect(await h.service.issueOtp("Tester@civfix.org", IP)).toEqual({ resendAfterSec: 60 })
    expect(h.mailer.sent).toEqual([])
    expect(h.otps.all()).toEqual([])
  })
})

describe("test-account sign-in: verifyOtp", () => {
  it("T33: a listed address with no account gets a new citizen that goes through first run", async () => {
    const h = await harness()
    const id = await h.service.verifyOtp(NEW_TESTER_EMAIL, CODE, IP)
    expect(id).not.toBe(h.tester.id)
    await expectNewTester(h, id, "new_tester")
  })

  it("T34: a taken handle gets the next free suffix", async () => {
    const h = await harness()
    for (const handle of ["new_tester", "new_tester_2"]) {
      await h.users.create(`${handle}@example.com`, { displayName: handle, handle })
    }
    const id = await h.service.verifyOtp(NEW_TESTER_EMAIL, CODE, IP)
    await expectNewTester(h, id, "new_tester_3")
  })

  it("T35: a reserved handle counts as taken", async () => {
    const h = await harness({
      testAccounts: { emails: [...TEST_ACCOUNTS.emails, "support@civfix.org"], code: CODE },
    })
    const id = await h.service.verifyOtp("support@civfix.org", CODE, IP)
    expect((await h.users.findById(id))?.handle).toBe("support_2")
  })

  it("T45: a base shorter than 3 counts as taken", async () => {
    const h = await harness({
      testAccounts: {
        emails: [...TEST_ACCOUNTS.emails, "qa@civfix.org", "q@civfix.org"],
        code: CODE,
      },
    })
    const qa = await h.service.verifyOtp("qa@civfix.org", CODE, IP)
    const q = await h.service.verifyOtp("q@civfix.org", CODE, IP)
    expect((await h.users.findById(qa))?.handle).toBe("qa_2")
    expect((await h.users.findById(q))?.handle).toBe("q_2")
  })

  it("T36: an existing citizen signs in unchanged", async () => {
    const h = await harness()
    const create = vi.spyOn(h.users, "create")
    expect(await h.service.verifyOtp(" TESTER@civfix.org ", CODE, IP)).toBe(h.tester.id)
    expect(create).not.toHaveBeenCalled()
    expect(await h.users.findById(h.tester.id)).toEqual(h.tester)
  })

  it("T37: an existing account that is not a citizen is refused like a wrong code", async () => {
    const h = await harness({ testerRole: "operator" })
    await expectUnauthorized(h.service.verifyOtp(TESTER_EMAIL, CODE, IP), INVALID)
    expect(await ipFailures(h)).toBe(1)
  })

  it("T38: a wrong code is refused and creates nothing", async () => {
    const h = await harness()
    const create = vi.spyOn(h.users, "create")
    await expectUnauthorized(h.service.verifyOtp(TESTER_EMAIL, "not-the-code", IP), INVALID)
    expect(create).not.toHaveBeenCalled()
    expect(await ipFailures(h)).toBe(1)
  })

  it("T39: the per-IP verify throttle applies to the test code", async () => {
    const h = await harness()
    await h.cache.set(IP_FAIL_KEY, String(OTP_VERIFY_IP_FAIL_MAX), 900)
    expect(OTP_VERIFY_IP_FAIL_MAX).toBe(30)
    await expectUnauthorized(
      h.service.verifyOtp(TESTER_EMAIL, CODE, IP),
      "Too many attempts. Try again later.",
    )
  })

  it("T40: the reviewer bypass changes nothing for test accounts", async () => {
    for (const reviewer of [undefined, REVIEWER]) {
      const h = await harness(reviewer !== undefined ? { reviewer } : {})
      const id = await h.service.verifyOtp(NEW_TESTER_EMAIL, CODE, IP)
      await expectNewTester(h, id, "new_tester")
      const create = vi.spyOn(h.users, "create")
      expect(await h.service.verifyOtp(" TESTER@civfix.org ", CODE, IP)).toBe(h.tester.id)
      expect(create).not.toHaveBeenCalled()
    }
  })

  it("T41: with dev tools off a test address gets a normal emailed code", async () => {
    const config = devTestOtpConfigFromEnv(loadEnv(DEV_TOOLS_OFF_ENV))
    const h = await harness({ testAccounts: config })
    await h.service.issueOtp(TESTER_EMAIL, IP)
    expect(h.mailer.sent).toHaveLength(1)
    const mailed = h.mailer.sent[0]!
    expect(mailed.to).toBe(TESTER_EMAIL)
    expect(mailed.code).toMatch(/^\d{6}$/)
    await expectUnauthorized(h.service.verifyOtp(TESTER_EMAIL, CODE, IP), INVALID)
    expect(await h.service.verifyOtp(TESTER_EMAIL, mailed.code!, IP)).toBe(h.tester.id)
  })

  it("T42: the reviewer signs in as today and the two codes never cross", async () => {
    const h = await harness({ reviewer: REVIEWER })
    const reviewerId = await h.service.verifyOtp("reviewer@civfix.org", REVIEWER_CODE, IP)
    expect(await h.users.findById(reviewerId)).toMatchObject({
      handle: "reviewer",
      profileComplete: true,
    })
    await expectUnauthorized(h.service.verifyOtp("reviewer@civfix.org", CODE, IP), INVALID)
    await expectUnauthorized(h.service.verifyOtp(TESTER_EMAIL, REVIEWER_CODE, IP), INVALID)
  })
})

describe("test-account sign-in: verifyOtpForExistingAccount", () => {
  it("T43: the test code proves the inbox for a citizen, not for another role", async () => {
    const h = await harness()
    expect(await h.service.verifyOtpForExistingAccount(TESTER_EMAIL, CODE, IP)).toBe(h.tester.id)
    await h.users.setRole(h.tester.id, "operator")
    await expectUnauthorized(h.service.verifyOtpForExistingAccount(TESTER_EMAIL, CODE, IP), INVALID)
  })
})

describe("devTestOtpConfigFromEnv", () => {
  it("T44: the test accounts and their code when dev tools are on, else null", () => {
    expect(devTestOtpConfigFromEnv(loadEnv(DEV_TOOLS_ON_ENV))).toEqual({
      emails: [TESTER_EMAIL, NEW_TESTER_EMAIL],
      code: CODE,
    })
    expect(devTestOtpConfigFromEnv(loadEnv(DEV_TOOLS_OFF_ENV))).toBe(null)
  })
})
