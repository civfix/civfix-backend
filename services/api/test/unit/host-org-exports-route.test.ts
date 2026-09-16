import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerHostExportRoutes } from "../../src/routes/host/exports.routes.js"
import type { HostExportService } from "../../src/services/host/export-service.js"

const USER = "11111111-1111-4111-8111-111111111111"
const ORG = "22222222-2222-4222-8222-222222222222"
const EXPORT = "44444444-4444-4444-8444-444444444444"

interface Harness {
  app: FastifyInstance
  capabilityChecks: string[]
}

async function harness(): Promise<Harness> {
  const capabilityChecks: string[] = []

  const sql = Object.assign(
    (_strings: TemplateStringsArray, ...values: unknown[]) => {
      capabilityChecks.push(String(values[0]))
      return Promise.resolve([])
    },
    { json: (value: unknown) => value },
  )

  const exports: HostExportService = {
    request: () => Promise.reject(new Error("not used")),
    listForEvent: () => Promise.resolve([]),
    listForOrganization: () => Promise.resolve([]),
    get: () =>
      Promise.resolve({
        id: EXPORT,
        cleanupId: null,
        organizationId: ORG,
        requestedBy: USER,
      } as never),
    run: () => Promise.resolve({ status: "ready" as const }),
    downloadUrl: () =>
      Promise.resolve({
        url: "https://example.test/export.csv",
        expiresAt: "2026-09-01T00:05:00.000Z",
        filename: "legacy.csv",
      }),
    reap: () => Promise.resolve({ reaped: 0 }),
  }

  const container = {
    env: { NODE_ENV: "test", WEB_ORIGINS: ["https://civfix.org"] },
    storage: new FakeStorage(),
    csrf: { protect: (_r: unknown, _p: unknown, done: () => void) => done() },
    getDb: () => ({ sql }),
  } as unknown as Container

  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const allowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", allowed)
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: USER, roles: ["citizen"] }
    done()
  })
  app.decorate("hostExportOverrides", { exports })
  await registerHostExportRoutes(app, container)
  await app.ready()
  return { app, capabilityChecks }
}

describe("host exports are event-scoped only", () => {
  it("refuses to hand back a legacy org-scoped export, and checks no capability to decide it", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/me/host-exports/${EXPORT}/download`,
    })
    expect(res.statusCode).toBe(404)
    expect(h.capabilityChecks).toHaveLength(0)
  })
})
