import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { clientQuery } from "../helpers/query.js"
import type { ReportServiceOverrides } from "../../src/routes/reports.routes.js"

/**
 * Route-level tests for the report plugin, run with NO database: an in-memory ReportRepository (+ fake
 * jurisdiction/presign) is injected via makeServer(opts.reportOverrides), and a full in-memory auth
 * bundle is injected so the [auth] routes get a real bearer session. Exercised through the real Fastify
 * app via app.inject. The Drizzle/PostGIS transaction path is covered by the Docker-gated integration
 * test instead.
 */

interface Harness {
  app: FastifyInstance
  repo: InMemoryReportRepository
  mailer: FakeMailer
  /** Minted through the real OTP flow. */
  token: string
  userId: string
}

let current: Harness | undefined

/** Build the app with injected auth + report seams and sign a user in (bearer/mobile transport). */
async function makeHarness(
  reportOpts: {
    geoid?: string | null
    seed?: (repo: InMemoryReportRepository) => void
    resolveAddress?: ReportServiceOverrides["resolveAddress"]
    joinReportChatAsOwner?: ReportServiceOverrides["joinReportChatAsOwner"]
  } = {},
): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })

  // In-memory auth bundle (mirrors makeAuthHarness) so [auth] routes resolve a real session.
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const verifier = new StubJwksVerifier()
  const authServices = makeAuthServices({
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
    ...(reportOpts.resolveAddress ? { resolveAddress: reportOpts.resolveAddress } : {}),
    ...(reportOpts.joinReportChatAsOwner
      ? { joinReportChatAsOwner: reportOpts.joinReportChatAsOwner }
      : {}),
    presignMedia: (r2Key, thumbKey) =>
      Promise.resolve(
        thumbKey === null
          ? { url: `memory://${r2Key}` }
          : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
      ),
  }

  const app = await makeServer({ env, authServices, reportOverrides })

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
        type: "graffiti",
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

  it("reverse-geocodes the pin into addr when the client supplies none, and records the rung", async () => {
    const { app, token } = await makeHarness({
      resolveAddress: async () => ({
        address: "123 Imperial Hwy, Inglewood, CA",
        precision: "street",
        cityStateLabel: "Inglewood, CA",
      }),
    })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        type: "dump",
        lat: 33.95,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.addr).toBe("123 Imperial Hwy, Inglewood, CA")
    // Provenance rides along: the server filled it, at street precision.
    expect(dto.addrSource).toBe("resolved")
    expect(dto.addrPrecision).toBe("street")
  })

  it("files the report anyway when the resolver throws - an outage never costs a filing", async () => {
    const { app, token } = await makeHarness({
      resolveAddress: async () => {
        throw new Error("geocoder down")
      },
    })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        type: "dump",
        lat: 33.95,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.addr).toBeUndefined()
    expect(dto.addrSource).toBeUndefined()
  })

  it("keeps a client-supplied addr instead of reverse-geocoding the pin", async () => {
    const { app, token } = await makeHarness({
      resolveAddress: async () => ({
        address: "SHOULD NOT BE USED",
        precision: "street",
        cityStateLabel: "Inglewood, CA",
      }),
    })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        type: "dump",
        addr: "NW corner by the bus stop",
        lat: 33.95,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.addr).toBe("NW corner by the bus stop")
    // The reporter's own text is 'user' and carries NO provider precision.
    expect(dto.addrSource).toBe("user")
    expect(dto.addrPrecision).toBeUndefined()
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
        type: "dump",
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
      type: "dump",
      lat: 34.1,
      lng: -118.35,
      geomSource: "device",
      mediaUploadIds: [],
    }
    const first = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload,
    })
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
        type: "dump",
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
        type: "dump",
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
        type: "dump",
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

  // The report's creator is auto-joined as an OWNER of its chat, once the report row is committed.
  it("auto-joins the creator as an 'owner' of the report chat with the new report id", async () => {
    const joinReportChatAsOwner = vi.fn(() => Promise.resolve())
    const { app, token, userId } = await makeHarness({ joinReportChatAsOwner })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "graffiti",
        type: "graffiti",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(joinReportChatAsOwner).toHaveBeenCalledTimes(1)
    expect(joinReportChatAsOwner).toHaveBeenCalledWith(dto.id, userId)
  })

  // Best-effort: a chat auto-join failure must NOT fail report creation.
  it("still returns 201 when the creator auto-join throws (best-effort side-effect)", async () => {
    const joinReportChatAsOwner = vi.fn(() => Promise.reject(new Error("chat down")))
    const { app, repo, token } = await makeHarness({ joinReportChatAsOwner })
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(token),
      payload: {
        idempotencyKey: KEY_A,
        category: "trash",
        type: "dump",
        lat: 34.1,
        lng: -118.35,
        geomSource: "device",
        mediaUploadIds: [],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(joinReportChatAsOwner).toHaveBeenCalledTimes(1)
    expect(repo.reports.size).toBe(1)
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
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/${heldId}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe("NOT_FOUND")
  })

  it("treats a non-UUID id as a reference code (resolve-either): unknown code -> 404", async () => {
    // GET /reports/:id accepts a UUID OR a reference_code: a non-UUID id is looked up by reference_code,
    // and an unknown one is NOT_FOUND (not a 422).
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/reports/DU-42-999999" })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe("NOT_FOUND")
  })

  it("resolves a report by its reference_code", async () => {
    let code = ""
    const { app } = await makeHarness({
      seed: (repo) => {
        const r = repo.seedReport({
          status: "published",
          visibility: "public",
          referenceCode: "DU-42-000001",
        })
        code = r.referenceCode!
      },
    })
    const res = await app.inject({ method: "GET", url: `/v1/reports/${code}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().referenceCode).toBe("DU-42-000001")
  })

  it("422s an over-long id (still validated)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: `/v1/reports/${"x".repeat(65)}` })
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

  it("shows the OWNER their own in-flight (validating) media but hides it from a stranger", async () => {
    const { app, repo, token, userId } = await makeHarness()
    // A public report OWNED by the signed-in user, with a ready item, an in-flight `validating` upload
    // (worker has not promoted it yet), and a `held` item (a moderation removal).
    const report = repo.seedReport({
      reporterUserId: userId,
      status: "published",
      visibility: "public",
    })
    const readyId = repo.seedMedia({ reportId: report.id, status: "ready" }).id
    const validatingId = repo.seedMedia({ reportId: report.id, status: "validating" }).id
    repo.seedMedia({ reportId: report.id, status: "held" })

    // The owner sees their ready AND their own in-flight validating media, but NOT the held one.
    const ownerRes = await app.inject({
      method: "GET",
      url: `/v1/reports/${report.id}`,
      headers: auth(token),
    })
    expect(ownerRes.statusCode).toBe(200)
    const ownerIds = (ownerRes.json().media as { id: string }[]).map((m) => m.id)
    expect(ownerIds).toContain(readyId)
    expect(ownerIds).toContain(validatingId)
    expect(ownerIds).toHaveLength(2)

    // A stranger (anonymous) still sees only the ready item (validating/held stay hidden).
    const strangerRes = await app.inject({ method: "GET", url: `/v1/reports/${report.id}` })
    expect(strangerRes.statusCode).toBe(200)
    expect((strangerRes.json().media as { id: string }[]).map((m) => m.id)).toEqual([readyId])
  })
})

describe("GET /reports (my reports)", () => {
  it("lists the caller's own reports, newest first", async () => {
    const { app, token, userId } = await makeHarness()
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
          type: "dump",
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
  // prove the client's real calls parse + succeed.
  // The service clamps `zoom` to what the requested extent can actually imply
  // (services/report-clustering.ts effectiveMapZoom), so a per-pin (zoom >= 13) case needs a bbox a real
  // client could plausibly be displaying at that zoom. This ~5 km viewport implies zoom 14, which clears
  // the cluster threshold.
  const BBOX = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }
  // A world-spanning bbox: the attack shape (`zoom=22` over the whole planet).
  const WORLD_BBOX = { west: -180, south: -85, east: 180, north: 85 }

  it("returns clusters at low zoom and pins at high zoom for points in the bbox (client-encoded bbox)", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 34.11,
          lng: -118.34,
        })
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

  it("serializes the additive pin title + presigned thumbUrl through the response schema", async () => {
    // fast-json-stringify drops any property the compiled response schema does not declare, so this
    // guards the JSON-schema additions (title/thumbUrl) against silently disappearing from the wire.
    const { app } = await makeHarness({
      seed: (repo) => {
        const withPhoto = repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
          title: "Mattress dumped",
        })
        repo.seedMedia({
          reportId: withPhoto.id,
          status: "ready",
          r2Key: "uploads/a",
          thumbKey: "thumbs/a",
        })
        // A second report with no media -> thumbUrl null, title omitted (null).
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 34.11,
          lng: -118.34,
        })
      },
    })

    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 16 })}`,
    })
    expect(res.statusCode).toBe(200)
    const pins = res.json().pins as {
      category: string
      title?: string | null
      thumbUrl: string | null
    }[]
    const trash = pins.find((p) => p.category === "trash")!
    expect(trash.title).toBe("Mattress dumped")
    expect(trash.thumbUrl).toBe("memory://thumbs/a")
    const graffiti = pins.find((p) => p.category === "graffiti")!
    expect(graffiti.thumbUrl).toBeNull()
    expect(graffiti.title ?? null).toBeNull()
  })

  it("filters by categories sent as repeated params (the client's array encoding)", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 34.11,
          lng: -118.34,
        })
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
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 34.11,
          lng: -118.34,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "water",
          lat: 34.12,
          lng: -118.33,
        })
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
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 34.11,
          lng: -118.34,
        })
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

  // The attack was `bbox=<whole world>&zoom=22`: clustering was skipped at zoom >= 13 and `zoom` was a
  // free client parameter never correlated with the extent, so one anonymous request pulled up to
  // MAP_REPORTS_CANDIDATE_CAP full report rows AND that many media presign round-trips, with the 60s
  // Cache-Control defeated by jittering the bounds.

  it("M14: a continental bbox is forced to CLUSTER even when the client claims max zoom", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "graffiti",
          lat: 40.71,
          lng: -74.0,
        })
      },
    })
    // Just inside MAX_MAP_BBOX_AREA_DEG2 (100 x 60 = 6000 deg^2) so it is the ZOOM clamp under test
    // here, not the area rejection.
    const wide = { west: -125, south: 25, east: -25, north: 85 }
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: wide, zoom: 22 })}`,
    })
    expect(res.statusCode).toBe(200)
    // The whole point: NO per-pin branch, therefore no per-pin presign fan-out.
    expect(res.json().pins).toHaveLength(0)
    expect(res.json().clusters.length).toBeGreaterThanOrEqual(1)
  })

  it("M14: 422s a world-spanning bbox outright (area cap)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: WORLD_BBOX, zoom: 22 })}`,
    })
    expect(res.statusCode).toBe(422)
  })

  it("M14: a genuine neighborhood viewport still returns individual pins", async () => {
    const { app } = await makeHarness({
      seed: (repo) => {
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
      },
    })
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/reports${clientQuery({ bbox: BBOX, zoom: 18 })}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().pins).toHaveLength(1)
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
        repo.seedReport({
          status: "published",
          visibility: "public",
          category: "trash",
          lat: 34.1,
          lng: -118.35,
        })
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

describe("POST /reports/:id/resolve", () => {
  it("the owner marks their report resolved and gets back the updated ReportDTO", async () => {
    // Seed AFTER the harness signs the user in, so the report is owned by the signed-in user's real id.
    const { app, repo, token, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId, status: "published" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/resolve`,
      headers: auth(token),
      payload: { resolved: true },
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.status).toBe("resolved")
    expect(dto.mine).toBe(true)
    expect(repo.reports.get(r.id)!.status).toBe("resolved")
  })

  it("the owner reopens a resolved report (back to published)", async () => {
    const { app, repo, token, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId, status: "resolved" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/resolve`,
      headers: auth(token),
      payload: { resolved: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("published")
  })

  it("403s when the caller does not own the report", async () => {
    const { app, repo, token } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: "someone-else", status: "published" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/resolve`,
      headers: auth(token),
      payload: { resolved: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it("404s resolving a missing report", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-0000-0000-000000000000/resolve",
      headers: auth(token),
      payload: { resolved: true },
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous resolve", async () => {
    const { app, repo, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId })
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/resolve`,
      payload: { resolved: true },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe("POST /reports/:id/unlist", () => {
  it("the owner hides their report and gets back the updated ReportDTO (visibility hidden, status intact)", async () => {
    // Seed AFTER the harness signs the user in, so the report is owned by the signed-in user's real id.
    const { app, repo, token, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId, status: "published" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/unlist`,
      headers: auth(token),
      payload: { unlisted: true },
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.visibility).toBe("hidden")
    expect(dto.status).toBe("published")
    expect(dto.mine).toBe(true)
    expect(repo.reports.get(r.id)!.visibility).toBe("hidden")
  })

  it("the owner re-lists a hidden report (back to public)", async () => {
    const { app, repo, token, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId, status: "published", visibility: "hidden" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/unlist`,
      headers: auth(token),
      payload: { unlisted: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().visibility).toBe("public")
  })

  it("403s when the caller does not own the report", async () => {
    const { app, repo, token } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: "someone-else", status: "published" })

    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/unlist`,
      headers: auth(token),
      payload: { unlisted: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it("404s unlisting a missing report", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/reports/00000000-0000-0000-0000-000000000000/unlist",
      headers: auth(token),
      payload: { unlisted: true },
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous unlist", async () => {
    const { app, repo, userId } = await makeHarness()
    const r = repo.seedReport({ reporterUserId: userId })
    const res = await app.inject({
      method: "POST",
      url: `/v1/reports/${r.id}/unlist`,
      payload: { unlisted: true },
    })
    expect(res.statusCode).toBe(401)
  })
})
