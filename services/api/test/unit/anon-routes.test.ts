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
import { makeAnonService } from "../../src/services/anon-service.js"
import { makeClaimService } from "../../src/services/claim-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { InMemoryAnonStore } from "../helpers/anon.js"
import { clientQuery } from "../helpers/query.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"
import type { ReportOwner } from "../../src/services/report-service.js"

/**
 * Route-level tests for the anonymous-report + claim plugins via the real Fastify app (app.inject), with
 * NO database. The anon/claim services are wired over a shared InMemoryAnonStore + FakeAbuseChecks +
 * in-memory CounterStore; the report routes use an InMemoryReportRepository. To prove "a held anon
 * report stays hidden" end to end, the test mirrors the held row into BOTH stores (production shares a
 * single DB), then asserts it is absent from GET /map/reports and 404s on GET /reports/:id while its
 * status is visible via GET /anon/reports/:id/status with the claim code.
 */

const SIGNING_KEY = "test-anon-signing-key"
const KEY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

interface Harness {
  app: FastifyInstance
  anonStore: InMemoryAnonStore
  reportRepo: InMemoryReportRepository
  abuse: FakeAbuseChecks
  /** A signed-in user's bearer token + id (minted through the real OTP flow). */
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

  // In-memory auth bundle (so [auth] claim route can resolve a real bearer session).
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
    // The report id must be a real UUID (the status/get routes validate it against IdSchema).
    newId: () => randomUUID(),
    newClaimCode: () => `claim-${++n}`,
    newAnonTokenId: () => `anontok-${n}`,
  })

  // The claim service renders the DTO from the anon store (which claimByCode just updated with the new
  // owner), mirroring production where both the claim write and the DTO read hit the same DB row.
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

  // Sign a user in (mobile bearer) for the claim route.
  const email = "claimer@example.com"
  await app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
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
    lat: 34.1,
    lng: -118.35,
    geomSource: "device",
    mediaUploadIds: [],
    ...over,
  }
}

/** Mirror a held anon report from the anon store into the report repo (production shares one DB). */
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
    const res = await app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.status).toBe("held")
    expect(typeof body.reportId).toBe("string")
    expect(typeof body.claimCode).toBe("string")
    // A fresh anon token is handed back via header + a readable cookie.
    expect(res.headers["x-anon-token"]).toBeTruthy()
    const setCookie = res.headers["set-cookie"]
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie as string]
    expect(lines.some((l) => l.startsWith("civfix_anon="))).toBe(true)
  })

  it("rejects a failed Turnstile with 403 TURNSTILE_FAILED", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/anon/reports",
      payload: anonPayload({ turnstileToken: "fail" }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("TURNSTILE_FAILED")
  })

  it("rejects a honeypot-filled body with 422 and creates nothing", async () => {
    const { app, anonStore } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/anon/reports",
      payload: anonPayload({ honeypot: "bot" }),
    })
    expect(res.statusCode).toBe(422)
    expect(anonStore.reports.size).toBe(0)
  })

  it("replays the original response for a duplicate idempotency key (still 202, same report)", async () => {
    const { app, anonStore } = await makeHarness()
    const first = await app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    const firstBody = first.json()
    const second = await app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    expect(second.statusCode).toBe(202)
    expect(second.json().reportId).toBe(firstBody.reportId)
    expect(anonStore.reports.size).toBe(1)
  })

  it("422s a malformed body (bad category)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/anon/reports",
      payload: anonPayload({ category: "not-a-category" }),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("web anon token round-trips via the civfix_anon cookie (P1-2)", () => {
  /** Pull the civfix_anon cookie VALUE out of a response's Set-Cookie header(s). */
  function readAnonCookie(res: { headers: Record<string, unknown> }): string | undefined {
    const raw = res.headers["set-cookie"]
    const lines = Array.isArray(raw) ? (raw as string[]) : raw ? [raw as string] : []
    const line = lines.find((l) => l.startsWith("civfix_anon="))
    if (!line) return undefined
    // "civfix_anon=<value>; Path=/; ..." -> <value>
    return decodeURIComponent(line.slice("civfix_anon=".length).split(";")[0]!)
  }

  it("a second submit carrying ONLY the civfix_anon cookie reuses the same token (report_count -> 2)", async () => {
    const { app, anonStore } = await makeHarness()

    // First submit: no token presented -> a fresh one is minted and handed back via the cookie + header.
    const first = await app.inject({
      method: "POST",
      url: "/anon/reports",
      payload: anonPayload({ idempotencyKey: "11111111-1111-1111-1111-111111111111" }),
    })
    expect(first.statusCode).toBe(202)
    const cookie = readAnonCookie(first)
    expect(cookie).toBeTruthy()
    // Exactly one token row exists, at report_count 1.
    expect(anonStore.tokens.size).toBe(1)
    const tokenId = [...anonStore.tokens.keys()][0]!
    expect(anonStore.tokens.get(tokenId)!.reportCount).toBe(1)

    // Second submit: a DIFFERENT idempotency key, NO body anonToken, but the browser auto-resends the
    // civfix_anon cookie. The route must fall back to that cookie so the SAME token is reused.
    const second = await app.inject({
      method: "POST",
      url: "/anon/reports",
      headers: { cookie: `civfix_anon=${encodeURIComponent(cookie!)}` },
      payload: anonPayload({ idempotencyKey: "22222222-2222-2222-2222-222222222222" }),
    })
    expect(second.statusCode).toBe(202)

    // The cap accrues on the SAME token: still one token row, now at report_count 2. (Before the fix the
    // cookie was ignored, a second token was minted, and each token's count reset to 1.)
    expect(anonStore.tokens.size).toBe(1)
    expect(anonStore.tokens.get(tokenId)!.reportCount).toBe(2)
    // No fresh token was issued on the second submit (an existing one was reused).
    expect(second.headers["x-anon-token"]).toBeUndefined()
  })

  it("an explicit body anonToken still wins over the cookie", async () => {
    const { app, anonStore } = await makeHarness()
    // Seed a known token and present it in the BODY while also sending a different cookie value.
    const first = await app.inject({
      method: "POST",
      url: "/anon/reports",
      payload: anonPayload({ idempotencyKey: "33333333-3333-3333-3333-333333333333" }),
    })
    const bodyToken = first.headers["x-anon-token"] as string
    expect(bodyToken).toBeTruthy()
    const tokenId = [...anonStore.tokens.keys()][0]!

    // Second submit echoes the token in the body AND carries a bogus cookie; the body must win, so the
    // same token's count advances to 2 and the bogus cookie is not used to mint anything.
    const second = await app.inject({
      method: "POST",
      url: "/anon/reports",
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
      url: "/anon/reports",
      payload: anonPayload({ lat: 34.1, lng: -118.35 }),
    })
    const { reportId, claimCode } = submit.json()
    mirrorHeldIntoReportRepo(h, reportId)

    // (a) Not on the public map (only published+public points are candidates). bbox is sent as the
    // client encodes it (a single JSON param).
    const map = await h.app.inject({
      method: "GET",
      url: `/map/reports${clientQuery({ bbox: { west: -119, south: 33, east: -118, north: 35 }, zoom: 16 })}`,
    })
    expect(map.statusCode).toBe(200)
    expect(map.json().pins).toHaveLength(0)

    // (b) 404 to a stranger (signed-in non-owner) on GET /reports/:id (no existence leak).
    const get = await h.app.inject({
      method: "GET",
      url: `/reports/${reportId}`,
      headers: { authorization: `Bearer ${h.token}` },
    })
    expect(get.statusCode).toBe(404)
    expect(get.json().code).toBe("NOT_FOUND")

    // (c) The status IS visible via the claim-code-gated endpoint.
    const status = await h.app.inject({
      method: "GET",
      url: `/anon/reports/${reportId}/status?claimCode=${encodeURIComponent(claimCode)}`,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe("held")
  })

  it("GET /anon/reports/:id/status 404s a wrong claim code (no enumeration)", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const status = await h.app.inject({
      method: "GET",
      url: `/anon/reports/${reportId}/status?claimCode=wrong`,
    })
    expect(status.statusCode).toBe(404)
  })

  it("GET /anon/reports/:id/status 422s a missing claim code", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const status = await h.app.inject({ method: "GET", url: `/anon/reports/${reportId}/status` })
    expect(status.statusCode).toBe(422)
  })

  it("P2-7: the status endpoint has a dedicated tighter per-IP limit (429 past 30/min)", async () => {
    const h = await makeHarness()
    const submit = await h.app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    // Hammer the status endpoint from one IP; the dedicated 30/min cap (well under the 300/min global)
    // must produce a 429 before 40 requests. A wrong code keeps the handler outcome stable (404) so the
    // signal is purely the rate limiter.
    let saw429 = false
    for (let i = 0; i < 40; i++) {
      const res = await h.app.inject({
        method: "GET",
        url: `/anon/reports/${reportId}/status?claimCode=wrong`,
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
    // Submit anonymously; capture the issued anon token from the response header.
    const submit = await h.app.inject({ method: "POST", url: "/anon/reports", payload: anonPayload() })
    const { reportId } = submit.json()
    const anonToken = submit.headers["x-anon-token"] as string
    mirrorHeldIntoReportRepo(h, reportId)

    // (1) Nudge with the anon token (mobile passes it as a query param) -> claimCode + reportId.
    const nudge = await h.app.inject({
      method: "GET",
      url: `/claim/nudge?anonToken=${encodeURIComponent(anonToken)}`,
    })
    expect(nudge.statusCode).toBe(200)
    const nudgeBody = nudge.json()
    expect(nudgeBody.reportId).toBe(reportId)
    expect(typeof nudgeBody.claimCode).toBe("string")

    // (2) Claim with the code as the signed-in user (bearer -> no CSRF needed).
    const claim = await h.app.inject({
      method: "POST",
      url: "/claim/report",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { claimCode: nudgeBody.claimCode },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json().report.id).toBe(reportId)
    expect(claim.json().report.mine).toBe(true)
    // The underlying report now shows the user as owner (single shared row in production).
    expect(h.anonStore.reports.get(reportId)!.reporterUserId).toBe(h.userId)

    // (3) Single-use: claiming again 404s.
    const again = await h.app.inject({
      method: "POST",
      url: "/claim/report",
      headers: { authorization: `Bearer ${h.token}` },
      payload: { claimCode: nudgeBody.claimCode },
    })
    expect(again.statusCode).toBe(404)
  })

  it("401s an anonymous POST /claim/report", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({
      method: "POST",
      url: "/claim/report",
      payload: { claimCode: "x" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("404s GET /claim/nudge with no anon token at all", async () => {
    const h = await makeHarness()
    const res = await h.app.inject({ method: "GET", url: "/claim/nudge" })
    expect(res.statusCode).toBe(404)
  })
})
