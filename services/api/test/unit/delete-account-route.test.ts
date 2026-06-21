import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"

/**
 * Route-level tests for the DELETE /me email-OTP GATE: deleting an account requires a valid one-time code
 * for the account email (the client requests it via POST /auth/otp/request and submits it here). We assert
 * the GATE rejects an absent/wrong code with 401 BEFORE any destructive work runs. The success path (soft
 * delete + ban + push-token purge + audit) touches the DB, so it stays in the integration suite; here we
 * only need to prove a missing/incorrect code cannot delete the account. Bearer (mobile) transport is
 * CSRF-exempt, so no x-csrf-token header is required.
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
})
