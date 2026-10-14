import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { InjectOptions, LightMyRequestResponse } from "fastify"
import { endpoints, versionedPath, type EndpointDef } from "@civfix/shared/client"
import type { Role } from "@civfix/shared"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"

// admin-auth-guard.test.ts proves the operator gate on a hand-picked sample of routes. This suite derives
// the list from the shared registry instead, so an /admin endpoint registered outside the operator-scoped
// child in routes/admin/index.ts fails CI. The off-boarded operator leg is the one that catches that
// universally: most admin handlers also call requireOperator(), which checks only the session claim, so a
// mis-scoped route would still 401 anonymous callers and 403 citizens; only the scope's preHandler re-checks
// ADMIN_EMAILS.

const PARAM_VALUE = "11111111-1111-1111-1111-111111111111"

const ADMIN_PREFIX = "/admin/"
const ADMIN_AUTH_PREFIX = "/admin/auth/"

// Admin endpoints intentionally mounted outside the operator scope, each with the reason. Empty by design:
// an entry here is a deliberate hole in the deny-by-default gate and must be argued for in review.
const MOUNTED_ELSEWHERE: Readonly<Record<string, string>> = {}

// Contract endpoints the server does not serve yet, skipped by name with the reason (route-coverage's
// convention). Its three forward-template entries are stale: mail.routes.ts serves them, so they are gated
// here like every other admin route.
const NOT_YET_ROUTED: Readonly<Record<string, string>> = {}

const ADMIN_AUTH_ENDPOINTS = ["adminAccessExchange", "adminLogout", "adminSession"]

const allEntries = Object.entries(endpoints) as ReadonlyArray<[string, EndpointDef]>
const adminDataEntries = allEntries.filter(
  ([, ep]) => ep.path.startsWith(ADMIN_PREFIX) && !ep.path.startsWith(ADMIN_AUTH_PREFIX),
)

// Each endpoint gets its own callers and source address: the global per-IP limit, the per-identity bucket
// on admin mutations and the per-route mail limits would otherwise turn later legs into 429s that mask
// the guard's verdict.
function allowlistedEmailFor(name: string): string {
  return `ops+${name.toLowerCase()}@civfix.org`
}

function remoteAddressFor(index: number): string {
  return `198.18.${Math.floor(index / 254)}.${(index % 254) + 1}`
}

function fillPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? PARAM_VALUE : seg))
    .join("/")
}

function injectArgs(
  ep: EndpointDef,
  remoteAddress: string,
  headers: Record<string, string>,
): InjectOptions {
  const url = fillPath(versionedPath(ep))
  if (ep.method === "GET" || ep.method === "DELETE") {
    return { method: ep.method, url, remoteAddress, headers }
  }
  return { method: ep.method, url, remoteAddress, headers, payload: {} }
}

function isRouteMissing(res: LightMyRequestResponse, ep: EndpointDef): boolean {
  if (res.statusCode !== 404) return false
  const body = res.json<{ message?: string }>()
  return typeof body.message === "string" && body.message.startsWith(`Route ${ep.method} `)
}

function bearerMobile(token: string): Record<string, string> {
  // Bearer + x-client: mobile is CSRF-exempt, so a mutation's status reflects the operator gate alone.
  return { authorization: `Bearer ${token}`, "x-client": "mobile" }
}

let harness: AuthHarness

async function sessionFor(role: Role, email: string): Promise<string> {
  const user = await harness.stores.users.create(email, {
    displayName: role,
    role,
    emailVerified: true,
  })
  return harness.services.sessions.createSession(user.id, [role])
}

beforeAll(async () => {
  const allowlist = adminDataEntries.map(([name]) => allowlistedEmailFor(name)).join(",")
  harness = await makeAuthHarness({ env: { ADMIN_EMAILS: allowlist } })
})

afterAll(async () => {
  await harness.app.close()
})

describe("admin guard over the registry: the derived route list is sound", () => {
  it("derives a non-trivial admin data route list from the registry", () => {
    expect(adminDataEntries.length).toBeGreaterThan(90)
  })

  it("only the three session endpoints live under /admin/auth/ (they establish the session, unguarded)", () => {
    const authNames = allEntries
      .filter(([, ep]) => ep.path.startsWith(ADMIN_AUTH_PREFIX))
      .map(([name]) => name)
      .sort()
    expect(authNames).toEqual(ADMIN_AUTH_ENDPOINTS)
  })

  it("every exclusion and skip names a real admin data endpoint", () => {
    const adminNames = new Set(adminDataEntries.map(([name]) => name))
    for (const name of [...Object.keys(MOUNTED_ELSEWHERE), ...Object.keys(NOT_YET_ROUTED)]) {
      expect(adminNames.has(name), `${name} is not an admin data endpoint`).toBe(true)
    }
  })

  it("every skipped endpoint is still unrouted (once served, it must join the guarded set)", async () => {
    for (const name of Object.keys(NOT_YET_ROUTED)) {
      const ep = endpoints[name as keyof typeof endpoints] as EndpointDef
      const res = await harness.app.inject(injectArgs(ep, "198.51.100.1", {}))
      expect(isRouteMissing(res, ep), `${name} is now routed; remove it from NOT_YET_ROUTED`).toBe(
        true,
      )
    }
  })
})

describe("admin guard over the registry: every /admin data endpoint is operator-gated", () => {
  adminDataEntries.forEach(([name, ep], index) => {
    const skipped = name in MOUNTED_ELSEWHERE || name in NOT_YET_ROUTED
    it.skipIf(skipped)(`${name}: ${ep.method} ${ep.path}`, async () => {
      const label = `${name} (${ep.method} ${ep.path})`
      const address = remoteAddressFor(index)
      const citizen = await sessionFor("citizen", `citizen+${name.toLowerCase()}@example.com`)
      const offboarded = await sessionFor(
        "operator",
        `offboarded+${name.toLowerCase()}@example.com`,
      )
      const operator = await sessionFor("operator", allowlistedEmailFor(name))

      const anonRes = await harness.app.inject(injectArgs(ep, address, {}))
      expect(anonRes.statusCode, `${label} anonymous`).toBe(401)

      const citizenRes = await harness.app.inject(injectArgs(ep, address, bearerMobile(citizen)))
      expect(citizenRes.statusCode, `${label} citizen`).toBe(403)

      const offboardedRes = await harness.app.inject(
        injectArgs(ep, address, bearerMobile(offboarded)),
      )
      expect(offboardedRes.statusCode, `${label} operator not in ADMIN_EMAILS`).toBe(403)

      // Past the gate the handler may 400/422 on the empty body or 500 without Postgres; only an auth
      // rejection or a missing route would mean the gate itself is wrong.
      const operatorRes = await harness.app.inject(injectArgs(ep, address, bearerMobile(operator)))
      expect([401, 403], `${label} allowlisted operator`).not.toContain(operatorRes.statusCode)
      expect(isRouteMissing(operatorRes, ep), `${label} is not registered`).toBe(false)
    })
  })
})
