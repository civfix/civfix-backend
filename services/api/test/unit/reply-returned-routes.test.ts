import { createHmac } from "node:crypto"
import { describe, it, expect, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { ErrorCode, type SessionResponse } from "@civfix/contract"
import { FakeInboundMail, FakeStorage } from "@civfix/seams"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../helpers/admin/inbound-repository.memory.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import { registerRateLimit } from "../../src/plugins/rate-limit.js"
import { applyWsUpgradeRateLimit } from "../../src/routes/chat-gateway-wiring.js"
import {
  CF_WEBHOOK_SIGNATURE_HEADER,
  registerInboundMailWebhook,
} from "../../src/routes/webhooks/inbound-mail.routes.js"
import type { Container } from "../../src/di.js"

const SECRET = "cf-webhook-secret-value"
const WEB_ORIGIN = "https://app.civfix.org"

let app: FastifyInstance | undefined
let harness: AuthHarness | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
  await harness?.app.close()
  harness = undefined
})

function setCookies(header: string | string[] | undefined): string[] {
  return Array.isArray(header) ? header : header ? [header] : []
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  const line = setCookies(header).find((l) => l.startsWith(`${name}=`))
  return line ? decodeURIComponent(line.split(";")[0]!.slice(name.length + 1)) : null
}

describe("POST /webhooks/inbound-mail", () => {
  it("T15: ACKs a signed request with no valid key as 202 bad-key", async () => {
    app = Fastify()
    app.setErrorHandler(makeErrorHandler())
    const inboundMail = new FakeInboundMail()
    app.decorate("inboundMailOverrides", {
      storage: new FakeStorage(),
      inboundMail,
      mailRepo: new InMemoryMailRepository(),
      inboundRepo: new InMemoryInboundRepository(),
    })
    const container = {
      env: { CF_EMAIL_WEBHOOK_SECRET: SECRET },
      inboundMail,
    } as unknown as Container
    await registerInboundMailWebhook(app, container)
    await app.ready()

    const body = JSON.stringify({ key: "secrets/passwords.txt" })
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: {
        "content-type": "application/json",
        [CF_WEBHOOK_SIGNATURE_HEADER]: createHmac("sha256", SECRET).update(body).digest("hex"),
      },
      payload: body,
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: true, processed: false, reason: "bad-key" })
  })
})

describe("the session-issuing auth routes", () => {
  async function verify(email: string, client: "mobile" | "web") {
    await harness!.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    return harness!.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": client },
      payload: { email, code: harness!.mailer.lastOtpFor(email)! },
    })
  }

  it("T16: a mobile sign-in answers 200 with the user and the bearer token", async () => {
    harness = await makeAuthHarness()
    const res = await verify("t16.mobile@example.com", "mobile")
    expect(res.statusCode).toBe(200)
    const body = res.json<SessionResponse>()
    expect(Object.keys(body).sort()).toEqual(["guestSmsEnabled", "token", "user"])
    expect(body.user.email).toBe("t16.mobile@example.com")
    expect(typeof body.token).toBe("string")
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).toBeNull()
  })

  it("T16: a web sign-in sets the session cookie and answers 200 with the user and the CSRF token", async () => {
    harness = await makeAuthHarness()
    const res = await verify("t16.web@example.com", "web")
    expect(res.statusCode).toBe(200)
    const body = res.json<SessionResponse>()
    expect(Object.keys(body).sort()).toEqual(["csrfToken", "guestSmsEnabled", "user"])
    expect(body.user.email).toBe("t16.web@example.com")
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).not.toBeNull()
    expect(cookieValue(res.headers["set-cookie"], "civfix_csrf")).toBe(body.csrfToken)
  })

  it("T16: a web OAuth callback sets the session cookie and redirects", async () => {
    harness = await makeAuthHarness({ webOrigins: [WEB_ORIGIN] })
    const { userId } = await harness.signIn("t16.oauth@example.com")
    const user = (await harness.services.users.findById(userId))!
    vi.spyOn(harness.services.oauth, "completeGoogleCallback").mockResolvedValue(user)

    const start = await harness.app.inject({
      method: "GET",
      url: `/auth/google/start?redirect=${encodeURIComponent("/reports/7")}`,
    })
    const state = new URL(start.headers.location as string).searchParams.get("state")!
    const handshake = cookieValue(start.headers["set-cookie"], "civfix_oauth")!
    const res = await harness.app.inject({
      method: "GET",
      url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      headers: { cookie: `civfix_oauth=${encodeURIComponent(handshake)}` },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("/reports/7")
    expect(res.body).toBe("")
    expect(cookieValue(res.headers["set-cookie"], "civfix_session")).not.toBeNull()
    expect(cookieValue(res.headers["set-cookie"], "civfix_csrf")).not.toBeNull()
  })
})

describe("the /ws onRequest hook", () => {
  async function build(): Promise<FastifyInstance> {
    const f = Fastify()
    await registerRateLimit(f)
    f.get("/ws", async () => ({ ok: true }))
    f.get("/other", async () => ({ ok: true }))
    applyWsUpgradeRateLimit(f)
    await f.ready()
    return f
  }

  it("T17: answers 429 with the rate-limit headers past the upgrade limiter, other paths untouched", async () => {
    app = await build()
    for (let i = 0; i < 60; i++) await app.inject({ method: "GET", url: "/ws" })
    const blocked = await app.inject({ method: "GET", url: "/ws" })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({
      code: ErrorCode.RATE_LIMITED,
      message: "Too many connection attempts.",
    })
    expect(blocked.headers["x-ratelimit-limit"]).toBe("60")
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0")
    expect(blocked.headers["x-ratelimit-reset"]).toBeDefined()
    expect(blocked.headers["retry-after"]).toBeDefined()

    const other = await app.inject({ method: "GET", url: "/other" })
    expect(other.statusCode).toBe(200)
    expect(other.json()).toEqual({ ok: true })
  })
})
