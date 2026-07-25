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
import type { AccessIdentity, VerifyAccessJwt } from "../../src/auth/cf-access.js"
import type { Role } from "@civfix/shared"

/**
 * H3: behavioral authz + admin Cloudflare Access exchange HTTP tests against the REAL Fastify stack
 * (app.inject), wired with in-memory auth (stores + cache + FakeMailer) + an ADMIN_EMAILS allowlist, no
 * DB / no Docker. These close the gap route-coverage leaves (it only asserts routes are REGISTERED, never
 * that the guard returns 401/403 or that the Access exchange enforces the allowlist). We assert:
 *   - every /admin/* DATA route is 401 unauthenticated and 403 for a non-operator session, 200/handler
 *     for an operator;
 *   - POST /admin/auth/access/exchange with a valid Access JWT for an allowlisted email mints an operator
 *     session + writes operator.login (meta.via = "cf-access");
 *   - it is 403 for a verified-but-non-allowlisted email (no session, no user row), 401 for a
 *     missing/invalid JWT, and 503 when Cloudflare Access is not configured.
 * The real Cloudflare Access verifier (cf-access.ts) is unit-tested separately with a local keypair; here
 * it is substituted via the adminAuthOverrides.verifyAccessJwt test seam so the route runs offline.
 */

const ALLOWED = "ops@civfix.org"
const NOT_ALLOWED = "stranger@example.com"

/** A stub Access verifier: returns the given identity, or throws (simulating an invalid/forged token). */
function fakeVerifier(result: AccessIdentity | "throw"): VerifyAccessJwt {
  return () =>
    result === "throw" ? Promise.reject(new Error("invalid token")) : Promise.resolve(result)
}

/** A verified Access identity for an interactive (human) login with the given email. */
function identityFor(email: string | null): AccessIdentity {
  return { email, commonName: null, sub: "cf-access-sub-1", raw: {} }
}

interface Harness {
  app: FastifyInstance
  mailer: FakeMailer
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  /** Captured operator.login (and any other auth) audit rows (the injected sink). */
  audits: WriteAuditInput[]
}

async function makeHarness(opts: { verifyAccessJwt?: VerifyAccessJwt } = {}): Promise<Harness> {
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
  // Capture the operator.login audit (the offline harness has no DB to write through), and optionally
  // substitute the Cloudflare Access verifier so the exchange route runs without a real CF JWKS.
  app.adminAuthOverrides = {
    auditSink: (input) => {
      audits.push(input)
      return Promise.resolve()
    },
    ...(opts.verifyAccessJwt ? { verifyAccessJwt: opts.verifyAccessJwt } : {}),
  }
  return { app, mailer, services, stores, audits }
}

/**
 * Seed a user with a role and mint a bearer session token for it (presented as Authorization: Bearer).
 *
 * H2: an operator seeded here uses an ADMIN_EMAILS-allowlisted address by default, because the guard now
 * re-checks the allowlist on EVERY admin request — a `users.role = 'operator'` row alone is no longer
 * sufficient. Pass `email` explicitly to seed the off-boarded / never-allowlisted case.
 */
async function sessionFor(h: Harness, role: Role, email?: string): Promise<string> {
  const addr = email ?? (role === "operator" ? ALLOWED : `${role}.${Date.now()}@example.com`)
  const user = await h.stores.users.create(addr, {
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
  { method: "GET", url: "/v1/admin/home/summary" },
  { method: "GET", url: "/v1/admin/discovery" },
  { method: "GET", url: "/v1/admin/jurisdictions" },
  { method: "GET", url: "/v1/admin/reports" },
  { method: "GET", url: "/v1/admin/events" },
  { method: "GET", url: "/v1/admin/users" },
  { method: "GET", url: "/v1/admin/moderation" },
  { method: "GET", url: "/v1/admin/gov-claims" },
  { method: "GET", url: "/v1/admin/mail" },
  { method: "GET", url: "/v1/admin/analytics/kpis" },
  { method: "GET", url: "/v1/admin/audit" },
  { method: "GET", url: "/v1/admin/system/health" },
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

describe("H2: operator authority is re-checked against ADMIN_EMAILS on EVERY admin request", () => {
  /**
   * The vulnerability this closes: `users.role = 'operator'` used to be sufficient forever. Any auth path
   * minted a session carrying roles:["operator"] — including the PUBLIC citizen Email-OTP / Google / Apple
   * login — and removing the address from ADMIN_EMAILS never demoted the row. So an off-boarded operator
   * signed in through the consumer app and kept full console access (and with a bearer token, no CSRF).
   *
   * These sessions are minted DIRECTLY via SessionService.createSession, i.e. exactly what the citizen
   * login flow does: no Cloudflare Access exchange anywhere in sight.
   */

  it("REJECTS an operator-role session whose email is NOT in ADMIN_EMAILS (the off-boarded operator)", async () => {
    harness = await makeHarness()
    // A real users.role='operator' row + a real live session, but the address was never allowlisted (or
    // was removed from the allowlist after off-boarding).
    const token = await sessionFor(harness, "operator", NOT_ALLOWED)
    for (const r of DATA_ROUTES) {
      const res = await harness.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode, `${r.method} ${r.url} off-boarded operator`).toBe(403)
    }
  })

  it("REJECTS an off-boarded operator on a MUTATION too (the bearer transport skips CSRF)", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator", NOT_ALLOWED)
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/users/00000000-0000-0000-0000-000000000001/role",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
      payload: { role: "operator" },
    })
    expect(res.statusCode).toBe(403)
  })

  it("ACCEPTS an operator whose email IS in ADMIN_EMAILS (case-insensitively)", async () => {
    harness = await makeHarness()
    // "OTHER@civfix.org" is in the configured allowlist; the env loader normalizes it to lower case.
    const token = await sessionFor(harness, "operator", "other@civfix.org")
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { authorization: `Bearer ${token}` },
    })
    expect([401, 403]).not.toContain(res.statusCode)
  })

  it("still 401s an anonymous caller and 403s a citizen BEFORE any allowlist lookup", async () => {
    harness = await makeHarness()
    const anon = await harness.app.inject({ method: "GET", url: "/v1/admin/users" })
    expect(anon.statusCode).toBe(401)
    const citizen = await sessionFor(harness, "citizen")
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${citizen}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe("M5: malformed :id path params are rejected as 400/422, not 500", () => {
  it("a non-uuid :id on an admin detail route is a typed validation error (not a 500)", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator")
    // These reach the handler (operator passed the guard); a non-uuid id must be caught by idParam
    // (AppError.validation -> 400) BEFORE the SQL layer, where a non-uuid would otherwise 500.
    for (const url of [
      "/v1/admin/reports/not-a-uuid",
      "/v1/admin/moderation/not-a-uuid",
      "/v1/admin/events/not-a-uuid",
      "/v1/admin/users/not-a-uuid",
      "/v1/admin/gov-claims/not-a-uuid",
      "/v1/admin/mail/not-a-uuid",
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

describe("doc 16: admin Cloudflare Access exchange (POST /admin/auth/access/exchange)", () => {
  const HEADER = { "cf-access-jwt-assertion": "stub.jwt.token" }

  it("a valid JWT for an allowlisted email grants operator, audits operator.login, mints a session", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
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

    // The user was granted operator in the store (idempotent grant on find-or-create).
    const stored = await harness.stores.users.findByEmail(ALLOWED)
    expect(stored?.role).toBe("operator")

    // operator.login was audited, tagged with the Access path.
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      action: "operator.login",
      target: `user:${stored?.id}`,
      meta: { via: "cf-access" },
    })

    // After exchange, the minted session passes the operator guard on a data route (not 401/403).
    const sessionCookie = (String(setCookie).split(";")[0] ?? "").trim()
    const data = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { cookie: sessionCookie },
    })
    expect([401, 403]).not.toContain(data.statusCode)
  })

  it("rejects a verified-but-non-allowlisted email with 403, issues NO session, creates NO user row", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(NOT_ALLOWED)) })
    expect(await harness.stores.users.findByEmail(NOT_ALLOWED)).toBeNull()
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(403)
    expect(res.headers["set-cookie"]).toBeUndefined() // no session issued
    expect(harness.audits).toHaveLength(0) // no operator.login audit
    // The allowlist check runs BEFORE find-or-create, so no bare user row is provisioned.
    expect(await harness.stores.users.findByEmail(NOT_ALLOWED)).toBeNull()
  })

  it("is 401 when the Cf-Access-Jwt-Assertion header is absent", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const res = await harness.app.inject({ method: "POST", url: "/v1/admin/auth/access/exchange" })
    expect(res.statusCode).toBe(401)
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(harness.audits).toHaveLength(0)
  })

  it("is 401 when the JWT fails verification (forged/expired/wrong aud)", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier("throw") })
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(401)
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(harness.audits).toHaveLength(0)
  })

  it("is 503 when Cloudflare Access is not configured (no CF_ACCESS_* and no verifier)", async () => {
    harness = await makeHarness() // no verifyAccessJwt override; test env has no CF_ACCESS_*
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(503)
  })
})
