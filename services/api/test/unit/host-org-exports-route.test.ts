import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerHostExportRoutes } from "../../src/routes/host/exports.routes.js"
import type { HostExportService } from "../../src/services/host/export-service.js"
import type { HostExportDTO } from "@civfix/shared"

const USER = "11111111-1111-4111-8111-111111111111"
const ORG = "22222222-2222-4222-8222-222222222222"
const EVENT = "33333333-3333-4333-8333-333333333333"
const EXPORT = "44444444-4444-4444-8444-444444444444"

function exportDto(patch: Partial<HostExportDTO> = {}): HostExportDTO {
  return {
    id: EXPORT,
    cleanupId: null,
    kind: "donations",
    status: "ready",
    rowCount: 12,
    byteSize: 4096,
    truncated: false,
    requestedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:00:10.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
    ...patch,
  } as HostExportDTO
}

interface Harness {
  app: FastifyInstance
  orgCapabilityChecks: { organizationId: string; capability: string }[]
  eventCapabilityChecks: { cleanupId: string; capability: string }[]
}

async function harness(options: { orgDenied?: boolean } = {}): Promise<Harness> {
  const orgCapabilityChecks: { organizationId: string; capability: string }[] = []
  const eventCapabilityChecks: { cleanupId: string; capability: string }[] = []

  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?")
      if (text.includes("organization_members")) {
        orgCapabilityChecks.push({
          organizationId: String(values[0]),
          capability: "view_donations",
        })
        return Promise.resolve(options.orgDenied === true ? [] : [{ role: "owner" }])
      }
      eventCapabilityChecks.push({ cleanupId: String(values[0]), capability: "unknown" })
      return Promise.resolve([])
    },
    { json: (value: unknown) => value },
  )

  const exports: HostExportService = {
    request: () => Promise.resolve(exportDto()),
    listForEvent: () => Promise.resolve([]),
    listForOrganization: (organizationId: string) =>
      Promise.resolve(organizationId === ORG ? [exportDto()] : []),
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
        filename: "donations.csv",
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
  return { app, orgCapabilityChecks, eventCapabilityChecks }
}

describe("org-scoped donation exports have a retrieval path", () => {
  it("lists them — listEventExports never could, they carry no cleanup id", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: `/v1/orgs/${ORG}/donations/exports` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: { id: string; kind: string; cleanupId: string | null }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.kind).toBe("donations")
    expect(body.items[0]?.cleanupId).toBeNull()
  })

  it("gates the list on view_donations against the ORGANIZATION, not export on an event", async () => {
    const h = await harness()
    await h.app.inject({ method: "GET", url: `/v1/orgs/${ORG}/donations/exports` })
    expect(h.orgCapabilityChecks).toEqual([
      { organizationId: ORG, capability: "view_donations" },
    ])
    expect(h.eventCapabilityChecks).toHaveLength(0)
  })

  it("404s the list for someone with no standing on the organization", async () => {
    const h = await harness({ orgDenied: true })
    const res = await h.app.inject({ method: "GET", url: `/v1/orgs/${ORG}/donations/exports` })
    expect(res.statusCode).toBe(404)
  })

  it("downloads an org-scoped export and RE-CHECKS the org capability at download time", async () => {
    const h = await harness()
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/me/host-exports/${EXPORT}/download`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { filename: string }).filename).toBe("donations.csv")
    expect(h.orgCapabilityChecks).toEqual([
      { organizationId: ORG, capability: "view_donations" },
    ])
  })

  it("refuses the download once the requester has lost standing on the organization", async () => {
    const h = await harness({ orgDenied: true })
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/me/host-exports/${EXPORT}/download`,
    })
    expect(res.statusCode).toBe(404)
  })
})

void EVENT
