import { describe, it, expect } from "vitest"
import type { CreateReportRequest, ReportDTO } from "@civfix/shared"
import {
  makeReportService,
  clusterByZoom,
  countByCategory,
  clusterCellSizeDeg,
  reportH3Cell,
  CLUSTER_ZOOM_THRESHOLD,
  REPORT_H3_RESOLUTION,
  type ReportMapPoint,
  type ReportService,
} from "../../src/services/report-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"

/**
 * Offline unit tests for the report service + its pure helpers. The pure clusterByZoom/countByCategory
 * are tested directly; the create/get/follow flows run against an in-memory ReportRepository with fake
 * jurisdiction/presign closures, so they need NO database and NO Docker. The Drizzle/PostGIS repo + the
 * real transaction path are covered by the Docker-gated integration suite.
 */

const VALID_UUID = "11111111-1111-1111-1111-111111111111"

/** A fake presigner that echoes the key (so DTO urls are assertable without a storage SDK). */
function fakePresign(r2Key: string, thumbKey: string | null) {
  return Promise.resolve(
    thumbKey === null
      ? { url: `memory://${r2Key}` }
      : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
  )
}

/** Build a service over a fresh in-memory repo; jurisdiction resolves to a fixed geoid by default. */
function makeHarness(
  opts: {
    geoid?: string | null
    newId?: () => string
  } = {},
) {
  const repo = new InMemoryReportRepository()
  // Distinguish "not provided" (default to a fixed geoid) from "explicitly null" (outside coverage).
  const geoid: string | null = "geoid" in opts ? (opts.geoid ?? null) : "0644000"
  const service: ReportService = makeReportService({
    repo,
    resolveJurisdictionGeoid: () => Promise.resolve(geoid),
    presignMedia: fakePresign,
    ...(opts.newId !== undefined ? { newId: opts.newId } : {}),
  })
  return { repo, service }
}

/** A minimal valid create request. */
function createReq(over: Partial<CreateReportRequest> = {}): CreateReportRequest {
  return {
    idempotencyKey: over.idempotencyKey ?? VALID_UUID,
    category: over.category ?? "trash",
    type: over.type ?? "dump",
    lat: over.lat ?? 34.1,
    lng: over.lng ?? -118.35,
    geomSource: over.geomSource ?? "device",
    mediaUploadIds: over.mediaUploadIds ?? [],
    ...(over.title !== undefined ? { title: over.title } : {}),
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.addr !== undefined ? { addr: over.addr } : {}),
    ...(over.capturedAt !== undefined ? { capturedAt: over.capturedAt } : {}),
    ...(over.honeypot !== undefined ? { honeypot: over.honeypot } : {}),
  }
}

// ---------------------------------------------------------------------------
// Pure: clusterByZoom / clusterCellSizeDeg / countByCategory / reportH3Cell
// ---------------------------------------------------------------------------

describe("clusterCellSizeDeg", () => {
  it("halves with each zoom step and is the world width at zoom 0", () => {
    expect(clusterCellSizeDeg(0)).toBeCloseTo(180, 6)
    expect(clusterCellSizeDeg(1)).toBeCloseTo(90, 6)
    expect(clusterCellSizeDeg(2)).toBeCloseTo(45, 6)
    // Monotonic decreasing.
    expect(clusterCellSizeDeg(5)).toBeLessThan(clusterCellSizeDeg(4))
  })

  it("floors fractional zoom and clamps negatives to zoom 0", () => {
    expect(clusterCellSizeDeg(3.9)).toBe(clusterCellSizeDeg(3))
    expect(clusterCellSizeDeg(-4)).toBe(clusterCellSizeDeg(0))
  })
})

describe("clusterByZoom", () => {
  // A small fixture: three points clumped near LA and one far away in NYC. "a" carries a title + a
  // first-photo thumb key pair so the carry-through onto the (unsigned) pin can be asserted.
  const pts: ReportMapPoint[] = [
    { id: "a", lat: 34.10, lng: -118.350, category: "trash", type: "dump", status: "published", title: "Mattress dumped", description: "blocking the sidewalk", thumbKey: "thumbs/a", r2Key: "uploads/a" },
    { id: "b", lat: 34.11, lng: -118.351, category: "graffiti", type: "graffiti", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
    { id: "c", lat: 34.12, lng: -118.352, category: "trash", type: "dump", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
    { id: "d", lat: 40.71, lng: -74.000, category: "hazard", type: "encampment", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
  ]

  it("at/above the threshold returns individual pins and no clusters", () => {
    const { clusters, pins } = clusterByZoom(pts, CLUSTER_ZOOM_THRESHOLD)
    expect(clusters).toHaveLength(0)
    expect(pins).toHaveLength(4)
    // Pins carry the per-point identity + category + status + the preview fields (title + the first-photo
    // key pair the service later presigns into thumbUrl).
    const a = pins.find((p) => p.id === "a")!
    expect(a).toMatchObject({
      id: "a",
      category: "trash",
      type: "dump",
      status: "published",
      lat: 34.1,
      title: "Mattress dumped",
      description: "blocking the sidewalk",
      thumbKey: "thumbs/a",
      r2Key: "uploads/a",
    })
  })

  it("below the threshold snaps to a grid and emits clusters with correct counts", () => {
    // Low zoom -> a coarse grid: the three LA points land in one cell, NYC in another.
    const { clusters, pins } = clusterByZoom(pts, 3)
    expect(pins).toHaveLength(0)
    expect(clusters).toHaveLength(2)

    const total = clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBe(4)

    const counts = clusters.map((c) => c.count).sort()
    expect(counts).toEqual([1, 3])

    // The 3-point cluster's centroid is the mean of the LA points.
    const big = clusters.find((c) => c.count === 3)!
    expect(big.lat).toBeCloseTo((34.1 + 34.11 + 34.12) / 3, 6)
    expect(big.lng).toBeCloseTo((-118.35 + -118.351 + -118.352) / 3, 6)
  })

  it("an empty candidate set yields no clusters and no pins at any zoom", () => {
    expect(clusterByZoom([], 2)).toEqual({ clusters: [], pins: [] })
    expect(clusterByZoom([], 18)).toEqual({ clusters: [], pins: [] })
  })
})

describe("countByCategory", () => {
  it("counts all candidates per category, omitting zero categories", () => {
    const pts: ReportMapPoint[] = [
      { id: "a", lat: 0, lng: 0, category: "trash", type: "dump", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
      { id: "b", lat: 0, lng: 0, category: "trash", type: "dump", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
      { id: "c", lat: 0, lng: 0, category: "graffiti", type: "graffiti", status: "published", title: null, description: null, thumbKey: null, r2Key: null },
    ]
    expect(countByCategory(pts)).toEqual({ trash: 2, graffiti: 1 })
    expect(countByCategory([])).toEqual({})
  })
})

describe("reportH3Cell", () => {
  it("returns a valid h3 index at the configured resolution and is stable", () => {
    const cell = reportH3Cell(34.1, -118.35)
    expect(typeof cell).toBe("string")
    expect(cell.length).toBeGreaterThan(0)
    // Same input -> same cell.
    expect(reportH3Cell(34.1, -118.35)).toBe(cell)
    // A point ~10km away should land in a different r10 cell.
    expect(reportH3Cell(34.2, -118.35)).not.toBe(cell)
    expect(REPORT_H3_RESOLUTION).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Service: honeypot, idempotency replay, create happy path, getReport hiding, follow toggle
// ---------------------------------------------------------------------------

describe("createReport: honeypot", () => {
  it("rejects a non-empty honeypot with VALIDATION and creates nothing", async () => {
    const { repo, service } = makeHarness()
    await expect(
      service.createReport(createReq({ honeypot: "i-am-a-bot" }), { userId: "u1" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(repo.reports.size).toBe(0)
    expect(repo.idempotency.size).toBe(0)
  })

  it("treats a whitespace-only honeypot as empty (legitimate) and creates the report", async () => {
    // Trimming means a stray-whitespace value from a real client is not punished; only real content
    // (which a bot auto-filling the hidden field would produce) trips the reject.
    const { repo, service } = makeHarness()
    await service.createReport(createReq({ honeypot: "   " }), { userId: "u1" })
    expect(repo.reports.size).toBe(1)
  })

  it("an absent or empty honeypot is fine", async () => {
    const { repo, service } = makeHarness()
    await service.createReport(createReq({ honeypot: "" }), { userId: "u1" })
    expect(repo.reports.size).toBe(1)
  })
})

describe("createReport: happy path (authed publish-immediately)", () => {
  it("creates a published+public report with geom_source, jurisdiction, h3, timeline, mine=true", async () => {
    const { repo, service } = makeHarness({ geoid: "0644000" })
    const dto = await service.createReport(
      createReq({ category: "graffiti", type: "graffiti", description: "tagging on the wall", geomSource: "device" }),
      { userId: "u1" },
    )

    // The fine-grained type (0021) round-trips through create onto the DTO + the persisted row.
    expect(dto.type).toBe("graffiti")
    expect(dto.status).toBe("published")
    expect(dto.visibility).toBe("public")
    expect(dto.geomSource).toBe("device")
    expect(dto.jurisdictionGeoid).toBe("0644000")
    expect(dto.mine).toBe(true)
    expect(dto.gov).toBe(false)
    expect(dto.following).toBe(false)
    expect(dto.lat).toBe(34.1)
    expect(dto.lng).toBe(-118.35)
    expect(dto.publishedAt).toBeTruthy()
    // Initial timeline entry records the published transition.
    expect(dto.timeline).toHaveLength(1)
    expect(dto.timeline[0]!.status).toBe("published")

    // The report row + the H3 cell were persisted.
    const stored = repo.reports.get(dto.id)!
    expect(stored.status).toBe("published")
    // The fine-grained type was persisted on the row too.
    expect(stored.type).toBe("graffiti")
    // The snapshot is stored under the idempotency key.
    expect(repo.idempotency.size).toBe(1)
  })

  it("resolves a null jurisdiction (outside coverage) without failing", async () => {
    const { service } = makeHarness({ geoid: null })
    const dto = await service.createReport(createReq(), { userId: "u1" })
    expect(dto.jurisdictionGeoid).toBeUndefined()
  })

  it("persists the title + reverse-geocoded address and echoes them in the DTO", async () => {
    // The operator console reads reports.title + reports.addr; a submission that carries them must
    // round-trip through create so the admin reports surface is fully populated (not "Untitled report").
    const { repo, service } = makeHarness()
    const dto = await service.createReport(
      createReq({ title: "Mattress dumped on the corner", addr: "123 Main St, Springfield" }),
      { userId: "u1" },
    )
    expect(dto.title).toBe("Mattress dumped on the corner")
    expect(dto.addr).toBe("123 Main St, Springfield")
    // Persisted on the row (so the admin report SELECT reads them back).
    const stored = repo.reports.get(dto.id)!
    expect(stored.title).toBe("Mattress dumped on the corner")
    expect(stored.addr).toBe("123 Main St, Springfield")
  })

  it("omits title/addr from the DTO when the submission carries neither (photo-only report)", async () => {
    const { service } = makeHarness()
    const dto = await service.createReport(createReq(), { userId: "u1" })
    expect(dto.title).toBeUndefined()
    expect(dto.addr).toBeUndefined()
  })

  it("attaches finalized media (sets report_id; presigns into the DTO) without requiring ready", async () => {
    const { repo, service } = makeHarness()
    const asset = repo.seedMedia({ status: "validating", r2Key: "uploads/2026/01/pic" })

    const dto = await service.createReport(
      createReq({ mediaUploadIds: [asset.uploadId] }),
      { userId: "u1" },
    )

    expect(dto.media).toHaveLength(1)
    expect(dto.media[0]!.id).toBe(asset.id)
    expect(dto.media[0]!.url).toBe("memory://uploads/2026/01/pic")
    // The asset is now bound to the report.
    expect(repo.media.find((m) => m.id === asset.id)!.reportId).toBe(dto.id)
  })

  it("does not steal media already attached to a different report", async () => {
    const { repo, service } = makeHarness()
    const foreign = repo.seedMedia({ reportId: "other-report" })

    const dto = await service.createReport(
      createReq({ mediaUploadIds: [foreign.uploadId] }),
      { userId: "u1" },
    )
    // The foreign asset keeps its original report_id and is NOT in this report's media.
    expect(repo.media.find((m) => m.id === foreign.id)!.reportId).toBe("other-report")
    expect(dto.media).toHaveLength(0)
  })
})

describe("createReport: idempotency replay", () => {
  it("returns the ORIGINAL stored snapshot for a duplicate key without inserting a second report", async () => {
    const { repo, service } = makeHarness()
    const first = await service.createReport(createReq(), { userId: "u1" })
    expect(repo.reports.size).toBe(1)

    // Same idempotency key again (even with different-looking body) -> same id, no new row.
    const second = await service.createReport(
      createReq({ category: "hazard", description: "changed" }),
      { userId: "u1" },
    )
    expect(second.id).toBe(first.id)
    expect(second).toEqual(first) // verbatim replay
    expect(repo.reports.size).toBe(1)
    expect(repo.idempotency.size).toBe(1)
  })

  it("a pre-seeded snapshot is replayed without touching the repo's create path", async () => {
    const { repo, service } = makeHarness()
    // Seed a snapshot directly (as if a prior submit had stored it).
    const seeded: ReportDTO = {
      id: "seeded-report-id",
      category: "water",
      type: "infrastructure",
      status: "published",
      visibility: "public",
      lat: 1,
      lng: 2,
      geomSource: "manual",
      createdAt: new Date().toISOString(),
      mine: true,
      gov: false,
      following: false,
      media: [],
      mediaPending: 0,
      timeline: [],
      linkedEvents: [],
    }
    repo.idempotency.set(`report_create:${VALID_UUID}`, {
      key: VALID_UUID,
      scope: "report_create",
      snapshot: seeded,
    })

    const dto = await service.createReport(createReq(), { userId: "u1" })
    expect(dto).toEqual(seeded)
    // No report row was inserted (the snapshot short-circuited create).
    expect(repo.reports.size).toBe(0)
  })
})

describe("getReport: visibility / held hiding", () => {
  it("returns a published+public report to anyone, with mine reflecting ownership", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })

    const asStranger = await service.getReport(r.id, { userId: "stranger" })
    expect(asStranger.id).toBe(r.id)
    expect(asStranger.mine).toBe(false)

    const asOwner = await service.getReport(r.id, { userId: "owner" })
    expect(asOwner.mine).toBe(true)

    const asAnon = await service.getReport(r.id, {})
    expect(asAnon.id).toBe(r.id)
    expect(asAnon.mine).toBe(false)
  })

  it("hides a HELD report from a non-owner (404) but shows it to the owner", async () => {
    const { repo, service } = makeHarness()
    const held = repo.seedReport({
      reporterUserId: "owner",
      status: "held",
      visibility: "public",
      publishedAt: null,
    })

    await expect(service.getReport(held.id, { userId: "stranger" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.getReport(held.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" })

    const asOwner = await service.getReport(held.id, { userId: "owner" })
    expect(asOwner.id).toBe(held.id)
    expect(asOwner.status).toBe("held")
    expect(asOwner.mine).toBe(true)
  })

  it("hides a hidden-visibility report from non-owners", async () => {
    const { repo, service } = makeHarness()
    const hidden = repo.seedReport({
      reporterUserId: "owner",
      status: "published",
      visibility: "hidden",
    })
    await expect(service.getReport(hidden.id, { userId: "stranger" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect((await service.getReport(hidden.id, { userId: "owner" })).id).toBe(hidden.id)
  })

  it("returns 404 for a soft-deleted report even to its owner", async () => {
    const { repo, service } = makeHarness()
    const del = repo.seedReport({
      reporterUserId: "owner",
      status: "published",
      visibility: "public",
      deletedAt: new Date(),
    })
    await expect(service.getReport(del.id, { userId: "owner" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("404s an unknown id", async () => {
    const { service } = makeHarness()
    await expect(
      service.getReport("00000000-0000-0000-0000-000000000000", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("reflects following=true when the viewer follows the report", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })
    await repo.addFollow("fan", r.id)
    const dto = await service.getReport(r.id, { userId: "fan" })
    expect(dto.following).toBe(true)
  })
})

describe("follow toggle", () => {
  it("follow then unfollow flips the following flag and the underlying set", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner" })

    const f = await service.followReport("u2", r.id)
    expect(f).toEqual({ following: true })
    expect(repo.follows.has(`u2:${r.id}`)).toBe(true)

    const u = await service.unfollowReport("u2", r.id)
    expect(u).toEqual({ following: false })
    expect(repo.follows.has(`u2:${r.id}`)).toBe(false)
  })

  it("follow is idempotent (re-follow stays following:true, no error)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner" })
    await service.followReport("u2", r.id)
    const again = await service.followReport("u2", r.id)
    expect(again).toEqual({ following: true })
  })

  it("404s following a missing report", async () => {
    const { service } = makeHarness()
    await expect(
      service.followReport("u2", "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("listMyReports", () => {
  it("returns the caller's non-deleted reports newest-first and paginates by cursor", async () => {
    const { repo, service } = makeHarness()
    // Seed 3 owned + 1 other-owner + 1 deleted.
    const r1 = repo.seedReport({ reporterUserId: "me" })
    const r2 = repo.seedReport({ reporterUserId: "me" })
    const r3 = repo.seedReport({ reporterUserId: "me" })
    repo.seedReport({ reporterUserId: "other" })
    repo.seedReport({ reporterUserId: "me", deletedAt: new Date() })

    const page1 = await service.listMyReports("me", { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    // Newest first: r3 then r2 (seedReport assigns increasing created_at).
    expect(page1.items[0]!.id).toBe(r3.id)
    expect(page1.items[1]!.id).toBe(r2.id)

    const page2 = await service.listMyReports("me", { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.id).toBe(r1.id)
    expect(page2.nextCursor).toBeNull()
  })

  it("does NOT skip a row when two reports share the SAME created_at across a page boundary (P1-3)", async () => {
    const { repo, service } = makeHarness()
    // Three of the caller's reports where TWO share the exact same created_at. With a created_at-only
    // cursor, paging at the tie boundary (limit=1) would skip one of the tied rows. The row-value
    // (created_at, id) cursor returns all three with no skip and no duplicate.
    const tie = new Date("2026-05-31T12:00:00.000Z")
    const later = new Date("2026-05-31T12:00:01.000Z")
    repo.seedReport({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", reporterUserId: "me", createdAt: tie })
    repo.seedReport({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", reporterUserId: "me", createdAt: tie })
    repo.seedReport({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", reporterUserId: "me", createdAt: later })

    // Walk every page at limit=1 and collect the ids.
    const seen: string[] = []
    let cursor: string | null | undefined = undefined
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof service.listMyReports>> = await service.listMyReports("me", {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      for (const item of page.items) seen.push(item.id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }

    // All three came back exactly once (no skip at the created_at tie, no duplicate).
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    expect(seen).toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    expect(seen).toContain("cccccccc-cccc-cccc-cccc-cccccccccccc")
    // Newest (distinct created_at) is first.
    expect(seen[0]).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc")
  })
})

describe("listReportsInBBox", () => {
  it("clusters at low zoom and returns per-category counts over the candidates", async () => {
    const { repo, service } = makeHarness()
    // Three published+public points in-box; one out-of-box; one held (excluded).
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.11, lng: -118.34 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.12, lng: -118.33 })
    repo.seedReport({ status: "published", visibility: "public", category: "hazard", lat: 10, lng: 10 }) // out of box
    repo.seedReport({ status: "held", visibility: "public", category: "trash", lat: 34.1, lng: -118.35 }) // held

    const bbox = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }
    const low = await service.listReportsInBBox(bbox, null, null, 3)
    expect(low.pins).toHaveLength(0)
    expect(low.clusters.length).toBeGreaterThanOrEqual(1)
    const total = low.clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBe(3) // only the 3 in-box published+public points
    expect(low.counts).toEqual({ trash: 2, graffiti: 1 })
  })

  it("returns individual pins at high zoom", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })

    const bbox = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }
    const high = await service.listReportsInBBox(bbox, null, null, 16)
    expect(high.clusters).toHaveLength(0)
    expect(high.pins).toHaveLength(2)
  })

  it("enriches high-zoom pins with title + a presigned first-photo thumbUrl", async () => {
    const { repo, service } = makeHarness()
    const bbox = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }

    // (1) A report whose first ready photo has a generated thumbnail -> thumbUrl is the THUMB key signed.
    // It also carries a description, which must ride onto the pin DTO (null for the others below).
    const withThumb = repo.seedReport({
      status: "published", visibility: "public", category: "trash",
      lat: 34.10, lng: -118.35, title: "Mattress dumped", description: "blocking the sidewalk",
    })
    repo.seedMedia({ reportId: withThumb.id, status: "ready", r2Key: "uploads/a", thumbKey: "thumbs/a" })

    // (2) A report whose first ready photo has NO thumbnail -> thumbUrl FALLS BACK to the original key.
    const noThumb = repo.seedReport({
      status: "published", visibility: "public", category: "graffiti",
      lat: 34.11, lng: -118.34, title: "Graffiti on the wall",
    })
    repo.seedMedia({ reportId: noThumb.id, status: "ready", r2Key: "uploads/b", thumbKey: null })

    // (3) A report with NO visible media -> thumbUrl is null and title is still carried.
    const noMedia = repo.seedReport({
      status: "published", visibility: "public", category: "hazard",
      lat: 34.12, lng: -118.33, title: "Pothole",
    })

    // (4) A report whose only media is still `validating` -> hidden, so thumbUrl stays null.
    const pendingOnly = repo.seedReport({
      status: "published", visibility: "public", category: "water",
      lat: 34.13, lng: -118.32, title: null,
    })
    repo.seedMedia({ reportId: pendingOnly.id, status: "validating", r2Key: "uploads/d", thumbKey: "thumbs/d" })

    const high = await service.listReportsInBBox(bbox, null, null, 16)
    const byId = new Map(high.pins.map((p) => [p.id, p]))

    expect(byId.get(withThumb.id)).toMatchObject({ title: "Mattress dumped", description: "blocking the sidewalk", thumbUrl: "memory://thumbs/a" })
    // description rides onto the pin as value-or-null (null when the report has none, mirroring thumbUrl).
    expect(byId.get(noThumb.id)).toMatchObject({ title: "Graffiti on the wall", description: null, thumbUrl: "memory://uploads/b" })
    expect(byId.get(noMedia.id)).toMatchObject({ title: "Pothole", description: null, thumbUrl: null })

    const pending = byId.get(pendingOnly.id)!
    expect(pending.thumbUrl).toBeNull()
    expect(pending.title).toBeUndefined() // null title is omitted from the DTO
  })

  it("filters by category when provided", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })

    const bbox = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }
    const onlyTrash = await service.listReportsInBBox(bbox, ["trash"], null, 16)
    expect(onlyTrash.pins).toHaveLength(1)
    expect(onlyTrash.pins[0]!.category).toBe("trash")
    expect(onlyTrash.counts).toEqual({ trash: 1 })
  })

  it("omits counts for an empty view", async () => {
    const { service } = makeHarness()
    const bbox = { west: -1, south: -1, east: 1, north: 1 }
    const empty = await service.listReportsInBBox(bbox, null, null, 3)
    expect(empty.clusters).toHaveLength(0)
    expect(empty.pins).toHaveLength(0)
    expect(empty.counts).toBeUndefined()
  })
})

describe("searchReports", () => {
  it("returns only published+public+non-deleted reports as ReportPinDTOs with description carried", async () => {
    const { repo, service } = makeHarness()
    const pub = repo.seedReport({
      status: "published", visibility: "public", category: "trash",
      title: "Broken streetlight", description: "out for a week", addr: "5th Ave",
    })
    // Excluded: a held report, a hidden-visibility report, and a soft-deleted one.
    repo.seedReport({ status: "held", visibility: "public", title: "Held one", publishedAt: null })
    repo.seedReport({ status: "published", visibility: "hidden", title: "Hidden one" })
    repo.seedReport({ status: "published", visibility: "public", title: "Deleted one", deletedAt: new Date() })

    const res = await service.searchReports({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.id).toBe(pub.id)
    // Carries the SAME pin fields PLUS the report's description.
    expect(res.items[0]).toMatchObject({
      id: pub.id,
      category: "trash",
      status: "published",
      title: "Broken streetlight",
      description: "out for a week",
    })
    expect(res.nextCursor).toBeNull()
  })

  it("carries thumbUrl from the first ready photo (presigned) and null when there is no media", async () => {
    const { repo, service } = makeHarness()
    const withPhoto = repo.seedReport({ status: "published", visibility: "public", title: "with photo" })
    repo.seedMedia({ reportId: withPhoto.id, status: "ready", r2Key: "uploads/x", thumbKey: "thumbs/x" })
    const noPhoto = repo.seedReport({ status: "published", visibility: "public", title: "no photo" })

    const res = await service.searchReports({})
    const byId = new Map(res.items.map((p) => [p.id, p]))
    expect(byId.get(withPhoto.id)!.thumbUrl).toBe("memory://thumbs/x")
    expect(byId.get(noPhoto.id)!.thumbUrl).toBeNull()
  })

  it("filters by free-text q (case-insensitive) over title OR address", async () => {
    const { repo, service } = makeHarness()
    const byTitle = repo.seedReport({ status: "published", visibility: "public", title: "Pothole on Main" })
    const byAddr = repo.seedReport({ status: "published", visibility: "public", title: "Graffiti", addr: "12 POTHOLE Lane" })
    repo.seedReport({ status: "published", visibility: "public", title: "Trash pile", addr: "9 Elm St" })

    const res = await service.searchReports({ q: "pothole" })
    const ids = new Set(res.items.map((p) => p.id))
    expect(ids.has(byTitle.id)).toBe(true) // matched on title
    expect(ids.has(byAddr.id)).toBe(true) // matched on address, case-insensitively
    expect(res.items).toHaveLength(2)
  })

  it("filters by category set", async () => {
    const { repo, service } = makeHarness()
    const trash = repo.seedReport({ status: "published", visibility: "public", category: "trash", title: "t" })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", title: "g" })

    const res = await service.searchReports({ categories: ["trash"] })
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.id).toBe(trash.id)
    expect(res.items[0]!.category).toBe("trash")
  })

  it("filters by fine-grained type set (0021), alongside category", async () => {
    const { repo, service } = makeHarness()
    // Two trash-category reports with DIFFERENT fine types; the type filter narrows to one.
    const dump = repo.seedReport({ status: "published", visibility: "public", category: "trash", type: "dump", title: "dumped mattress" })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", type: "graffiti", title: "tag" })

    const res = await service.searchReports({ types: ["dump"] })
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.id).toBe(dump.id)
    expect(res.items[0]!.type).toBe("dump")
  })

  it("paginates newest-first by the keyset cursor without skipping or duplicating", async () => {
    const { repo, service } = makeHarness()
    const r1 = repo.seedReport({ status: "published", visibility: "public", title: "one" })
    const r2 = repo.seedReport({ status: "published", visibility: "public", title: "two" })
    const r3 = repo.seedReport({ status: "published", visibility: "public", title: "three" })

    const page1 = await service.searchReports({ limit: 2 })
    expect(page1.items.map((p) => p.id)).toEqual([r3.id, r2.id]) // newest-first
    expect(page1.nextCursor).toBeTruthy()

    const page2 = await service.searchReports({ limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((p) => p.id)).toEqual([r1.id])
    expect(page2.nextCursor).toBeNull()
  })

  it("does not skip a row when two reports share the SAME created_at across a page boundary", async () => {
    const { repo, service } = makeHarness()
    const tie = new Date("2026-05-31T12:00:00.000Z")
    const later = new Date("2026-05-31T12:00:01.000Z")
    repo.seedReport({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", status: "published", visibility: "public", title: "a", createdAt: tie })
    repo.seedReport({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "published", visibility: "public", title: "b", createdAt: tie })
    repo.seedReport({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "published", visibility: "public", title: "c", createdAt: later })

    const seen: string[] = []
    let cursor: string | null | undefined = undefined
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof service.searchReports>> = await service.searchReports({
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      for (const item of page.items) seen.push(item.id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen[0]).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc") // newest distinct created_at first
  })
})
