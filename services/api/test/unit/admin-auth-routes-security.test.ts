import { afterEach, describe, expect, it, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores, type AccountStatus } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { WriteAuditInput } from "../../src/services/admin/audit.js"

const ALLOWED = "ops@civfix.org"
const EXCHANGE_URL = "/v1/admin/auth/access/exchange"
const ACCESS_HEADER = { "cf-access-jwt-assertion": "stub.jwt.token" }

let prod = false
vi.mock("../../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/env.js")>()
  return { ...actual, isProd: () => prod }
})

let app: FastifyInstance | undefined
afterEach(async () => {
  prod = false
  await app?.close()
  app = undefined
})

async function harness(opts: { accessConfigured?: boolean } = {}) {
  const stores = makeInMemoryStores()
  const services = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: ALLOWED })
  app = await buildServer({ env, authServices: services })
  const audits: WriteAuditInput[] = []
  app.adminAuthOverrides = {
    auditSink: (input) => {
      audits.push(input)
      return Promise.resolve()
    },
    ...(opts.accessConfigured === false
      ? {}
      : {
          verifyAccessJwt: () =>
            Promise.resolve({ email: ALLOWED, commonName: null, sub: "cf-sub", raw: {} }),
        }),
  }
  return { app, stores, audits }
}

describe("admin Cloudflare Access exchange for a restricted account", () => {
  const restricted: readonly AccountStatus[] = ["banned", "suspended"]

  it.each(restricted)(
    "refuses a %s allowlisted citizen before promoting it or auditing a login",
    async (status) => {
      const h = await harness()
      const user = await h.stores.users.create(ALLOWED, {
        displayName: "Ops",
        role: "citizen",
        emailVerified: true,
      })
      h.stores.users.setAccountStatus(user.id, status)

      const res = await h.app.inject({ method: "POST", url: EXCHANGE_URL, headers: ACCESS_HEADER })

      expect(res.statusCode).toBe(403)
      expect((await h.stores.users.findById(user.id))?.role).toBe("citizen")
      expect(h.audits.map((a) => a.action)).toEqual(["operator.login_denied"])
      expect(h.audits[0]).toMatchObject({
        actorId: user.id,
        target: `user:${user.id}`,
        meta: { email: ALLOWED, status, via: "cf-access" },
      })
      expect(res.headers["set-cookie"]).toBeUndefined()
    },
  )

  it("still promotes and audits an active allowlisted citizen", async () => {
    const h = await harness()
    const user = await h.stores.users.create(ALLOWED, {
      displayName: "Ops",
      role: "citizen",
      emailVerified: true,
    })

    const res = await h.app.inject({ method: "POST", url: EXCHANGE_URL, headers: ACCESS_HEADER })

    expect(res.statusCode).toBe(200)
    expect((await h.stores.users.findById(user.id))?.role).toBe("operator")
    expect(h.audits.map((a) => a.action)).toEqual(["operator.login"])
  })
})

describe("admin Cloudflare Access exchange without Access configured", () => {
  it("tells the operator in production that Access is not configured", async () => {
    const h = await harness({ accessConfigured: false })
    prod = true

    const res = await h.app.inject({ method: "POST", url: EXCHANGE_URL, headers: ACCESS_HEADER })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).toBe("Cloudflare Access is not configured.")
  })
})
