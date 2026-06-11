/**
 * FULL ROUTE-REGISTRATION AUDIT + BOOT SMOKE TEST.
 *
 * Imports the canonical endpoint registry from @civfix/shared/client (the single source of truth the
 * web + mobile clients call) and, against a server built with ALL fakes/overrides (no Docker, no infra),
 * asserts EVERY one of the 113 endpoints (47 Phase 1 + 66 Phase 2 admin) is REGISTERED and reachable:
 * app.inject for each returns something OTHER than Fastify's route-not-found 404. This proves the entire
 * contract surface is wired.
 *
 * What "registered" means here: a matched route runs SOME handler (auth guard, validation, or the
 * handler body), so the response is NOT produced by Fastify's notFound handler. We discriminate the two
 * 404 kinds precisely: the notFound handler emits the message `Route {METHOD} {URL} not found`, whereas a
 * domain 404 (e.g. GET /reports/:id for a missing id) is an AppError with a different message. A passing
 * endpoint may legitimately answer 200/400/401/403/404(domain)/422 - only the route-missing 404 fails.
 *
 * This also doubles as a BOOT smoke test: buildServer wires the auth bundle + every domain plugin and
 * mounts with zero external services, exercising the whole registration path in one shot.
 */

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
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import { InMemoryMediaRepository } from "../helpers/media.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import type { ReportOwner } from "../../src/services/report-service.js"

const SIGNING_KEY = "test-anon-signing-key"

/** A concrete value substituted for each `:param` path segment so the route matches. */
const PARAM_VALUE = "11111111-1111-1111-1111-111111111111"

/**
 * Build one server with the FULL fakes/overrides bundle so every domain plugin mounts and resolves with
 * no infra. Auth services are present so the /auth/* routes mount.
 */
async function buildFullFakeServer(): Promise<FastifyInstance> {
  const env = loadEnv({ NODE_ENV: "test" })

  // Auth bundle (in-memory) so auth routes mount + the dual-auth context works offline.
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

  // Reports (+ media presign) over an in-memory repo.
  const reportRepo = new InMemoryReportRepository()
  const reportOverrides: ReportServiceOverrides = {
    repo: reportRepo,
    resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
    presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
  }

  // Anon + claim services over a shared in-memory store + fakes.
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
      timeline: [],
    })
  }
  const claimService = makeClaimService({
    repo: anonStore.claimRepo(),
    anonTokenSigningKey: SIGNING_KEY,
    getReportForOwner,
  })

  // Cleanups / social / notifications / media / chat over in-memory repos.
  const cleanupRepo = new InMemoryCleanupRepository()
  const socialRepo = new InMemorySocialRepository()
  const notificationRepo = new InMemoryNotificationRepository()
  const mediaRepo = new InMemoryMediaRepository()
  const chatOverrides: ChatGatewayOverrides = {
    isMember: () => Promise.resolve(true),
    threadsRepo: new InMemoryThreadsRepository(),
  }

  // Default test container: all seams are fakes (chat/push/jobs etc.).
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
    notificationOverrides: { repo: notificationRepo },
    mediaRepo,
    chatOverrides,
  })
}

/** Substitute every `:param` segment in a path template with a concrete value. */
function fillPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? PARAM_VALUE : seg))
    .join("/")
}

/**
 * For a GET/DELETE endpoint inject without a body; for write methods send an empty JSON object. The
 * handler may answer 400/401/422 - all acceptable. We only care the route MATCHED.
 */
function injectArgs(ep: EndpointDef): InjectOptions {
  // Inject at the VERSIONED wire path (e.g. /v1/reports), the same path the typed client calls and the
  // route() helper registers — so this audit proves the contract surface is wired at its real URL.
  const url = fillPath(versionedPath(ep))
  if (ep.method === "GET" || ep.method === "DELETE") {
    return { method: ep.method, url }
  }
  return { method: ep.method, url, payload: {} }
}

// One server for the whole file: built once in beforeAll so endpoint assertions never race on setup
// order, torn down in afterAll. The inject calls are read-only route matching, so sharing is safe.
let app: FastifyInstance

beforeAll(async () => {
  app = await buildFullFakeServer()
})

afterAll(async () => {
  await app.close()
})

describe("route-coverage: every shared endpoint is registered (offline boot smoke test)", () => {
  it("boots a fully-faked server with no infra (liveness routes)", async () => {
    // The app is up and routing: /healthz answers 200 with no DB/Redis.
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })

  // One assertion per endpoint so a failure names exactly which route is unwired.
  for (const [name, ep] of Object.entries(endpoints)) {
    it(`registers ${name}: ${ep.method} ${ep.path}`, async () => {
      const res = await app.inject(injectArgs(ep))

      // The ONLY failing condition: Fastify's route-not-found handler ran (no route matched). It emits a
      // body whose message begins with `Route {METHOD} {URL} not found`; a domain 404 does not.
      if (res.statusCode === 404) {
        const body = res.json() as { message?: string }
        const isRouteMissing =
          typeof body.message === "string" && body.message.startsWith(`Route ${ep.method} `)
        expect(isRouteMissing, `endpoint ${name} (${ep.method} ${ep.path}) is NOT registered`).toBe(
          false,
        )
      }
      // Any non-404 status (200/400/401/403/422/...) means the route is wired and a handler ran.
      expect(res.statusCode).not.toBe(undefined)
    })
  }

  it("covers ALL 123 endpoints in the registry (no endpoint skipped)", () => {
    // 47 Phase 1 + 66 Phase 2 admin + the DM/privacy surface (openDm, dmMessages, searchUsers, blockUser,
    // unblockUser, listBlocks, updateSettings = 7) plus the inbound-mail surface (3) = 123. The admin OTP
    // request/verify routes were replaced by the single Cloudflare Access exchange route (doc 16); the
    // admin data routes mount under requireOperator (an unauthenticated inject returns 401, a wired route);
    // the public Access exchange returns 503 when CF_ACCESS_* is unset (also wired, not a route-missing
    // 404) - exactly what the per-endpoint assertions check.
    expect(Object.keys(endpoints).length).toBe(123)
  })

  it("the discriminator is not vacuous: a bogus path IS detected as route-missing", async () => {
    const res = await app.inject({ method: "GET", url: "/this/route/does/not/exist" })
    expect(res.statusCode).toBe(404)
    const body = res.json() as { message?: string; code?: string }
    // Proves the route-missing 404 is shaped exactly as the assertion above keys on.
    expect(body.message?.startsWith("Route GET ")).toBe(true)
    expect(body.code).toBe("NOT_FOUND")
  })
})
