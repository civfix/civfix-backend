/**
 * What the SDK would actually send to GlitchTip for a failing request, recorded at the transport: the
 * real init, the real error handler and a real HTTP request carrying every kind of personal data the
 * SDK knows how to collect.
 */

import { AppError, ErrorCode } from "@civfix/contract"
import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { flushErrorReporting, initErrorReporting } from "../../src/errors/glitchtip.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import {
  D12_DATA_COLLECTION,
  FAKE_GLITCHTIP_DSN,
  recordingTransport,
  sentryClientOptions,
} from "../helpers/sentry-transport.js"

const recorder = recordingTransport()

// The keys of `request` the same T2 request produced on @sentry/node 10, recorded on CIV-706 before the bump.
const SENTRY_10_REQUEST_KEYS = ["method", "url"]

const SECRETS = [
  "resident@example.com",
  "q-secret",
  "cookie-secret",
  "header-secret",
  "203.0.113.7",
  "body-secret",
  "local-secret",
]

const HTTP_BAD_REQUEST = 400

type SentEvent = Record<string, unknown> & {
  request?: Record<string, unknown>
  extra?: Record<string, unknown>
  exception?: { values?: { stacktrace?: { frames?: Record<string, unknown>[] } }[] }
}

let initialized: boolean
let app: FastifyInstance
let base: string
let seenHeaders: Record<string, unknown> = {}

beforeAll(async () => {
  initialized = await initErrorReporting({
    dsn: FAKE_GLITCHTIP_DSN,
    environment: "test",
    transport: recorder.transport,
  })
  app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.post("/throw", async (request) => {
    seenHeaders = request.headers
    const localSecret = "local-secret"
    void localSecret
    throw new Error("boom")
  })
  app.get("/throw-app", async () => {
    throw new AppError(ErrorCode.INTERNAL, "app boom")
  })
  app.get("/throw-404", async () => {
    throw new AppError(ErrorCode.NOT_FOUND, "missing")
  })
  app.get("/throw-400", async () => {
    throw Object.assign(new Error("bad input"), { statusCode: HTTP_BAD_REQUEST })
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  await flushErrorReporting()
  recorder.clear()
})

async function requestIdOf(res: Response): Promise<string> {
  const body = (await res.json()) as { requestId: string }
  return body.requestId
}

describe("GlitchTip reporting on @sentry/node (recorded at the transport)", () => {
  it("T1: initializes with D12's dataCollection and no sendDefaultPii", () => {
    expect(initialized).toBe(true)
    const options = sentryClientOptions() ?? {}
    expect(options.dataCollection).toEqual(D12_DATA_COLLECTION)
    expect(options).not.toHaveProperty("sendDefaultPii")
  })

  it("T2: a failing request sends one event with none of the request's personal data", async () => {
    const res = await fetch(`${base}/throw?email=resident%40example.com&token=q-secret`, {
      method: "POST",
      headers: {
        Cookie: "sid=cookie-secret",
        Authorization: "Bearer header-secret",
        "X-Forwarded-For": "203.0.113.7",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "body-secret" }),
    })
    expect(res.status).toBe(500)
    const requestId = await requestIdOf(res)
    await flushErrorReporting()

    // The request really carried the data, so its absence below is the SDK's and the scrubbing's doing.
    expect(seenHeaders.cookie).toBe("sid=cookie-secret")

    const events = recorder.items("event") as SentEvent[]
    expect(events).toHaveLength(1)
    expect(recorder.items("transaction")).toHaveLength(0)
    const event = events[0]!
    expect(event).not.toHaveProperty("user")
    if (event.request !== undefined) {
      const keys = Object.keys(event.request)
      for (const key of keys) {
        expect(["method", "url"]).toContain(key)
        expect(SENTRY_10_REQUEST_KEYS).toContain(key)
      }
      if (event.request.url !== undefined)
        expect(event.request.url).not.toEqual(expect.stringContaining("?"))
    }
    const frames = (event.exception?.values ?? []).flatMap((v) => v.stacktrace?.frames ?? [])
    for (const frame of frames) expect(frame).not.toHaveProperty("vars")
    expect(event).not.toHaveProperty("breadcrumbs")
    expect(event.extra?.requestId).toBe(requestId)

    const serialized = recorder.serialized()
    for (const secret of SECRETS) expect(serialized).not.toContain(secret)
  })

  it("T3: a thrown 500 AppError sends exactly one event, ours", async () => {
    const res = await fetch(`${base}/throw-app`)
    expect(res.status).toBe(500)
    const requestId = await requestIdOf(res)
    await flushErrorReporting()

    const events = recorder.items("event") as SentEvent[]
    expect(events).toHaveLength(1)
    expect(events[0]!.extra?.requestId).toBe(requestId)
  })

  it("T4: a thrown 404 AppError sends nothing", async () => {
    const res = await fetch(`${base}/throw-404`)
    expect(res.status).toBe(404)
    await flushErrorReporting()

    expect(recorder.items("event")).toHaveLength(0)
  })

  it("T5: a thrown Error with statusCode 400 sends nothing", async () => {
    const res = await fetch(`${base}/throw-400`)
    expect(res.status).toBe(400)
    await flushErrorReporting()

    expect(recorder.items("event")).toHaveLength(0)
  })
})
