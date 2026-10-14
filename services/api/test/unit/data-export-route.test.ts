import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer, type FakeJobs } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores, type InMemoryUserStore } from "../../src/auth/stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { DATA_EXPORT_JOB } from "../../src/lib/queue-names.js"

let current: FastifyInstance | undefined
afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

async function harness(): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
  services: AuthServices
}> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const services = makeAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const app = await makeServer({ env, authServices: services })
  current = app
  return { app, mailer, services }
}

function jobs(app: FastifyInstance): FakeJobs {
  return app.container.jobs as unknown as FakeJobs
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

function post(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: "/v1/me/data-export",
    headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    payload: {},
  })
}

describe("POST /me/data-export", () => {
  it("200 + email and enqueues a deduped data.export job for the account (F018)", async () => {
    const { app, mailer, services } = await harness()
    const token = await signIn(app, mailer, "jane@example.com")
    const userId = (await services.users.findByEmail("jane@example.com"))!.id

    const res = await post(app, token)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, email: "jane@example.com" })

    const enqueued = jobs(app).jobsFor(DATA_EXPORT_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.data).toEqual({ userId })
    expect(enqueued[0]!.opts?.singletonKey).toBe(userId)
  })

  it("422 with a support-contact message when the account has no email, and enqueues nothing (F137)", async () => {
    const { app, mailer, services } = await harness()
    const token = await signIn(app, mailer, "jane@example.com")
    const user = await services.users.findByEmail("jane@example.com")
    ;(services.users as unknown as InMemoryUserStore).seed(null, {
      ...user!,
      email: null,
      emailVerified: false,
    })

    const res = await post(app, token)
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.code).toBe("VALIDATION")
    expect(body.message).toMatch(/no email address/i)
    expect(body.message).toMatch(/support@/i)
    expect(jobs(app).jobsFor(DATA_EXPORT_JOB)).toHaveLength(0)
  })
})
