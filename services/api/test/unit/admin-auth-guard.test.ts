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

// Route-coverage only proves admin routes are registered; these drive the real Fastify stack to prove the
// guard actually returns 401/403 and the Access exchange enforces the allowlist. The real Access
// verifier (cf-access.ts) has its own keypair tests; here it is swapped via adminAuthOverrides.

const ALLOWED = "ops@civfix.org"
const ALLOWED_RESERVED_LOCAL = "civfix@civfix.org"
const NOT_ALLOWED = "stranger@example.com"

function fakeVerifier(result: AccessIdentity | "throw"): VerifyAccessJwt {
  return () =>
    result === "throw" ? Promise.reject(new Error("invalid token")) : Promise.resolve(result)
}

function identityFor(email: string | null): AccessIdentity {
  return { email, commonName: null, sub: "cf-access-sub-1", raw: {} }
}

interface Harness {
  app: FastifyInstance
  mailer: FakeMailer
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
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
  const env = loadEnv({
    NODE_ENV: "test",
    ADMIN_EMAILS: `${ALLOWED}, OTHER@civfix.org, ${ALLOWED_RESERVED_LOCAL}`,
  })
  const app = await buildServer({ env, authServices: services })
  const audits: WriteAuditInput[] = []
  // The offline harness has no DB to write audits through, and no real CF JWKS for the exchange.
  app.adminAuthOverrides = {
    auditSink: (input) => {
      audits.push(input)
      return Promise.resolve()
    },
    ...(opts.verifyAccessJwt ? { verifyAccessJwt: opts.verifyAccessJwt } : {}),
  }
  return { app, mailer, services, stores, audits }
}

// Operators default to an allowlisted address because the guard re-checks ADMIN_EMAILS on every admin
// request; a `users.role = 'operator'` row alone is not sufficient. Pass `email` for the off-boarded case.
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

const DATA_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
  { method: "GET", url: "/v1/admin/home/summary" },
  { method: "GET", url: "/v1/admin/discovery" },
  { method: "GET", url: "/v1/admin/jurisdictions" },
  { method: "GET", url: "/v1/admin/reports" },
  { method: "GET", url: "/v1/admin/reports/11111111-1111-1111-1111-111111111111/messages" },
  { method: "POST", url: "/v1/admin/reports/11111111-1111-1111-1111-111111111111/messages" },
  {
    method: "POST",
    url: "/v1/admin/reports/11111111-1111-1111-1111-111111111111/messages/22222222-2222-2222-2222-222222222222/remove",
  },
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
      // The handler may still 500 for a read that needs Postgres in this offline harness.
      expect([401, 403], `${r.method} ${r.url} operator should pass guard`).not.toContain(
        res.statusCode,
      )
    }
  })
})

describe("H2: operator authority is re-checked against ADMIN_EMAILS on EVERY admin request", () => {
  // `users.role = 'operator'` was once sufficient forever: any auth path, including the public citizen
  // login, minted an operator session, and removing the address from ADMIN_EMAILS never demoted the row.
  // These sessions are minted via SessionService.createSession, exactly as the citizen login does.

  it("REJECTS an operator-role session whose email is NOT in ADMIN_EMAILS (the off-boarded operator)", async () => {
    harness = await makeHarness()
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

  // GET /admin/auth/session sits outside the data-route guard and once answered from users.role alone,
  // handing an off-boarded operator authenticated:true and a live CSRF token. The allowlist is the single
  // source of operator truth here too.
  it("F096: reports an off-boarded operator's session as UNAUTHENTICATED and sets no CSRF cookie", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator", NOT_ALLOWED)
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: false })
    expect(res.cookies.some((c) => c.name === "civfix_csrf")).toBe(false)
  })

  it("F096: an ALLOWLISTED operator's session still authenticates and receives its CSRF token", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator")
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      authenticated: boolean
      operator?: { email: string }
      csrfToken?: string
    }
    expect(body.authenticated).toBe(true)
    expect(body.operator?.email).toBe(ALLOWED)
    expect(body.csrfToken).toBeTruthy()
    expect(res.cookies.some((c) => c.name === "civfix_csrf")).toBe(true)
  })

  it("F096: a CITIZEN session is unauthenticated on the session probe", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "citizen")
    const res = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/auth/session",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ authenticated: false })
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
    // A non-uuid id must be rejected by idParam before the SQL layer, where it would otherwise 500.
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
    const setCookie = res.headers["set-cookie"]
    expect(setCookie).toBeDefined()
    expect(String(setCookie)).toContain("civfix_session=")
    const body = res.json()
    expect(body.user.role).toBe("operator")
    expect(typeof body.csrfToken).toBe("string")

    const stored = await harness.stores.users.findByEmail(ALLOWED)
    expect(stored?.role).toBe("operator")

    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      action: "operator.login",
      target: `user:${stored?.id}`,
      meta: { via: "cf-access" },
    })

    const sessionCookie = (String(setCookie).split(";")[0] ?? "").trim()
    const data = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { cookie: sessionCookie },
    })
    expect([401, 403]).not.toContain(data.statusCode)
  })

  it("provisions an operator whose email local part reads as CivFix under a neutral name", async () => {
    harness = await makeHarness({
      verifyAccessJwt: fakeVerifier(identityFor(ALLOWED_RESERVED_LOCAL)),
    })
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(200)
    const stored = await harness.stores.users.findByEmail(ALLOWED_RESERVED_LOCAL)
    expect(stored?.displayName).toBe("Operator")
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
    expect(res.headers["set-cookie"]).toBeUndefined()
    expect(harness.audits).toHaveLength(0)
    // The allowlist check runs before find-or-create, so no bare user row is provisioned.
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
    harness = await makeHarness() // test env has no CF_ACCESS_*
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(503)
  })
})

// Logout is deliberately idempotent: behind requireAuth, a stale tab with an expired or revoked session got
// a 401 and its dead cookies were never cleared. csrfProtect still applies (it self-skips with no session
// cookie), so this cannot be used as a cross-site forced logout.
describe("POST /admin/auth/logout: idempotent cookie clearing + CSRF enforcement", () => {
  const HEADER = { "cf-access-jwt-assertion": "stub.jwt.token" }

  async function login(h: Harness): Promise<{ cookie: string; csrfToken: string }> {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/auth/access/exchange",
      headers: HEADER,
    })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers["set-cookie"]
    const raw = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
    const session = raw.find((c) => c.startsWith("civfix_session="))
    expect(session).toBeDefined()
    return {
      cookie: (session ?? "").split(";")[0] ?? "",
      csrfToken: res.json().csrfToken as string,
    }
  }

  function clearedCookies(res: { headers: Record<string, unknown> }): string[] {
    const raw = res.headers["set-cookie"]
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)]
    return list
      .filter((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))
      .map((c) => (c.split("=")[0] ?? "").trim())
  }

  it("revokes the session, clears BOTH cookies (legacy + __Host-), audits operator.logout", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const { cookie, csrfToken } = await login(harness)

    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    // Both the legacy and the __Host- names are cleared so no stale legacy cookie outlives the session.
    const cleared = clearedCookies(res)
    expect(cleared).toContain("civfix_session")
    expect(cleared).toContain("__Host-civfix_session")
    expect(cleared).toContain("civfix_csrf")
    expect(cleared).toContain("__Host-civfix_csrf")

    const stored = await harness.stores.users.findByEmail(ALLOWED)
    expect(harness.audits.map((a) => a.action)).toEqual(["operator.login", "operator.logout"])
    expect(harness.audits[1]).toMatchObject({
      action: "operator.logout",
      target: `user:${stored?.id}`,
      actorId: stored?.id,
      meta: { sessionRevoked: true },
    })

    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { cookie },
    })
    expect(after.statusCode).toBe(401)
  })

  it("is IDEMPOTENT: a second logout with the already-revoked cookie is 200 and re-clears both cookies", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const { cookie, csrfToken } = await login(harness)
    const first = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    })
    expect(first.statusCode).toBe(200)

    // A stale tab retrying with the dead cookie once got a 401 that left the cookies in the browser.
    const second = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ ok: true })
    expect(clearedCookies(second)).toContain("civfix_session")
    expect(clearedCookies(second)).toContain("civfix_csrf")
    // No actor resolves off a revoked session, so no second (NULL-actor) audit row is written.
    expect(harness.audits.map((a) => a.action)).toEqual(["operator.login", "operator.logout"])
  })

  it("401s a caller presenting NO credential at all (contract: adminLogout.auth === required)", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const res = await harness.app.inject({ method: "POST", url: "/v1/admin/auth/logout" })
    // Idempotency covers a presented-but-dead session. A request with no credential has nothing to revoke
    // or clear, so it stays 401, the same rule as the citizen logout and the contract's auth:"required".
    expect(res.statusCode).toBe(401)
    expect(clearedCookies(res)).toHaveLength(0)
    expect(harness.audits).toHaveLength(0)
  })

  it("REJECTS a cookie logout whose X-CSRF-Token is wrong (403) and does NOT revoke the session", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const { cookie } = await login(harness)

    const bad = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie, "x-csrf-token": "not-the-derived-token" },
    })
    expect(bad.statusCode).toBe(403)
    expect(clearedCookies(bad)).toHaveLength(0)
    expect(harness.audits.map((a) => a.action)).toEqual(["operator.login"])

    const still = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { cookie },
    })
    expect([401, 403]).not.toContain(still.statusCode)
  })

  it("REJECTS a cookie logout with NO X-CSRF-Token header (403)", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const { cookie } = await login(harness)
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie },
    })
    expect(res.statusCode).toBe(403)
    expect(harness.audits.map((a) => a.action)).toEqual(["operator.login"])
  })

  it("a CSRF token derived from a DIFFERENT session does not authorize this one (403)", async () => {
    harness = await makeHarness({ verifyAccessJwt: fakeVerifier(identityFor(ALLOWED)) })
    const a = await login(harness)
    const b = await login(harness)
    expect(b.csrfToken).not.toBe(a.csrfToken)

    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: a.cookie, "x-csrf-token": b.csrfToken },
    })
    expect(res.statusCode).toBe(403)
  })

  it("a BEARER logout needs no CSRF header (no ambient cookie to forge) and revokes the session", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "operator")
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(harness.audits).toHaveLength(1)
    expect(harness.audits[0]).toMatchObject({
      action: "operator.logout",
      meta: { sessionRevoked: true },
    })
    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/home/summary",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.statusCode).toBe(401)
  })

  it("does NOT audit operator.logout for a non-operator session (no NULL-authority rows)", async () => {
    harness = await makeHarness()
    const token = await sessionFor(harness, "citizen")
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    // operator.logout is reserved for operators.
    expect(harness.audits).toHaveLength(0)
  })
})
