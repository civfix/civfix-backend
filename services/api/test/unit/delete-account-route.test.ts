import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { buildContainer, type Container } from "../../src/di.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores, type InMemoryUserStore } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

let current: FastifyInstance | undefined
afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

async function harness(): Promise<{ app: FastifyInstance; mailer: FakeMailer }> {
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
  const app = await buildServer({ env, authServices })
  current = app
  return { app, mailer }
}

async function cleanupHarness(): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
  fake: FakeSqlControl
  services: AuthServices
  unlinkCalls: number
}> {
  const env = loadEnv({ NODE_ENV: "test" })
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
  let unlinkCalls = 0
  services.oauth.unlinkAllForUser = (): Promise<void> => {
    unlinkCalls += 1
    return Promise.reject(new Error("oauth store unavailable"))
  }
  const fake = makeFakeSql([{ match: /INSERT INTO audit_log/i, rows: [{ id: "audit-1" }] }])
  const container = {
    ...buildContainer(env),
    getDb: () => ({ sql: fake.sql }),
  } as unknown as Container
  const app = await buildServer({ env, container, authServices: services })
  current = app
  return {
    app,
    mailer,
    fake,
    services,
    get unlinkCalls() {
      return unlinkCalls
    },
  }
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

function del(app: FastifyInstance, token: string, emailOtp: string) {
  return app.inject({
    method: "DELETE",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    payload: { emailOtp },
  })
}

describe("DELETE /me email-OTP gate", () => {
  it("rejects deletion with 401 when no code was issued for the account", async () => {
    const { app, mailer } = await harness()
    const token = await signIn(app, mailer, "jane@example.com")
    const res = await del(app, token, "000000")
    expect(res.statusCode).toBe(401)
    expect(res.json().message).toMatch(/invalid or expired code/i)
  })

  it("rejects deletion with 401 when a freshly-issued code does not match", async () => {
    const { app, mailer } = await harness()
    const token = await signIn(app, mailer, "jane@example.com")
    await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email: "jane@example.com" },
    })
    const real = mailer.lastOtpFor("jane@example.com")!
    const wrong = real === "123456" ? "654321" : "123456"
    const res = await del(app, token, wrong)
    expect(res.statusCode).toBe(401)
  })

  it("requires authentication (401 before the body is even considered)", async () => {
    const { app } = await harness()
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { "x-client": "mobile" },
      payload: { emailOtp: "123456" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("issues the deletion code immediately after sign-in (the sign-in verify releases the 60s cooldown)", async () => {
    const { app, mailer } = await harness()
    const email = "jane@example.com"
    await signIn(app, mailer, email)
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { email },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sent: true })
    const codes = mailer.sent.filter((m) => m.to === email && m.code !== undefined)
    expect(codes).toHaveLength(2)
  })
})

describe("DELETE /me post-revocation cleanup isolation", () => {
  it("still purges push tokens and writes the audit row when the OAuth unlink fails", async () => {
    const { app, mailer, fake, services } = await cleanupHarness()
    const email = "jane@example.com"
    const token = await signIn(app, mailer, email)
    const before = await services.users.findByEmail(email)
    const userId = before!.id

    await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const res = await del(app, token, mailer.lastOtpFor(email)!)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const pushDelete = fake.statements.find((s) => /DELETE FROM push_tokens/i.test(s.sql))
    expect(pushDelete, "push-token erasure must not be skipped by the unlink failure").toBeDefined()
    expect(pushDelete?.values).toContain(userId)

    const audit = fake.statements.find((s) => /INSERT INTO audit_log/i.test(s.sql))
    expect(
      audit,
      "the account.deleted audit row must not be skipped by the unlink failure",
    ).toBeDefined()
    expect(audit?.values.slice(0, 3)).toEqual([userId, "account.deleted", `user:${userId}`])

    const notifDelete = fake.statements.find((s) => /DELETE FROM notifications/i.test(s.sql))
    expect(notifDelete, "the deleted user's notification rows must be purged (F088)").toBeDefined()
    expect(notifDelete?.values).toContain(userId)

    const after = await services.users.findById(userId)
    expect(after?.deletedAt ?? null).not.toBeNull()
    const reuse = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${token}`, "x-client": "mobile" },
    })
    expect(reuse.json().user ?? null).toBeNull()
  })
})

describe("DELETE /me without an email on file (F137)", () => {
  it("deletes an email-less account without requiring an email OTP", async () => {
    const { app, mailer, services } = await cleanupHarness()
    const email = "apple-hidden@example.com"
    const token = await signIn(app, mailer, email)
    const user = await services.users.findByEmail(email)
    const userId = user!.id
    ;(services.users as unknown as InMemoryUserStore).seed(null, {
      ...user!,
      email: null,
      emailVerified: false,
    })

    const res = await del(app, token, "000000")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const after = await services.users.findById(userId)
    expect(after?.deletedAt ?? null).not.toBeNull()
  })
})
