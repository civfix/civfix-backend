import { describe, it, expect, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { FakeAbuseChecks, FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { buildContainer, type Container } from "../../src/di.js"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import { makeAnonService } from "../../src/services/anon-service.js"
import { makeClaimService } from "../../src/services/claim-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { InMemoryAnonStore } from "../helpers/anon.js"
import { clientQuery } from "../helpers/query.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"
import type { ReportOwner } from "../../src/services/report-service.js"


const SIGNING_KEY = "test-anon-signing-key"
const KEY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

interface Harness {
  app: FastifyInstance
  anonStore: InMemoryAnonStore
  reportRepo: InMemoryReportRepository
  abuse: FakeAbuseChecks
  token: string
  userId: string
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })

  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const verifier = new StubJwksVerifier()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier,
    now: () => Date.now(),
  })

  const anonStore = new InMemoryAnonStore()
  const reportRepo = new InMemoryReportRepository()
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

  const reportOverrides: ReportServiceOverrides = {
    repo: reportRepo,
    resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
    presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
  }

  const app = await buildServer({
    env,
    authServices,
    reportOverrides,
    anonOverride: { service: anonService },
    claimOverride: { service: claimService },
  })

  const email = "claimer@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  const h: Harness = {
    app,
    anonStore,
    reportRepo,
    abuse,
    token: body.token,
    userId: body.user.id,
  }
  current = h
  return h
}

function anonPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: KEY_A,
    turnstileToken: "ok",
    category: "trash",
    type: "dump",
    lat: 34.1,
    lng: -118.35,
    geomSource: "device",
    mediaUploadIds: [],
    ...over,
  }
}

function mirrorHeldIntoReportRepo(h: Harness, reportId: string): void {
  const r = h.anonStore.reports.get(reportId)!
  h.reportRepo.seedReport({
    id: r.id,
    reporterUserId: null,
    anonSessionId: r.anonSessionId,
    status: r.status,
    visibility: r.visibility,
    category: r.category as "trash",
    lat: r.lat,
    lng: r.lng,
    publishedAt: r.publishedAt,
  })
}

describe("POST /anon/reports", () => {
  it("creates a HELD report (202) with a claim code and issues an anon token", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.status).toBe("held")
    expect(typeof body.reportId).toBe("string")
    expect(typeof body.claimCode).toBe("string")
    expect(res.headers["x-anon-token"]).toBeTruthy()
    const setCookie = res.headers["set-cookie"]
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie as string]
    expect(lines.some((l) => l.startsWith("civfix_anon="))).toBe(true)
  })

  it("rejects a failed Turnstile with 403 TURNSTILE_FAILED", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ turnstileToken: "fail" }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("TURNSTILE_FAILED")
  })

  it("rejects a honeypot-filled body with 422 and creates nothing", async () => {
    const { app, anonStore } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ honeypot: "bot" }),
    })
    expect(res.statusCode).toBe(422)
    expect(anonStore.reports.size).toBe(0)
    const body = res.json()
    expect(JSON.stringify(body)).not.toContain("honeypot")
    expect(body.fields ?? {}).not.toHaveProperty("honeypot")
  })

  it("replays the original response for a duplicate idempotency key (still 202, same report)", async () => {
    const { app, anonStore } = await makeHarness()
    const first = await app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const firstBody = first.json()
    // The replay is the SAME anon session retrying: it carries the token the first submit issued,
    // which is what the snapshot is keyed by (F028).
    const anonToken = first.headers["x-anon-token"] as string
    const second = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ anonToken }),
    })
    expect(second.statusCode).toBe(202)
    expect(second.json().reportId).toBe(firstBody.reportId)
    expect(second.json().claimCode).toBe(firstBody.claimCode)
    expect(anonStore.reports.size).toBe(1)
  })

  it("F028: a DIFFERENT anon session reusing the key gets 409, never the first submitter's snapshot", async () => {
    const { app, anonStore } = await makeHarness()
    const first = await app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const firstBody = first.json()

    const other = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      headers: { cookie: "civfix_anon=" },
      payload: anonPayload(),
    })
    expect(other.statusCode).toBe(409)
    expect(other.payload).not.toContain(firstBody.claimCode)
    expect(other.payload).not.toContain(firstBody.reportId)
    expect(anonStore.reports.size).toBe(1)
  })

  it("422s a malformed body (bad category)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ category: "not-a-category" }),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("web anon token round-trips via the civfix_anon cookie (P1-2)", () => {
  function readAnonCookie(res: { headers: Record<string, unknown> }): string | undefined {
    const raw = res.headers["set-cookie"]
    const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [raw as string] : []
    const line = lines.find((l) => l.startsWith("civfix_anon="))
    if (!line) return undefined
    return decodeURIComponent(line.slice("civfix_anon=".length).split(";")[0]!)
  }

  it("a second submit carrying ONLY the civfix_anon cookie reuses the same token (report_count -> 2)", async () => {
    const { app, anonStore } = await makeHarness()

    const first = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ idempotencyKey: "11111111-1111-1111-1111-111111111111" }),
    })
    expect(first.statusCode).toBe(202)
    const cookie = readAnonCookie(first)
    expect(cookie).toBeTruthy()
    expect(anonStore.tokens.size).toBe(1)
    const tokenId = [...anonStore.tokens.keys()][0]!
    expect(anonStore.tokens.get(tokenId)!.reportCount).toBe(1)

    const second = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      headers: { cookie: `civfix_anon=${encodeURIComponent(cookie!)}` },
      payload: anonPayload({ idempotencyKey: "22222222-2222-2222-2222-222222222222" }),
    })
    expect(second.statusCode).toBe(202)

    expect(anonStore.tokens.size).toBe(1)
    expect(anonStore.tokens.get(tokenId)!.reportCount).toBe(2)
    expect(second.headers["x-anon-token"]).toBeUndefined()
  })

  it("an explicit body anonToken still wins over the cookie", async () => {
    const { app, anonStore } = await makeHarness()
    const first = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ idempotencyKey: "33333333-3333-3333-3333-333333333333" }),
    })
    const bodyToken = first.headers["x-anon-token"] as string
    expect(bodyToken).toBeTruthy()
    const tokenId = [...anonStore.tokens.keys()][0]!

    const second = await app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      headers: { cookie: "civfix_anon=bogus.signature" },
      payload: anonPayload({
        idempotencyKey: "44444444-4444-4444-4444-444444444444",
        anonToken: bodyToken,
      }),
    })
    expect(second.statusCode).toBe(202)
    expect(anonStore.tokens.size).toBe(1)
    expect(anonStore.tokens.get(tokenId)!.reportCount).toBe(2)
  })
})

describe("held anon report stays hidden", () => {
  it("is absent from GET /map/reports, 404s on GET /reports/:id, but its status is visible with the code", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ lat: 34.1, lng: -118.35 }),
    })
    const { reportId, claimCode } = submit.json()
    mirrorHeldIntoReportRepo(h, reportId)

    const map = await h.app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: { west: -119, south: 33, east: -118, north: 35 }, zoom: 16 })}`,
    })
    expect(map.statusCode).toBe(200)
    expect(map.json().pins).toHaveLength(0)

    const get = await h.app.inject({
      method: "GET",
      url: `/v1/reports/${reportId}`,
      headers: { authorization: `Bearer ${h.token}` },
    })
    expect(get.statusCode).toBe(404)
    expect(get.json().code).toBe("NOT_FOUND")

    const status = await h.app.inject({
      method: "GET",
      url: `/v1/anon/reports/${reportId}/status?claimCode=${encodeURIComponent(claimCode)}`,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe("held")
  })

  it("GET /anon/reports/:id/status 404s a wrong claim code (no enumeration)", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const status = await h.app.inject({
      method: "GET",
      url: `/v1/anon/reports/${reportId}/status?claimCode=wrong`,
    })
    expect(status.statusCode).toBe(404)
  })

  it("GET /anon/reports/:id/status 422s a missing claim code", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const status = await h.app.inject({ method: "GET", url: `/v1/anon/reports/${reportId}/status` })
    expect(status.statusCode).toBe(422)
  })

  it("P2-7: the status endpoint has a dedicated tighter per-IP limit (429 past 30/min)", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    let saw429 = false
    for (let i = 0; i < 40; i++) {
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/anon/reports/${reportId}/status?claimCode=wrong`,
        remoteAddress: "203.0.113.77",
      })
      if (res.statusCode === 429) {
        saw429 = true
        break
      }
    }
    expect(saw429).toBe(true)
  })
})

describe("claim flow", () => {
  it("nudge -> sign-in -> claim links the report to the user (mine=true), single-use", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const anonToken = submit.headers["x-anon-token"] as string
    mirrorHeldIntoReportRepo(h, reportId)

    const nudge = await h.app.inject({
      method: "POST",
      url: "/v1/claim/nudge",
      payload: { anonToken },
    })
    expect(nudge.statusCode).toBe(200)
    const nudgeBody = nudge.json()
    expect(nudgeBody.reportId).toBe(reportId)
    expect(typeof nudgeBody.claimCode).toBe("string")

    const claim = await h.app.inject({
      method: "POST",
      url: "/v1/claim/report",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { claimCode: nudgeBody.claimCode },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json().report.id).toBe(reportId)
    expect(claim.json().report.mine).toBe(true)
    expect(h.anonStore.reports.get(reportId)!.reporterUserId).toBe(h.userId)

    const again = await h.app.inject({
      method: "POST",
      url: "/v1/claim/report",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { claimCode: nudgeBody.claimCode },
    })
    expect(again.statusCode).toBe(404)
  })

  it("401s an anonymous POST /claim/report", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/claim/report",
      payload: { claimCode: "x" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("404s POST /claim/nudge with no anon token at all", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({ method: "POST", url: "/v1/claim/nudge", payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it("POST /claim/nudge falls back to the civfix_anon cookie when the body omits anonToken", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/v1/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const anonToken = submit.headers["x-anon-token"] as string
    mirrorHeldIntoReportRepo(h, reportId)

    const nudge = await h.app.inject({
      method: "POST",
      url: "/v1/claim/nudge",
      payload: {},
      headers: { cookie: `civfix_anon=${encodeURIComponent(anonToken)}` },
    })
    expect(nudge.statusCode).toBe(200)
    expect(nudge.json().reportId).toBe(reportId)
  })

  it("422s POST /claim/nudge with an unknown body key", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/claim/nudge",
      payload: { anonToken: "x", nope: 1 },
    })
    expect(res.statusCode).toBe(422)
  })
})

/**
 * F131: every other test in this file injects `anonOverride`, so the PRODUCTION wiring in
 * anon.routes.ts `service()` — the branch that supplies `raiseAbuseFlag` and `log` — was never
 * executed. Both default to no-ops inside the service, so before the fix a honeypot hit in production
 * wrote nothing (anon_tokens/abuse_flags never learned about the bot) and every observability line was
 * discarded, while CI proved behavior production did not have. These tests boot the route with NO
 * override and a scripted `sql` so the real closure runs.
 */
describe("F131: the PRODUCTION anon service raises abuse flags and logs", () => {
  interface ProdHarness {
    app: FastifyInstance
    db: FakeSqlControl
    tokenId: string
    anonToken: string
    logs: { line: string; extra: Record<string, unknown> }[]
  }

  async function prodHarness(): Promise<ProdHarness> {
    const env = loadEnv({ NODE_ENV: "test" })
    const db = makeFakeSql()
    const container = {
      ...buildContainer(env),
      getDb: () => ({ sql: db.sql }),
    } as unknown as Container
    const app = await buildServer({ env, container })
    const logs: { line: string; extra: Record<string, unknown> }[] = []
    app.log.info = ((extra: Record<string, unknown>, line: string) => {
      logs.push({ line, extra })
    }) as unknown as typeof app.log.info
    const tokenId = "anon-token-id-f131"
    return {
      app,
      db,
      tokenId,
      anonToken: signAnonToken(tokenId, env.ANON_TOKEN_SIGNING_KEY),
      logs,
    }
  }

  let prod: ProdHarness | undefined

  afterEach(async () => {
    if (prod) {
      await prod.app.close()
      prod = undefined
    }
  })

  it("writes a de-duplicated abuse_flags row for a honeypot hit on the presented anon token", async () => {
    prod = await prodHarness()
    const res = await prod.app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ anonToken: prod.anonToken, honeypot: "https://spam.example" }),
    })
    expect(res.statusCode).toBe(422)

    const insert = prod.db.statements.find((st) => /INSERT INTO abuse_flags/i.test(st.sql))
    expect(insert).toBeDefined()
    expect(insert!.values).toContain("anon_token")
    expect(insert!.values).toContain(prod.tokenId)
    expect(insert!.values).toContain("honeypot")
    expect(insert!.sql).toMatch(/WHERE NOT EXISTS/i)
  })

  it("logs the rejection WITHOUT the submitted coordinates", async () => {
    prod = await prodHarness()
    await prod.app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ anonToken: prod.anonToken, honeypot: "bot" }),
    })

    const line = prod.logs.find((l) => l.line.includes("honeypot tripped"))
    expect(line).toBeDefined()
    const serialized = JSON.stringify(prod.logs)
    expect(serialized).not.toContain("34.1")
    expect(serialized).not.toContain("-118.35")
  })

  it("raises NO flag for a clean submit (the honeypot branch is the only producer here)", async () => {
    prod = await prodHarness()
    await prod.app.inject({
      method: "POST",
      url: "/v1/anon/reports",
      payload: anonPayload({ anonToken: prod.anonToken }),
    })
    expect(prod.db.statements.some((st) => /INSERT INTO abuse_flags/i.test(st.sql))).toBe(false)
  })
})
