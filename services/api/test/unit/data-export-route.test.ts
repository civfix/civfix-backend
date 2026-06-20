import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import type { DataExportService } from "../../src/services/data-export-service.js"

/**
 * Route-level robustness tests for POST /me/data-export (privacy §7.2): instead of a misleading ok:true
 * when nothing was delivered, the route surfaces a CLEAR error when the account has no email (422) or the
 * send fails (500). Uses the dataExportOverride seam to inject a fake service (no DB / no real mailer).
 */

let current: FastifyInstance | undefined
afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

async function harness(service: DataExportService): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
}> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const app = await buildServer({ env, authServices, dataExportOverride: { service } })
  current = app
  return { app, mailer }
}

async function signIn(app: FastifyInstance, mailer: FakeMailer, email: string): Promise<string> {
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  return verify.json().token
}

// Bearer (mobile) transport is CSRF-exempt, so no x-csrf-token header is needed.
function post(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: "/v1/me/data-export",
    headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    payload: {},
  })
}

describe("POST /me/data-export robustness", () => {
  it("200 + email when the export was delivered", async () => {
    const service: DataExportService = {
      exportData: async () => ({ ok: true, email: "jane@example.com" }),
    }
    const { app, mailer } = await harness(service)
    const token = await signIn(app, mailer, "jane@example.com")
    const res = await post(app, token)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, email: "jane@example.com" })
  })

  it("422 with a clear message when the account has no email (not a silent ok:true)", async () => {
    const service: DataExportService = {
      exportData: async () => ({ ok: true, email: null }),
    }
    const { app, mailer } = await harness(service)
    const token = await signIn(app, mailer, "jane@example.com")
    const res = await post(app, token)
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.code).toBe("VALIDATION")
    expect(body.message).toMatch(/no email address/i)
  })

  it("500 with a retryable message when the send fails (not a silent ok:true)", async () => {
    const service: DataExportService = {
      exportData: async () => {
        throw new Error("mailer down")
      },
    }
    const { app, mailer } = await harness(service)
    const token = await signIn(app, mailer, "jane@example.com")
    const res = await post(app, token)
    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.message).toMatch(/try again/i)
  })
})
