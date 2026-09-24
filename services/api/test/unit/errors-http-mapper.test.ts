/**
 * Direct tests for the canonical error handler (src/errors/http-mapper.ts). It was previously covered only
 * incidentally, through route tests, so its most consequential behaviors were unpinned:
 *
 *   - the STRUCTURAL ZodError branch (name + issues array, NOT instanceof) that keeps a ZodError thrown
 *     across the dual-zod-realm boundary from rendering as a 500,
 *   - the STATUS_TO_CODE reverse map the typed client relies on,
 *   - PROD MESSAGE HIDING on a 500 (a leaked internal message is an information-disclosure regression),
 *   - captureError forwarding for >=500 only,
 *   - the not-found handler's prod-stealth vs dev-echo message.
 *
 * The handler is driven through a real Fastify instance via app.inject, exactly as buildServer wires it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { AppError, ErrorCode } from "@civfix/shared"

/** Flipped per test; the handler reads isProd() at response time. */
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

interface ErrorBody {
  code: string
  message: string
  requestId: string
  fields?: Record<string, string>
}

/** A probe server whose routes throw the error under test. */
async function buildProbe(thrown: () => unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  app.post(
    "/boom",
    {
      schema: {
        body: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
      },
    },
    async () => ({ ok: true }),
  )
  app.get("/throw", async () => {
    throw thrown()
  })
  await app.ready()
  return app
}

beforeEach(() => {
  prod = false
  captured.length = 0
})

describe("makeErrorHandler", () => {
  it("renders an AppError with its own status, code, fields and the request id", async () => {
    const app = await buildProbe(() =>
      AppError.validation({ handle: "already taken" }, "Bad handle"),
    )
    const res = await app.inject({ method: "GET", url: "/throw" })
    const body = res.json<ErrorBody>()

    expect(res.statusCode).toBe(422)
    expect(body.code).toBe(ErrorCode.VALIDATION)
    expect(body.message).toBe("Bad handle")
    expect(body.fields).toEqual({ handle: "already taken" })
    expect(body.requestId).toBeTruthy()
    // A client AppError is NOT forwarded to the error tracker.
    expect(captured).toHaveLength(0)
    await app.close()
  })

  it("forwards a server-side AppError (>=500) to captureError", async () => {
    const app = await buildProbe(() => AppError.internal("db exploded"))
    const res = await app.inject({ method: "GET", url: "/throw" })
    expect(res.statusCode).toBe(500)
    expect(captured).toHaveLength(1)
    await app.close()
  })

  it("maps a FOREIGN ZodError-shaped error to 422 by structure, not instanceof", async () => {
    // Mimics a ZodError from a DIFFERENT zod realm: right name + issues, wrong prototype.
    const app = await buildProbe(() => {
      const err = new Error("zod failed") as Error & { issues: unknown[] }
      err.name = "ZodError"
      err.issues = [
        { path: ["body", "email"], message: "Invalid email" },
        { path: [], message: "root problem" },
      ]
      return err
    })
    const res = await app.inject({ method: "GET", url: "/throw" })
    const body = res.json<ErrorBody>()

    expect(res.statusCode).toBe(422)
    expect(body.code).toBe(ErrorCode.VALIDATION)
    expect(body.fields).toEqual({ "body.email": "Invalid email", _: "root problem" })
    // 422 is a client outcome: nothing is reported to the error tracker.
    expect(captured).toHaveLength(0)
    await app.close()
  })

  it("maps a Fastify schema-validation failure to 422 with the last path segment as the field key", async () => {
    const app = await buildProbe(() => new Error("unused"))
    const res = await app.inject({ method: "POST", url: "/boom", payload: {} })
    const body = res.json<ErrorBody>()

    expect(res.statusCode).toBe(422)
    expect(body.code).toBe(ErrorCode.VALIDATION)
    expect(Object.keys(body.fields ?? {})).toContain("email")
    await app.close()
  })

  it("maps a non-AppError client status through STATUS_TO_CODE and keeps its message", async () => {
    const app = await buildProbe(() => {
      const err = new Error("nope") as Error & { statusCode: number }
      err.statusCode = 409
      return err
    })
    const res = await app.inject({ method: "GET", url: "/throw" })
    const body = res.json<ErrorBody>()

    expect(res.statusCode).toBe(409)
    expect(body.code).toBe(ErrorCode.CONFLICT)
    expect(body.message).toBe("nope")
    expect(captured).toHaveLength(0)
    await app.close()
  })

  it("falls back to VALIDATION for an unmapped client status", async () => {
    const app = await buildProbe(() => {
      const err = new Error("teapot") as Error & { statusCode: number }
      err.statusCode = 418
      return err
    })
    const res = await app.inject({ method: "GET", url: "/throw" })
    expect(res.statusCode).toBe(418)
    expect(res.json<ErrorBody>().code).toBe(ErrorCode.VALIDATION)
    await app.close()
  })

  it("echoes a plain Error's message in dev but HIDES it in production", async () => {
    const app = await buildProbe(() => new Error("connection string leaked here"))

    const dev = await app.inject({ method: "GET", url: "/throw" })
    expect(dev.statusCode).toBe(500)
    expect(dev.json<ErrorBody>().code).toBe(ErrorCode.INTERNAL)
    expect(dev.json<ErrorBody>().message).toBe("connection string leaked here")

    prod = true
    const live = await app.inject({ method: "GET", url: "/throw" })
    expect(live.statusCode).toBe(500)
    expect(live.json<ErrorBody>().message).toBe("Internal error")
    expect(live.json<ErrorBody>().message).not.toContain("leaked")
    // Both unhandled errors were reported.
    expect(captured).toHaveLength(2)
    await app.close()
  })
})

describe("makeNotFoundHandler", () => {
  it("echoes method+url in dev and is stealthy in production", async () => {
    const app = await buildProbe(() => new Error("unused"))

    const dev = await app.inject({ method: "GET", url: "/no/such/route" })
    expect(dev.statusCode).toBe(404)
    expect(dev.json<ErrorBody>().code).toBe(ErrorCode.NOT_FOUND)
    expect(dev.json<ErrorBody>().message).toBe("Route GET /no/such/route not found")

    prod = true
    const live = await app.inject({ method: "GET", url: "/no/such/route" })
    expect(live.statusCode).toBe(404)
    expect(live.json<ErrorBody>().message).toBe("Not found")
    await app.close()
  })
})
