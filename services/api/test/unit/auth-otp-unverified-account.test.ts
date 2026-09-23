import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import {
  InMemoryOAuthIdentityStore,
  InMemoryOtpStore,
  InMemoryUserStore,
} from "../../src/auth/stores.js"
import { OtpService } from "../../src/auth/otp.js"
import type { WriteAuditInput } from "../../src/services/admin/audit.js"
import { bearer, makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

vi.setConfig({ testTimeout: 30_000 })

const OWNER_EMAIL = "owner@example.org"
const IP = "203.0.113.20"
const SUPPORT_EMAIL = "support@civfix.test"
const REFUSED_ACTION = "auth.otp_refused_unverified_account"
const NEEDS_REVIEW_MESSAGE = `This email address is linked to an account that needs a quick check before you can sign in. Contact support at ${SUPPORT_EMAIL} and we'll sort it out.`

function makeOtp(auditSink?: (input: WriteAuditInput) => Promise<void>) {
  const nowMs = 1_700_000_000_000
  const users = new InMemoryUserStore()
  const identities = new InMemoryOAuthIdentityStore()
  const mailer = new FakeMailer()
  const audits: WriteAuditInput[] = []
  const service = new OtpService({
    store: new InMemoryOtpStore(),
    users,
    identities,
    cache: new InMemoryCacheClient(() => nowMs),
    mailer,
    now: () => nowMs,
    supportEmail: SUPPORT_EMAIL,
    audit:
      auditSink ??
      ((input) => {
        audits.push(input)
        return Promise.resolve()
      }),
  })
  async function codeFor(email: string): Promise<string> {
    await service.issueOtp(email, IP)
    const code = mailer.lastOtpFor(email)
    if (!code) throw new Error(`no OTP mailed to ${email}`)
    return code
  }
  return { service, users, identities, audits, codeFor }
}

async function plantedAccount(users: InMemoryUserStore, identities: InMemoryOAuthIdentityStore) {
  const planted = await users.create(OWNER_EMAIL, {
    displayName: "Planted",
    role: "citizen",
    emailVerified: false,
  })
  await identities.linkIdentity(planted.id, "google", "attacker-sub")
  return planted
}

describe("email-code sign-in onto an unverified account that a provider identity holds", () => {
  it("refuses the sign-in, leaves the row and its identity alone and audits the refusal", async () => {
    const { service, users, identities, audits, codeFor } = makeOtp()
    const planted = await plantedAccount(users, identities)

    await expect(
      service.verifyOtp(OWNER_EMAIL, await codeFor(OWNER_EMAIL), IP),
    ).rejects.toMatchObject({ code: "CONFLICT", message: NEEDS_REVIEW_MESSAGE })

    expect(await users.findById(planted.id)).toMatchObject({
      email: OWNER_EMAIL,
      emailVerified: false,
      displayName: "Planted",
    })
    expect((await identities.findByProvider("google", "attacker-sub"))?.userId).toBe(planted.id)
    expect(audits).toEqual([
      {
        actorId: null,
        action: REFUSED_ACTION,
        target: `user:${planted.id}`,
        meta: { reason: "email_unverified_with_provider_identity" },
      },
    ])
    expect(JSON.stringify(audits)).not.toContain(OWNER_EMAIL)
  })

  it("still refuses when the audit write fails", async () => {
    const { service, users, identities, codeFor } = makeOtp(() =>
      Promise.reject(new Error("audit store unavailable")),
    )
    await plantedAccount(users, identities)

    await expect(
      service.verifyOtp(OWNER_EMAIL, await codeFor(OWNER_EMAIL), IP),
    ).rejects.toMatchObject({ code: "CONFLICT", message: NEEDS_REVIEW_MESSAGE })
  })

  it("keeps signing in an unverified account that no provider identity holds", async () => {
    const { service, users, audits, codeFor } = makeOtp()
    const legacy = await users.create(OWNER_EMAIL, {
      displayName: "Legacy",
      emailVerified: false,
    })

    expect(await service.verifyOtp(OWNER_EMAIL, await codeFor(OWNER_EMAIL), IP)).toBe(legacy.id)
    expect(audits).toEqual([])
  })

  it("keeps signing in a verified account that a provider identity holds", async () => {
    const { service, users, identities, audits, codeFor } = makeOtp()
    const owner = await users.create(OWNER_EMAIL, { displayName: "Owner", emailVerified: true })
    await identities.linkIdentity(owner.id, "google", "owner-sub")

    expect(await service.verifyOtp(OWNER_EMAIL, await codeFor(OWNER_EMAIL), IP)).toBe(owner.id)
    expect(audits).toEqual([])
  })

  it("still confirms the code for a caller already signed in to that account", async () => {
    const { service, users, identities, audits, codeFor } = makeOtp()
    const planted = await plantedAccount(users, identities)

    const confirmed = await service.verifyOtpForExistingAccount(
      OWNER_EMAIL,
      await codeFor(OWNER_EMAIL),
      IP,
    )

    expect(confirmed).toBe(planted.id)
    expect(audits).toEqual([])
  })
})

describe("POST /v1/auth/otp/verify onto an unverified account that a provider identity holds", () => {
  let h: AuthHarness | undefined
  afterEach(async () => {
    await h?.app.close()
    h = undefined
  })

  it("answers 409 and issues no session", async () => {
    h = await makeAuthHarness()
    const planted = await h.stores.users.create(OWNER_EMAIL, {
      displayName: "Planted",
      emailVerified: false,
    })
    await h.stores.oauth.linkIdentity(planted.id, "google", "attacker-sub")
    await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: OWNER_EMAIL },
    })

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email: OWNER_EMAIL, code: h.mailer.lastOtpFor(OWNER_EMAIL) },
    })

    expect(res.statusCode).toBe(409)
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(res.json()).not.toHaveProperty("token")
  })

  it("keeps letting the account's signed-in holder confirm a deletion with an email code", async () => {
    h = await makeAuthHarness()
    const planted = await h.stores.users.create(OWNER_EMAIL, {
      displayName: "Planted",
      emailVerified: false,
    })
    await h.stores.oauth.linkIdentity(planted.id, "google", "attacker-sub")
    const token = await h.services.sessions.createSession(planted.id, ["citizen"], {
      userAgent: null,
      ip: null,
    })
    await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: OWNER_EMAIL },
    })

    const res = await h.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: bearer(token),
      payload: { emailOtp: h.mailer.lastOtpFor(OWNER_EMAIL) },
    })

    expect(res.statusCode).toBe(200)
  })
})
