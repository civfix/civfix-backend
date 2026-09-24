import { Writable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { AppError, ErrorCode, MailSendError } from "@civfix/shared"

let prod = false
vi.mock("../../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/env.js")>()
  return { ...actual, isProd: () => prod }
})

const captured: unknown[] = []
vi.mock("../../src/errors/glitchtip.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/errors/glitchtip.js")>()
  return {
    ...actual,
    captureError: (err: unknown) => {
      captured.push(err)
    },
  }
})

const { makeErrorHandler, makeNotFoundHandler } = await import("../../src/errors/http-mapper.js")
const { exposeMessage } = await import("../../src/errors/exposed-message.js")

const SMTP_DIAGNOSTIC =
  "Email not sent: the SMTP server rejected our credentials. Check OCI_EMAIL_SMTP_USER / OCI_EMAIL_SMTP_PASS."
const FORM_UNAVAILABLE = "This form is temporarily unavailable. Please try again later."

interface Probe {
  app: FastifyInstance
  logLines: string[]
}

async function buildProbe(thrown: () => unknown): Promise<Probe> {
  const logLines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString())
      done()
    },
  })
  const app = Fastify({ logger: { level: "info", stream }, disableRequestLogging: true })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  app.get("/v1/throw", async () => {
    throw thrown()
  })
  app.post("/v1/admin/mail/send", async () => {
    throw thrown()
  })
  await app.ready()
  return { app, logLines }
}

beforeEach(() => {
  prod = false
  captured.length = 0
})

describe("5xx AppError messages in production", () => {
  it("hides an internal AppError message but still logs and reports it", async () => {
    const { app, logLines } = await buildProbe(() => AppError.internal("db exploded"))
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ code: ErrorCode.INTERNAL, message: "Internal error" })
    expect(captured).toHaveLength(1)
    expect(logLines.join("")).toContain("db exploded")
    await app.close()
  })

  it("hides an SMTP credential diagnostic on a public route", async () => {
    const { app } = await buildProbe(
      () => new MailSendError(ErrorCode.INTERNAL, SMTP_DIAGNOSTIC, {}),
    )
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.statusCode).toBe(500)
    expect(res.json().message).toBe("Internal error")
    expect(captured).toHaveLength(1)
    await app.close()
  })

  it("keeps a message that was deliberately marked safe to show", async () => {
    const { app } = await buildProbe(() => exposeMessage(AppError.internal(FORM_UNAVAILABLE)))
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.statusCode).toBe(500)
    expect(res.json().message).toBe(FORM_UNAVAILABLE)
    await app.close()
  })

  it("keeps the diagnostic on an operator-plane route", async () => {
    const { app } = await buildProbe(
      () => new MailSendError(ErrorCode.INTERNAL, SMTP_DIAGNOSTIC, {}),
    )
    prod = true

    const res = await app.inject({ method: "POST", url: "/v1/admin/mail/send" })

    expect(res.statusCode).toBe(500)
    expect(res.json().message).toBe(SMTP_DIAGNOSTIC)
    await app.close()
  })

  it("does not treat a query string mentioning the admin plane as the operator plane", async () => {
    const { app } = await buildProbe(() => AppError.internal("db exploded"))
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw?next=/v1/admin/mail/send" })

    expect(res.json().message).toBe("Internal error")
    await app.close()
  })

  it("still echoes the message outside production", async () => {
    const { app } = await buildProbe(() => AppError.internal("db exploded"))

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.json().message).toBe("db exploded")
    await app.close()
  })

  it("leaves 4xx AppError messages untouched in production", async () => {
    const { app } = await buildProbe(() => AppError.conflict("Handle already taken."))
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe("Handle already taken.")
    await app.close()
  })
})

describe("not-found logging", () => {
  it("logs the path without its query string", async () => {
    const { app, logLines } = await buildProbe(() => new Error("unused"))

    const res = await app.inject({ method: "GET", url: "/v1/nope?accessCode=SECRET-CODE" })

    expect(res.statusCode).toBe(404)
    const notFound = logLines.filter((l) => l.includes("route not found"))
    expect(notFound).toHaveLength(1)
    expect(notFound[0]).toContain("/v1/nope")
    expect(logLines.join("")).not.toContain("SECRET-CODE")
    await app.close()
  })
})

describe("user-facing 5xx messages stay readable in production", () => {
  it("keeps the identity-provider outage message", async () => {
    const { RemoteJwksVerifier } = await import("../../src/auth/jwks.js")
    const verifier = new RemoteJwksVerifier({
      fetchImpl: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    })
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url")
    const outage = await verifier
      .verify(`${header}.e30.c2ln`, { jwksUrl: "https://jwks.test", issuers: [], audiences: [] })
      .catch((err: unknown) => err)
    const { app } = await buildProbe(() => outage)
    prod = true

    const res = await app.inject({ method: "GET", url: "/v1/throw" })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).toBe("Could not reach the identity provider.")
    await app.close()
  })
})
