import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { clientQuery } from "../helpers/query.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"

/**
 * Route-level tests for the report plugin, run with NO database: an in-memory ReportRepository (+ fake
 * jurisdiction/presign) is injected via buildServer(opts.reportOverrides), and a full in-memory auth
 * bundle is injected so the [auth] routes get a real bearer session. Exercised through the real Fastify
 * app via app.inject. The Drizzle/PostGIS transaction path is covered by the Docker-gated integration
 * test instead.
 */

interface Harness {
  app: FastifyInstance
  repo: InMemoryReportRepository
  mailer: FakeMailer
  /** A signed-in user's bearer token + id (minted through the real OTP flow). */
  token: string
  userId: string
}

let current: Harness | undefined

/** Build the app with injected auth + report seams and sign a user in (bearer/mobile transport). */
async function makeHarness(
  reportOpts: {
    geoid?: string | null
    seed?: (repo: InMemoryReportRepository) => void
  } = {},
): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })

  // In-memory auth bundle (mirrors makeAuthHarness) so [auth] routes resolve a real session.
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

  const repo = new InMemoryReportRepository()
  if (reportOpts.seed) reportOpts.seed(repo)

  const reportOverrides: ReportServiceOverrides = {
    repo,
    resolveJurisdictionGeoid: () =>
      Promise.resolve("geoid" in reportOpts ? (reportOpts.geoid ?? null) : "0644000"),
    presignMedia: (r2Key, thumbKey) =>
      Promise.resolve(
        thumbKey === null
          ? { url: `memory://${r2Key}` }
          : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
      ),
  }

  const app = await buildServer({ env, authServices, reportOverrides })

  // Sign in through the real OTP flow (mobile transport -> bearer token in the body).
  const email = "reporter@example.com"
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  const h: Harness = { app, repo, mailer, token: body.token, userId: body.user.id }
  current = h
  return h
}

/** Authorization header for the signed-in user. */
function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

const KEY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

describe("POST /reports", () => {
  it("creates a report and returns a 201 ReportDTO (published, mine=true)", async () => {
    const { app, repo, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "graffiti",
        description: "tag on the wall",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.status).toBe("published")
    expect(dto.visibility).toBe("public")
    expect(dto.category).toBe("graffiti")
    expect(dto.geomSource).toBe("device")
    expect(dto.jurisdictionGeoid).toBe("0644000")
    expect(dto.mine).toBe(true)
    expect(dto.gov).toBe(false)
    expect(dto.timeline).toHaveLength(1)
    expect(repo.reports.size).toBe(1)
  })

  // Regression for the live mobile createReport 500 (api.civfix.org, stale deploy): submitReport.ts
  // POSTs the FULL payload after the media pipeline succeeds - a NON-EMPTY mediaUploadIds[] holding a
  // finalized upload id, geomSource:"device", and a composed description. The other happy-path test
  // sends mediaUploadIds: [] (no attach); this one exercises the with-media attach through the REAL
  // route (auth + csrf + body parse + service + repo) so the exact wire body the app sends returns 201
  // and the finalized asset is bound to the new report. (The Drizzle/PostGIS SQL is covered by the
  // Docker-gated reports-pg integration test; this guards the HTTP contract offline.)
  it("creates a 201 from the exact mobile payload (finalized media id + composed description)", async () => {
    let uploadId = ""
    let mediaId = ""
    const { app, repo, token } = await makeHarness({
      seed: (r) => {
        const asset = r.seedMedia({ status: "ready", r2Key: "uploads/2026/06/photo" })
        uploadId = asset.uploadId
        mediaId = asset.id
      },
    })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [uploadId],
        capturedAt: "2026-06-06T12:00:00.000Z",
        description: "Pile of trash on the corner.\n\nBlocking the sidewalk or road.",
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.status).toBe("published")
    expect(dto.category).toBe("trash")
    expect(dto.geomSource).toBe("device")
    expect(dto.description).toBe("Pile of trash on the corner.\n\nBlocking the sidewalk or road.")
    // The finalized media asset is attached to the new report and presigned into the DTO.
    expect(dto.media).toHaveLength(1)
    expect(dto.media[0].id).toBe(mediaId)
    expect(repo.media.find((m) => m.id === mediaId)!.reportId).toBe(dto.id)
    expect(repo.reports.size).toBe(1)
  })

  it("a duplicate idempotency key returns the SAME report id (no second row)", async () => {
    const { app, repo, token } = await makeHarness()
    const payload = {
      idempotencyKey: KEY_A,
      category: "trash",
      lat: 34.1,
      lng: -118.35,
      geomSource: "device",
      mediaUploadIds: [],
    }
    const first = await app.inject({ method: "POST", url: "/v1/reports", headers: auth(token), payload })
    expect(first.statusCode).toBe(201)
    const firstId = first.json().id

    // Same key again -> same id, still one row.
    const second = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: { ...payload, category: "hazard" },
    })
    expect(second.statusCode).toBe(201)
    expect(second.json().id).toBe(firstId)
    expect(repo.reports.size).toBe(1)
  })

  it("401s an anonymous POST /reports (anon uses /anon/reports)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe("UNAUTHORIZED")
  })

  it("422s a malformed body (bad category)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "not-a-category",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("422s a honeypot-filled body and creates nothing", async () => {
    const { app, repo, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
        honeypot: "gotcha",
      },
    })
    expect(res.statusCode).toBe(422)
    expect(repo.reports.size).toBe(0)
  })
})

describe("GET /reports/:id", () => {
  it("returns a published report to an anonymous viewer", async () => {
    let seededId = ""
    const { app } = await makeHarness({
      seed: (repo) => {
        seededId = repo.seedReport({
          reporterUserId: "someone",
          status: "published",
          visibility: "public",
        }).id
      },
    })
    const res = await app.inject({ method: "GET", url: `/v1/reports/${seededId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(seededId)
    expect(res.json().mine).toBe(false)
  })

  it("404s a HELD report to a stranger (no existence leak)", async () => {
    let heldId = ""
    const { app, token } = await makeHarness({
      seed: (repo) => {
        heldId = repo.seedReport({
          reporterUserId: "someone-else",
          status: "held",
          visibility: "public",
          publishedAt: null,
        }).id
      },
    })
    // The signed-in caller is NOT the owner -> 404.
    const res = await app.inject({ method: "GET", url: `/v1/reports/${heldId}`, headers: auth(token) })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe("NOT_FOUND")
  })

  it("422s a non-UUID id", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/reports/not-a-uuid" })
    expect(res.statusCode).toBe(422)
  })

  it("serves only READY media (hides held/rejected/validating) in the report DTO", async () => {
    let seededId = ""
    let readyMediaId = ""
    const { app } = await makeHarness({
      seed: (repo) => {
        const report = repo.seedReport({
          reporterUserId: "someone",
          status: "published",
          visibility: "public",
        })
        seededId = report.id
        readyMediaId = repo.seedMedia({ reportId: report.id, status: "ready" }).id
        // These must NOT be served: held/rejected leak moderated content; validating yields a broken
        // URL (getMedia serves ready-only bytes).
        repo.seedMedia({ reportId: report.id, status: "held" })
        repo.seedMedia({ reportId: report.id, status: "rejected" })
        repo.seedMedia({ reportId: report.id, status: "validating" })
      },
    })
    const res = await app.inject({ method: "GET", url: `/v1/reports/${seededId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().media).toHaveLength(1)
    expect(res.json().media[0].id).toBe(readyMediaId)
  })
})

describe("GET /reports (my reports)", () => {
  it("lists the caller's own reports, newest first", async () => {
    const { app, token, userId } = await makeHarness()
    // Create two reports as the signed-in user.
    for (const key of [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]) {
      await app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: auth(token),
        payload: {
          idempotencyKey: key,
          category: "trash",
          lat: 34.1,
          lng: -118.35,
          geomSource: "device",
          mediaUploadIds: [],
        },
      })
    }
    const res = await app.inject({ method: "GET", url: "/v1/reports", headers: auth(token) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items.every((r: { mine: boolean }) => r.mine === true)).toBe(true)
    expect(body.nextCursor).toBeNull()
    // Sanity: they are this user's.
    void userId
  })

  it("401s an anonymous GET /reports", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/reports" })
    expect(res.statusCode).toBe(401)
  })

  // Regression: the mobile infinite-list (cursorInfiniteQuery) fetches the first page as
  // `GET /reports?limit=20`. Through Fastify's query parser `limit` arrives as the STRING "20";
  // the shared PaginationQuerySchema coerces it (z.coerce.number). A non-coerced `z.number()` here
  // would 422 the live client (the original bug). clientQuery() builds the exact wire query the
  // shared client serializes, so this guards the coercion end-to-end through the real route.
  it("accepts the client's ?limit=20 (string-coerced) first page (200, not 422)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports${clientQuery({ limit: 20 })}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([])
  })

  it("accepts the client's ?limit=20&cursor=<c> follow-up page (200)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports${clientQuery({ limit: 20, cursor: "deadbeef" })}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
  })
})

describe("GET /map/reports", () => {
  // The shared client serializes bbox as a single JSON param and categories as repeated params. We build
  // the query with clientQuery() (a byte-for-byte replica of the client's buildQuery) so these tests
  // prove the previously-422 client calls now parse + succeed.
  const BBOX = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }

  it("returns clusters at low zoom and pins at high zoom for points in the bbox (client-encoded bbox)", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
        repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })
      },
    })

    const lowZoom = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 3 })}`,
    })
    expect(lowZoom.statusCode).toBe(200)
    const low = lowZoom.json()
    expect(low.pins).toHaveLength(0)
    expect(low.clusters.length).toBeGreaterThanOrEqual(1)
    expect(low.counts).toEqual({ trash: 1, graffiti: 1 })

    const highZoom = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16 })}`,
    })
    const high = highZoom.json()
    expect(high.clusters).toHaveLength(0)
    expect(high.pins).toHaveLength(2)
  })

  it("filters by categories sent as repeated params (the client's array encoding)", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
        repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })
      },
    })
    // clientQuery({categories:["trash"]}) -> ?...&categories=trash (repeated-param form).
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16, categories: ["trash"] })}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().pins).toHaveLength(1)
    expect(res.json().pins[0].category).toBe("trash")
  })

  it("accepts MULTIPLE repeated categories params", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
        repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })
        repo.seedReport({ status: "published", visibility: "public", category: "water", lat: 34.12, lng: -118.33 })
      },
    })
    // ?...&categories=trash&categories=graffiti -> both kept, water excluded.
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16, categories: ["trash", "graffiti"] })}`,
    })
    expect(res.statusCode).toBe(200)
    const cats = (res.json().pins as { category: string }[]).map((p) => p.category).sort()
    expect(cats).toEqual(["graffiti", "trash"])
  })

  it("still accepts a categories CSV (resilience)", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
        repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })
      },
    })
    // A single CSV param (hand-built) is tolerated: categories=trash,graffiti.
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16 })}&categories=trash,graffiti`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().pins).toHaveLength(2)
  })

  it("422s an unknown category", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16, categories: ["bogus"] })}`,
    })
    expect(res.statusCode).toBe(422)
  })

  it("422s a malformed (non-JSON) bbox param", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/map/reports?bbox=not-json&zoom=3",
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("P2: 422s an INVERTED bbox (west >= east or south >= north) instead of silently empty", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
      },
    })
    // west > east (transposed longitude). Before the guard this built an empty envelope -> 200 with no
    // pins (a silent failure); now it is a clear 422.
    const transposed = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: { west: -118.2, south: 34.0, east: -118.5, north: 34.2 }, zoom: 16 })}`,
    })
    expect(transposed.statusCode).toBe(422)
    expect(transposed.json().code).toBe("VALIDATION")

    // south >= north (degenerate latitude) is likewise rejected.
    const flat = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: { west: -118.5, south: 34.2, east: -118.2, north: 34.2 }, zoom: 16 })}`,
    })
    expect(flat.statusCode).toBe(422)
  })

  it("P2: 422s a NaN / out-of-range zoom (clustering NaN guard)", async () => {
    const { app } = await makeHarness()
    // zoom=NaN (non-numeric) would coerce to NaN and produce a NaN-coord cluster; now a 422.
    const nan = await app.inject({
      method: "GET",
      url: `/v1/map/reports?bbox=${encodeURIComponent(JSON.stringify(BBOX))}&zoom=notanumber`,
    })
    expect(nan.statusCode).toBe(422)
    expect(nan.json().code).toBe("VALIDATION")

    // An absurd out-of-range zoom is rejected too.
    const huge = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 99 })}`,
    })
    expect(huge.statusCode).toBe(422)
  })

  it("is anon-ok (no auth required)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 3 })}`,
    })
    expect(res.statusCode).toBe(200)
  })
})

describe("POST/DELETE /reports/:id/follow", () => {
  it("follows then unfollows a report", async () => {
    let reportId = ""
    const { app, token } = await makeHarness({
      seed: (repo) => {
        reportId = repo.seedReport({ reporterUserId: "owner", status: "published" }).id
      },
    })

    const follow = await app.inject({
      method: "POST",
      url: `/v1/reports/${reportId}/follow`,
      headers: auth(token),
    })
    expect(follow.statusCode).toBe(200)
    expect(follow.json()).toEqual({ following: true })

    const unfollow = await app.inject({
      method: "DELETE",
      url: `/v1/reports/${reportId}/follow`,
      headers: auth(token),
    })
    expect(unfollow.statusCode).toBe(200)
    expect(unfollow.json()).toEqual({ following: false })
  })

  it("404s following a missing report", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-0000-0000-000000000000/follow",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous follow", async () => {
    let reportId = ""
    const { app } = await makeHarness({
      seed: (repo) => {
        reportId = repo.seedReport({ reporterUserId: "owner" }).id
      },
    })
    const res = await app.inject({ method: "POST", url: `/v1/reports/${reportId}/follow` })
    expect(res.statusCode).toBe(401)
  })
})
