
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, InjectOptions } from "fastify"
import { FakeAbuseChecks, FakeMailer } from "@civfix/shared/fakes"
import { endpoints, versionedPath, type EndpointDef } from "@civfix/shared/client"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeAnonService } from "../../src/services/anon-service.js"
import { makeClaimService } from "../../src/services/claim-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { InMemoryAnonStore } from "../helpers/anon.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemorySocialRepository } from "../helpers/social.js"
import { InMemoryVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.memory.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import { InMemoryMediaRepository } from "../helpers/media.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import type { ReportOwner } from "../../src/services/report-service.js"

const SIGNING_KEY = "test-anon-signing-key"

const PARAM_VALUE = "11111111-1111-1111-1111-111111111111"

const NOT_YET_ROUTED = new Set<string>([])

async function buildFullFakeServer(): Promise<FastifyInstance> {
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

  const reportRepo = new InMemoryReportRepository()
  const reportOverrides: ReportServiceOverrides = {
    repo: reportRepo,
    resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
    presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
  }

  const anonStore = new InMemoryAnonStore()
  const abuse = new FakeAbuseChecks()
  const counters = new InMemoryCounterStore(() => 0)
  let n = 0
  const anonService = makeAnonService({
    repo: anonStore.anonReportRepo(),
    abuseChecks: abuse,
    counters,
    anonTokenSigningKey: SIGNING_KEY,
    resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
    newId: () => randomUUID(),
    newClaimCode: () => `claim-${++n}`,
    newAnonTokenId: () => `anontok-${n}`,
  })
  const getReportForOwner = (reportId: string, owner: ReportOwner) => {
    const rec = anonStore.reports.get(reportId)
    if (!rec) return Promise.reject(new Error("missing"))
    return Promise.resolve({
      id: rec.id,
      category: rec.category as "trash",
      status: rec.status,
      visibility: rec.visibility,
      lat: rec.lat,
      lng: rec.lng,
      geomSource: "device" as const,
      createdAt: rec.createdAt.toISOString(),
      mine: rec.reporterUserId === owner.userId,
      gov: false,
      following: false,
      media: [],
      mediaPending: 0,
      timeline: [],
      linkedEvents: [],
    })
  }
  const claimService = makeClaimService({
    repo: anonStore.claimRepo(),
    anonTokenSigningKey: SIGNING_KEY,
    getReportForOwner,
  })

  const cleanupRepo = new InMemoryCleanupRepository()
  const socialRepo = new InMemorySocialRepository()
  const notificationRepo = new InMemoryNotificationRepository()
  const mediaRepo = new InMemoryMediaRepository()
  const chatOverrides: ChatGatewayOverrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
  }

  const container = buildContainer(env)

  return buildServer({
    env,
    container,
    authServices,
    reportOverrides,
    anonOverride: { service: anonService },
    claimOverride: { service: claimService },
    cleanupOverrides: { repo: cleanupRepo },
    socialOverrides: { repo: socialRepo },
    volunteerOverrides: { repo: new InMemoryVolunteerHoursRepository() },
    notificationOverrides: { repo: notificationRepo },
    mediaRepo,
    chatOverrides,
  })
}

function fillPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? PARAM_VALUE : seg))
    .join("/")
}

function injectArgs(ep: EndpointDef): InjectOptions {
  const url = fillPath(versionedPath(ep))
  if (ep.method === "GET" || ep.method === "DELETE") {
    return { method: ep.method, url }
  }
  return { method: ep.method, url, payload: {} }
}

let app: FastifyInstance

beforeAll(async () => {
  app = await buildFullFakeServer()
})

afterAll(async () => {
  await app.close()
})

describe("route-coverage: every shared endpoint is registered (offline boot smoke test)", () => {
  it("boots a fully-faked server with no infra (liveness routes)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })

  for (const [name, ep] of Object.entries(endpoints)) {
    it.skipIf(NOT_YET_ROUTED.has(name))(`registers ${name}: ${ep.method} ${ep.path}`, async () => {
      const res = await app.inject(injectArgs(ep))

      if (res.statusCode === 404) {
        const body = res.json() as { message?: string }
        const isRouteMissing =
          typeof body.message === "string" && body.message.startsWith(`Route ${ep.method} `)
        expect(isRouteMissing, `endpoint ${name} (${ep.method} ${ep.path}) is NOT registered`).toBe(
          false,
        )
      }
      expect(res.statusCode).not.toBe(undefined)
    })
  }

  it("covers ALL 173 endpoints in the registry (no endpoint skipped)", () => {
    expect(Object.keys(endpoints).length).toBe(173)
  })

  it("the discriminator is not vacuous: a bogus path IS detected as route-missing", async () => {
    const res = await app.inject({ method: "GET", url: "/this/route/does/not/exist" })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { message?: string; code?: string }
    expect(body.message?.startsWith("Route GET ")).toBe(true)
    expect(body.code).toBe("NOT_FOUND")
  })
})
