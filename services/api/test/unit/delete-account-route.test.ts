import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { buildContainer, type Container } from "../../src/di.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

/**
 * Route-level tests for DELETE /me.
 *
 * (1) The email-OTP GATE: deleting an account requires a valid one-time code for the account email (the
 *     client requests it via POST /auth/otp/request and submits it here). We assert the GATE rejects an
 *     absent/wrong code with 401 BEFORE any destructive work runs.
 * (2) The post-revocation CLEANUP CHAIN: the three erasure steps (OAuth unlink, push-token purge, the
 *     `account.deleted` audit row) are independent and must be ISOLATED from each other — chaining them
 *     under one swallowing try let a transient failure in the first silently skip the other two on a
 *     compliance path. Those two steps talk raw `sql`, so they are observed here through a fake sql tag
 *     handed to the container (the full DB success path lives in the integration suite).
 *
 * Bearer (mobile) transport is CSRF-exempt, so no x-csrf-token header is required.
 */

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

/**
 * Same harness, but with (a) a fake `sql` tag on the container so the two raw-SQL cleanup steps are
 * observable offline, and (b) an OAuth service whose unlinkAllForUser REJECTS — the transient failure the
 * isolation fix is about. Spreading the real container keeps every other seam intact and only swaps getDb.
 */
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
  const fake = makeFakeSql([
    // writeAudit throws when the INSERT returns no row, so script the RETURNING id.
    { match: /INSERT INTO audit_log/i, rows: [{ id: "audit-1" }] },
  ])
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
    // Signing in consumed the sign-in code; no fresh delete code exists, so any code is invalid.
    const token = await signIn(app, mailer, "jane@example.com")
    const res = await del(app, token, "000000")
    expect(res.statusCode).toBe(401)
    expect(res.json().message).toMatch(/invalid or expired code/i)
  })

  it("rejects deletion with 401 when a freshly-issued code does not match", async () => {
    const { app, mailer } = await harness()
    const token = await signIn(app, mailer, "jane@example.com")
    // Issue a real delete code, then submit a DIFFERENT one — the gate must reject it.
    await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: "jane@example.com" } })
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
    // Sign-in issued a code (anchoring `otp:rl:email:<email>` for 60s) and CONSUMED it on verify. The
    // deletion gate then re-requests a code through the very same public endpoint, with no clock advance:
    // the release-on-consume rule is the only reason this is not the 429 the erasure path used to get.
    await signIn(app, mailer, email)
    const res = await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sent: true })
    // A genuinely NEW code was mailed (two passcode emails for this address), not a replay of the spent one.
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

    // A fresh deletion code, then the delete itself. Step 1 (unlink) rejects; the request must still 200
    // (the tombstone + revocation ARE the deletion) and steps 2 + 3 must still run.
    await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const res = await del(app, token, mailer.lastOtpFor(email)!)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const pushDelete = fake.statements.find((s) => /DELETE FROM push_tokens/i.test(s.sql))
    expect(pushDelete, "push-token erasure must not be skipped by the unlink failure").toBeDefined()
    expect(pushDelete?.values).toContain(userId)

    const audit = fake.statements.find((s) => /INSERT INTO audit_log/i.test(s.sql))
    expect(audit, "the account.deleted audit row must not be skipped by the unlink failure").toBeDefined()
    expect(audit?.values.slice(0, 3)).toEqual([userId, "account.deleted", `user:${userId}`])

    // The deletion itself happened and every session is gone.
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
