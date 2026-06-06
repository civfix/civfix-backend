import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { WriteAuditInput } from "../../src/services/admin/audit.js"
import type { Role } from "@civfix/shared"

/**
 * H3: behavioral authz + admin-login HTTP tests against the REAL Fastify stack (app.inject), wired with
 * in-memory auth (stores + cache + FakeMailer) + an ADMIN_EMAILS allowlist, no DB / no Docker. These
 * close the gap the review flagged: route-coverage only asserts routes are REGISTERED, never that the
 * guard returns 401/403 or that the OTP allowlist does not enumerate. We assert:
 *   - every /admin/* DATA route is 401 unauthenticated and 403 for a non-operator session, 200/handler
 *     for an operator;
 *   - POST /admin/auth/otp/request for a non-allowlisted email returns the SAME {sent:true,resendAfterSec}
 *     as an allowlisted one AND issues NO code (no enumeration, value + shape identical - M7);
 *   - POST /admin/auth/otp/verify rejects a non-allowlisted email (403, no session) even with a valid code;
 *   - a successful allowlisted verify grants operator + writes operator.login + issues a session.
 */

const ALLOWED = "ops@civfix.org"
const NOT_ALLOWED = "stranger@example.com"

interface Harness {
  app: FastifyInstance
  mailer: FakeMailer
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  /** Captured operator.login (and any other auth) audit rows (the injected sink). */
  audits: WriteAuditInput[]
}

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const services = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: `${ALLOWED}, OTHER@civfix.org` })
  const app = await buildServer({ env, authServices: services })
  const audits: WriteAuditInput[] = []
  // Capture the operator.login audit (the offline harness has no DB to write through).
  app.adminAuthOverrides = {
    auditSink: (input) => {
      audits.push(input)
      return Promise.resolve()
    },
  }
  return { app, mailer, services, stores, audits }
}

/** Seed a user with a role and mint a bearer session token for it (presented as Authorization: Bearer). */
async function sessionFor(h: Harness, role: Role): Promise<string> {
  const user = await h.stores.users.create(`${role}.${Date.now()}@example.com`, {
    displayName: role,
    role,
    emailVerified: true,
  })
  return h.services.sessions.createSession(user.id, [role])
}

let harness: Harness | undefined
afterEach(async () => {
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

// A representative spread of admin DATA routes across domains (GET, no body needed) + one mutation.
const DATA_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
  { method: "GET", url: "/admin/home/summary" },
  { method: "GET", url: "/admin/discovery" },
  { method: "GET", url: "/admin/jurisdictions" },
  { method: "GET", url: "/admin/reports" },
  { method: "GET", url: "/admin/events" },
  { method: "GET", url: "/admin/users" },
  { method: "GET", url: "/admin/moderation" },
  { method: "GET", url: "/admin/gov-claims" },
  { method: "GET", url: "/admin/mail" },
  { method: "GET", url: "/admin/analytics/kpis" },
  { method: "GET", url: "/admin/audit" },
  { method: "GET", url: "/admin/system/health" },
]

describe("H3: admin data routes are operator-gated", () => {
  it("returns 401 for EVERY admin data route when unauthenticated", async () => {
    harness = await makeHarness()
    for (const r of DATA_ROUTES) {
      const res = await harness.app.inject({ method: r.method, url: r.url })
      expect(res.statusCode, `${r.method} ${r.url} unauth`).toBe(401)
    }
  })

  it("returns 403 for EVERY admin data route for a non-operator (citizen) session", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "citizen")
    for (const r of DATA_ROUTES) {
      const res = await harness.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode, `${r.method} ${r.url} citizen`).toBe(403)
    }
  })

  it("an operator session passes the guard (not 401/403) on every admin data route", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator")
    for (const r of DATA_ROUTES) {
      const res = await harness.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: `Bearer ${token}` },
      })
      // The guard let it through: the status is NOT an auth rejection. (The handler may still 500 for a
      // read that needs Postgres in this offline harness; what matters here is the guard, not the data.)
      expect([401, 403], `${r.method} ${r.url} operator should pass guard`).not.toContain(
        res.statusCode,
      )
    }
  })
})

describe("M5: malformed :id path params are rejected as 400/422, not 500", () => {
  it("a non-uuid :id on an admin detail route is a typed validation error (not a 500)", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator")
    // These reach the handler (operator passed the guard); a non-uuid id must be caught by idParam
    // (AppError.validation -> 400) BEFORE the SQL layer, where a non-uuid would otherwise 500.
    for (const url of [
      "/admin/reports/not-a-uuid",
      "/admin/moderation/not-a-uuid",
      "/admin/events/not-a-uuid",
      "/admin/users/not-a-uuid",
      "/admin/gov-claims/not-a-uuid",
      "/admin/mail/not-a-uuid",
    ]) {
      const res = await harness.app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      })
      expect([400, 422], `${url} should be a validation error`).toContain(res.statusCode)
      expect(res.statusCode).not.toBe(500)
    }
  })
})

describe("H3 + M7: admin OTP request does not enumerate", () => {
  it("non-allowlisted and allowlisted requests return the SAME shape AND resendAfterSec", async () => {
    harness = await makeHarness()
    const allowed = await harness.app.inject({
      method: "POST",
      url: "/admin/auth/otp/request",
      payload: { email: ALLOWED },
    })
    const stranger = await harness.app.inject({
      method: "POST",
      url: "/admin/auth/otp/request",
      payload: { email: NOT_ALLOWED },
    })
    expect(allowed.statusCode).toBe(200)
    expect(stranger.statusCode).toBe(200)
    // Identical body: same keys AND same resendAfterSec value (the M7 tell - a constant 0 - is gone).
    expect(stranger.json()).toEqual(allowed.json())
    expect(allowed.json()).toMatchObject({ sent: true })

    // The allowlisted email got a real code; the stranger got NONE (no enumeration via a delivered code).
    expect(harness.mailer.lastOtpFor(ALLOWED)).toMatch(/^\d{6}$/)
    expect(harness.mailer.lastOtpFor(NOT_ALLOWED)).toBeUndefined()
    expect(harness.mailer.sent.filter((m) => m.to === NOT_ALLOWED)).toHaveLength(0)
  })
})

describe("H3: admin OTP verify enforces the allowlist + grants operator", () => {
  it("rejects a non-allowlisted email with 403, issues NO session, and creates NO user row (V2)", async () => {
    harness = await makeHarness()
    // Issue a real code for the stranger DIRECTLY via the OtpService (bypassing the request route, which
    // would not send one) so we exercise verify's own allowlist re-check (defense in depth).
    await harness.services.otp.issueOtp(NOT_ALLOWED, null)
    const code = harness.mailer.lastOtpFor(NOT_ALLOWED)
    expect(code).toMatch(/^\d{6}$/)

    // Sanity: no user exists for the stranger before verify (so a created row would be attributable here).
    expect(await harness.stores.users.findByEmail(NOT_ALLOWED)).toBeNull()

    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/auth/otp/verify",
      payload: { email: NOT_ALLOWED, code },
    })
    expect(res.statusCode).toBe(403)
    expect(res.headers["set-cookie"]).toBeUndefined() // no session issued
    expect(harness.audits).toHaveLength(0) // no operator.login audit
    // V2: the allowlist re-check runs BEFORE find-or-create, so a non-allowlisted verify (even with a
    // valid code) provisions NO bare user row.
    expect(await harness.stores.users.findByEmail(NOT_ALLOWED)).toBeNull()
  })

  it("a successful allowlisted verify grants operator, writes operator.login, and issues a session", async () => {
    harness = await makeHarness()
    // Request (issues a code to the allowlisted email) then verify.
    await harness.app.inject({
      method: "POST",
      url: "/admin/auth/otp/request",
      payload: { email: ALLOWED },
    })
    const code = harness.mailer.lastOtpFor(ALLOWED)
    const res = await harness.app.inject({
      method: "POST",
      url: "/admin/auth/otp/verify",
      payload: { email: ALLOWED, code },
    })
    expect(res.statusCode).toBe(200)
    // A web session cookie was set (the dashboard is a browser SPA).
    const setCookie = res.headers["set-cookie"]
    expect(setCookie).toBeDefined()
    expect(String(setCookie)).toContain("civfix_session=")
    // The returned operator + a CSRF token.
    const body = res.json()
    expect(body.user.role).toBe("operator")
    expect(typeof body.csrfToken).toBe("string")

    // The user was granted operator in the store (idempotent grant).
    const stored = await harness.stores.users.findByEmail(ALLOWED)
    expect(stored?.role).toBe("operator")

    // operator.login was audited.
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      action: "operator.login",
      target: `user:${stored?.id}`,
    })
  })
})
