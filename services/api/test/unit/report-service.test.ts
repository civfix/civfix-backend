import { describe, it, expect } from "vitest"
import { REPORT_TYPE_TO_CATEGORY, type CreateReportRequest, type ReportDTO } from "@civfix/shared"
import {
  makeReportService,
  clusterByZoom,
  countByCategory,
  clusterCellSizeDeg,
  effectiveMapZoom,
  impliedZoomForBBox,
  reportH3Cell,
  CLUSTER_ZOOM_THRESHOLD,
  REPORT_H3_RESOLUTION,
  type ReportMapPoint,
  type ReportService,
} from "../../src/services/report-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"


const VALID_UUID = "11111111-1111-1111-1111-111111111111"

function fakePresign(r2Key: string, thumbKey: string | null) {
  return Promise.resolve(
    thumbKey === null
      ? { url: `memory://${r2Key}` }
      : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
  )
}

class FakeReportChatEmitter {
  readonly events: { reportId: string; status: string; kind?: string | null; note?: string | null }[] = []
  emit(event: { reportId: string; status: string; kind?: string | null; note?: string | null }): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

function makeHarness(
  opts: {
    geoid?: string | null
    jurCode?: number
    newId?: () => string
    loadReportChatMeta?: (
      reportId: string,
      viewerUserId: string | null,
    ) => Promise<{ joined: boolean; memberCount: number; messageCount: number; unread: number }>
  } = {},
) {
  const repo = new InMemoryReportRepository()
  const emitter = new FakeReportChatEmitter()
  const geoid: string | null = "geoid" in opts ? (opts.geoid ?? null) : "0644000"
  const service: ReportService = makeReportService({
    repo,
    resolveJurisdictionGeoid: () => Promise.resolve(geoid),
    presignMedia: fakePresign,
    reportChatEmitter: emitter,
    ...(opts.jurCode !== undefined
      ? { resolveJurisdictionCode: () => Promise.resolve(opts.jurCode as number) }
      : {}),
    ...(opts.loadReportChatMeta !== undefined
      ? { loadReportChatMeta: opts.loadReportChatMeta }
      : {}),
    ...(opts.newId !== undefined ? { newId: opts.newId } : {}),
  })
  return { repo, service, emitter }
}

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


describe("clusterCellSizeDeg", () => {
  it("halves with each zoom step and is the world width at zoom 0", () => {
    expect(clusterCellSizeDeg(0)).toBeCloseTo(180, 6)
    expect(clusterCellSizeDeg(1)).toBeCloseTo(90, 6)
    expect(clusterCellSizeDeg(2)).toBeCloseTo(45, 6)
    expect(clusterCellSizeDeg(5)).toBeLessThan(clusterCellSizeDeg(4))
  })

  it("floors fractional zoom and clamps negatives to zoom 0", () => {
    expect(clusterCellSizeDeg(3.9)).toBe(clusterCellSizeDeg(3))
    expect(clusterCellSizeDeg(-4)).toBe(clusterCellSizeDeg(0))
  })
})

describe("clusterByZoom", () => {
  const pts: ReportMapPoint[] = [
    { id: "a", lat: 34.10, lng: -118.350, category: "trash", type: "dump", status: "published", title: "Mattress dumped", description: "blocking the sidewalk", addr: "12 Spring St", referenceCode: "DU-42-000001", thumbKey: "thumbs/a", r2Key: "uploads/a" },
    { id: "b", lat: 34.11, lng: -118.351, category: "graffiti", type: "graffiti", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
    { id: "c", lat: 34.12, lng: -118.352, category: "trash", type: "dump", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
    { id: "d", lat: 40.71, lng: -74.000, category: "hazard", type: "encampment", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
  ]

  it("at/above the threshold returns individual pins and no clusters", () => {
    const { clusters, pins } = clusterByZoom(pts, CLUSTER_ZOOM_THRESHOLD)
    expect(clusters).toHaveLength(0)
    expect(pins).toHaveLength(4)
    const a = pins.find((p) => p.id === "a")!
    expect(a).toMatchObject({
      id: "a",
      category: "trash",
      type: "dump",
      status: "published",
      lat: 34.1,
      title: "Mattress dumped",
      description: "blocking the sidewalk",
      addr: "12 Spring St",
      referenceCode: "DU-42-000001",
      thumbKey: "thumbs/a",
      r2Key: "uploads/a",
    })
  })

  it("below the threshold snaps to a grid and emits clusters with correct counts", () => {
    const { clusters, pins } = clusterByZoom(pts, 3)
    expect(pins).toHaveLength(0)
    expect(clusters).toHaveLength(2)

    const total = clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBe(4)

    const counts = clusters.map((c) => c.count).sort()
    expect(counts).toEqual([1, 3])

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
      { id: "a", lat: 0, lng: 0, category: "trash", type: "dump", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
      { id: "b", lat: 0, lng: 0, category: "trash", type: "dump", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
      { id: "c", lat: 0, lng: 0, category: "graffiti", type: "graffiti", status: "published", title: null, description: null, addr: null, referenceCode: null, thumbKey: null, r2Key: null },
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
    expect(reportH3Cell(34.1, -118.35)).toBe(cell)
    expect(reportH3Cell(34.2, -118.35)).not.toBe(cell)
    expect(REPORT_H3_RESOLUTION).toBe(10)
  })
})


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
    expect(dto.timeline).toHaveLength(1)
    expect(dto.timeline[0]!.status).toBe("published")

    expect(dto.referenceCode).toMatch(/^GR-0-\d{6}$/)

    const stored = repo.reports.get(dto.id)!
    expect(stored.status).toBe("published")
    expect(stored.referenceCode).toBe(dto.referenceCode)
    expect(stored.type).toBe("graffiti")
    expect(repo.idempotency.size).toBe(1)
  })

  it("resolves a null jurisdiction (outside coverage) without failing", async () => {
    const { service } = makeHarness({ geoid: null })
    const dto = await service.createReport(createReq(), { userId: "u1" })
    expect(dto.jurisdictionGeoid).toBeUndefined()
  })

  it("persists the title + reverse-geocoded address and echoes them in the DTO", async () => {
    const { repo, service } = makeHarness()
    const dto = await service.createReport(
      createReq({ title: "Mattress dumped on the corner", addr: "123 Main St, Springfield" }),
      { userId: "u1" },
    )
    expect(dto.title).toBe("Mattress dumped on the corner")
    expect(dto.addr).toBe("123 Main St, Springfield")
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
    expect(repo.media.find((m) => m.id === asset.id)!.reportId).toBe(dto.id)
  })

  it("does not steal media already attached to a different report", async () => {
    const { repo, service } = makeHarness()
    const foreign = repo.seedMedia({ reportId: "other-report" })

    const dto = await service.createReport(
      createReq({ mediaUploadIds: [foreign.uploadId] }),
      { userId: "u1" },
    )
    expect(repo.media.find((m) => m.id === foreign.id)!.reportId).toBe("other-report")
    expect(dto.media).toHaveLength(0)
  })
})

describe("createReport: reference code (#56)", () => {
  it("uses the resolved JURCODE in the code's middle segment", async () => {
    const { service } = makeHarness({ geoid: "0644000", jurCode: 42 })
    const dto = await service.createReport(createReq({ type: "dump" }), { userId: "u1" })
    expect(dto.referenceCode).toMatch(/^DU-42-\d{6}$/)
  })

  it("falls back to JURCODE 0 (unknown bucket) for an unresolved jurisdiction", async () => {
    const { service } = makeHarness({ geoid: null, jurCode: 0 })
    const dto = await service.createReport(createReq({ type: "graffiti" }), { userId: "u1" })
    expect(dto.referenceCode).toMatch(/^GR-0-\d{6}$/)
  })

  it("getReport resolves by reference_code (resolve-either)", async () => {
    const { service } = makeHarness({ jurCode: 7 })
    const created = await service.createReport(createReq({ type: "dump" }), { userId: "u1" })
    const code = created.referenceCode!
    const fetched = await service.getReport(code, { userId: "u1" })
    expect(fetched.id).toBe(created.id)
    expect(fetched.referenceCode).toBe(code)
  })
})

describe("createReport: idempotency replay", () => {
  it("returns the ORIGINAL stored snapshot for a duplicate key without inserting a second report", async () => {
    const { repo, service } = makeHarness()
    const first = await service.createReport(createReq(), { userId: "u1" })
    expect(repo.reports.size).toBe(1)

    const second = await service.createReport(
      createReq({ category: "hazard", description: "changed" }),
      { userId: "u1" },
    )
    expect(second.id).toBe(first.id)
    expect(second).toEqual(first)
    expect(repo.reports.size).toBe(1)
    expect(repo.idempotency.size).toBe(1)
  })

  it("a pre-seeded snapshot is replayed without touching the repo's create path", async () => {
    const { repo, service } = makeHarness()
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
    repo.idempotency.set(`report_create:${VALID_UUID}:u1`, {
      key: VALID_UUID,
      scope: "report_create",
      userOrAnon: "u1",
      snapshot: seeded,
    })

    const dto = await service.createReport(createReq(), { userId: "u1" })
    expect(dto).toEqual(seeded)
    expect(repo.reports.size).toBe(0)
  })
})

describe("createReport: idempotency is scoped to the caller (F028)", () => {
  it("does NOT replay one user's snapshot to a DIFFERENT user presenting the same key", async () => {
    const { repo, service } = makeHarness()
    const a = await service.createReport(createReq({ title: "A's report" }), { userId: "userA" })
    const b = await service.createReport(createReq({ title: "B's report" }), { userId: "userB" })
    expect(b.id).not.toBe(a.id)
    expect(repo.reports.size).toBe(2)
    expect(repo.reports.get(a.id)!.reporterUserId).toBe("userA")
    expect(repo.reports.get(b.id)!.reporterUserId).toBe("userB")
  })
})

describe("createReport: derives the canonical category from the type (F060)", () => {
  it("stores REPORT_TYPE_TO_CATEGORY[type], ignoring a mismatched client-supplied category", async () => {
    const { repo, service } = makeHarness()
    const dto = await service.createReport(createReq({ type: "dump", category: "graffiti" }), {
      userId: "u1",
    })
    expect(dto.type).toBe("dump")
    expect(dto.category).toBe(REPORT_TYPE_TO_CATEGORY.dump)
    expect(dto.category).not.toBe("graffiti")
    expect(repo.reports.get(dto.id)!.category).toBe(REPORT_TYPE_TO_CATEGORY.dump)
  })
})

describe("createReport: auto-forward enqueue on replay (F062)", () => {
  it("enqueues auto-forward exactly once and NOT again on an idempotent replay", async () => {
    const repo = new InMemoryReportRepository()
    const enqueued: { name: string; data: unknown }[] = []
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: fakePresign,
      isReportVerified: () => Promise.resolve(true),
      jobs: {
        enqueue: (name: string, data: unknown) => {
          enqueued.push({ name, data })
          return Promise.resolve("job-id")
        },
      },
    } as unknown as Parameters<typeof makeReportService>[0])

    const first = await service.createReport(createReq(), { userId: "u1" })
    const replay = await service.createReport(createReq(), { userId: "u1" })

    expect(replay.id).toBe(first.id)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.data).toMatchObject({ reportId: first.id })
  })
})

describe("createReport: credits no volunteer hours", () => {
  it("never reaches a report-hours award seam, and still creates the report", async () => {
    const awarded: unknown[][] = []
    const repo = new InMemoryReportRepository()
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: fakePresign,
      awardReportHours: (...args: unknown[]) => {
        awarded.push(args)
        return Promise.resolve()
      },
    } as unknown as Parameters<typeof makeReportService>[0])

    const dto = await service.createReport(createReq(), { userId: "u1" })

    expect(dto.status).toBe("published")
    expect(repo.reports.size).toBe(1)
    expect(awarded).toEqual([])
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

  it("carries the report-chat metadata on the DETAIL DTO (joined/member/message/unread) and passes the viewer through", async () => {
    const calls: { reportId: string; viewerId: string | null }[] = []
    const { repo, service } = makeHarness({
      loadReportChatMeta: (reportId, viewerId) => {
        calls.push({ reportId, viewerId })
        return Promise.resolve({ joined: true, memberCount: 3, messageCount: 12, unread: 4 })
      },
    })
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })

    const dto = await service.getReport(r.id, { userId: "member" })
    expect(dto.chatJoined).toBe(true)
    expect(dto.chatMemberCount).toBe(3)
    expect(dto.chatMessageCount).toBe(12)
    expect(dto.chatUnread).toBe(4)
    expect(calls).toEqual([{ reportId: r.id, viewerId: "member" }])
  })

  it("passes viewerId=null for an anonymous detail fetch (joined=false, unread=0, counts still valid)", async () => {
    const calls: { reportId: string; viewerId: string | null }[] = []
    const { repo, service } = makeHarness({
      loadReportChatMeta: (reportId, viewerId) => {
        calls.push({ reportId, viewerId })
        return Promise.resolve({ joined: false, memberCount: 2, messageCount: 5, unread: 0 })
      },
    })
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })

    const dto = await service.getReport(r.id, {})
    expect(dto.chatJoined).toBe(false)
    expect(dto.chatMemberCount).toBe(2)
    expect(dto.chatMessageCount).toBe(5)
    expect(dto.chatUnread).toBe(0)
    expect(calls).toEqual([{ reportId: r.id, viewerId: null }])
  })

  it("omits the chat metadata entirely when no loader is wired (offline/fake path)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })
    const dto = await service.getReport(r.id, { userId: "member" })
    expect(dto.chatJoined).toBeUndefined()
    expect(dto.chatMemberCount).toBeUndefined()
    expect(dto.chatMessageCount).toBeUndefined()
    expect(dto.chatUnread).toBeUndefined()
  })

  it("surfaces a city reply's kind + full body on the timeline DTO (D13)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })
    repo.timeline.push({
      reportId: r.id,
      status: "published",
      note: null,
      createdAt: new Date(Date.now() - 1000),
    })
    const fullBody = "We've scheduled a crew and will follow up after the visit — thanks for the report."
    repo.timeline.push({
      reportId: r.id,
      status: "published",
      note: "Jurisdiction replied — We've scheduled a crew…",
      kind: "reply",
      body: fullBody,
      createdAt: new Date(),
    })
    const dto = await service.getReport(r.id, {})
    const reply = dto.timeline.find((t) => t.kind === "reply")
    expect(reply).toBeDefined()
    expect(reply?.body).toBe(fullBody)
    expect(reply?.note).toContain("Jurisdiction replied")
    const statusOnly = dto.timeline.find((t) => t.kind === undefined)
    expect(statusOnly).toBeDefined()
    expect(statusOnly?.note).toBeUndefined()
    expect(statusOnly?.body).toBeUndefined()
  })
})

describe("resolveReport (owner status toggle)", () => {
  it("the owner marks their report resolved (status flips + a timeline entry is appended)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner" })

    const dto = await service.resolveReport("owner", r.id, true)
    expect(dto.status).toBe("resolved")
    const last = dto.timeline[dto.timeline.length - 1]!
    expect(last.status).toBe("resolved")
    expect(last.note).toBe("Marked resolved by the reporter")
    expect(repo.reports.get(r.id)!.status).toBe("resolved")
  })

  it("emits a report-chat system event carrying the resolved status when the owner resolves", async () => {
    const { repo, service, emitter } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner" })
    await service.resolveReport("owner", r.id, true)
    expect(emitter.events).toHaveLength(1)
    expect(emitter.events[0]).toMatchObject({
      reportId: r.id,
      status: "resolved",
      kind: "done",
      note: "Marked resolved by the reporter",
    })
  })

  it("reopening a resolved report returns it to published with a 'Reopened' timeline entry", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "resolved" })

    const dto = await service.resolveReport("owner", r.id, false)
    expect(dto.status).toBe("published")
    const last = dto.timeline[dto.timeline.length - 1]!
    expect(last.status).toBe("published")
    expect(last.note).toBe("Reopened by the reporter")
    expect(repo.reports.get(r.id)!.status).toBe("published")
  })

  it("403s when the caller does not own the report (and leaves the status untouched)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published" })
    await expect(service.resolveReport("stranger", r.id, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.reports.get(r.id)!.status).toBe("published")
  })

  it("404s resolving a missing report", async () => {
    const { service } = makeHarness()
    await expect(
      service.resolveReport("owner", "00000000-0000-0000-0000-000000000000", true),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s resolving a soft-deleted report", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", deletedAt: new Date() })
    await expect(service.resolveReport("owner", r.id, true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })


  it("L12: 404s (not 403) a stranger probing a HELD report", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "held", visibility: "public" })
    await expect(service.resolveReport("stranger", r.id, true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      service.resolveReport("stranger", "00000000-0000-0000-0000-000000000000", true),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(repo.reports.get(r.id)!.status).toBe("held")
  })

  it("L12: 404s a stranger probing an owner-UNLISTED report", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "hidden" })
    await expect(service.resolveReport("stranger", r.id, true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.unlistReport("stranger", r.id, false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(repo.reports.get(r.id)!.visibility).toBe("hidden")
  })

  it("L12: the owner is unaffected — they still mutate their own held/unlisted report", async () => {
    const { repo, service } = makeHarness()
    const held = repo.seedReport({ reporterUserId: "owner", status: "held", visibility: "public" })
    await service.unlistReport("owner", held.id, true)
    expect(repo.reports.get(held.id)!.visibility).toBe("hidden")
  })

  it("F057: 409s the OWNER resolving/reopening a HELD report and leaves it held", async () => {
    const { repo, service } = makeHarness()
    const held = repo.seedReport({ reporterUserId: "owner", status: "held", visibility: "public" })
    await expect(service.resolveReport("owner", held.id, true)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(service.resolveReport("owner", held.id, false)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.reports.get(held.id)!.status).toBe("held")
  })

  it("F057: 409s the OWNER resolving a submitted (pre-publish) report", async () => {
    const { repo, service } = makeHarness()
    const sub = repo.seedReport({ reporterUserId: "owner", status: "submitted", visibility: "public" })
    await expect(service.resolveReport("owner", sub.id, true)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.reports.get(sub.id)!.status).toBe("submitted")
  })
})

describe("unlistReport (owner visibility toggle)", () => {
  it("the owner hides their report (visibility flips to hidden + a timeline entry, status untouched)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published" })

    const dto = await service.unlistReport("owner", r.id, true)
    expect(dto.visibility).toBe("hidden")
    expect(dto.status).toBe("published")
    const last = dto.timeline[dto.timeline.length - 1]!
    expect(last.status).toBe("published")
    expect(last.kind).toBe("hidden")
    expect(last.note).toBe("Hidden from the public map by the reporter")
    expect(repo.reports.get(r.id)!.visibility).toBe("hidden")
    expect(repo.reports.get(r.id)!.status).toBe("published")
  })

  it("tags the hide event as a visibility change, leaving the status row untouched", async () => {
    const { repo, service, emitter } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published" })

    const dto = await service.unlistReport("owner", r.id, true)
    expect(dto.timeline.filter((e) => e.kind === "hidden")).toHaveLength(1)
    expect(dto.timeline.every((e) => e.status !== "resolved")).toBe(true)
    expect(emitter.events).toEqual([
      {
        reportId: r.id,
        status: "published",
        kind: "hidden",
        note: "Hidden from the public map by the reporter",
      },
    ])
  })

  it("re-listing a hidden report returns it to public with a 'Re-listed' timeline entry", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "hidden" })

    const dto = await service.unlistReport("owner", r.id, false)
    expect(dto.visibility).toBe("public")
    const last = dto.timeline[dto.timeline.length - 1]!
    expect(last.kind).toBe("unhidden")
    expect(last.note).toBe("Re-listed by the reporter")
    expect(repo.reports.get(r.id)!.visibility).toBe("public")
  })

  it("re-hiding an already-hidden report writes no second row and emits nothing", async () => {
    const { repo, service, emitter } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published" })

    await service.unlistReport("owner", r.id, true)
    const after = await service.unlistReport("owner", r.id, true)
    expect(after.visibility).toBe("hidden")
    expect(after.timeline.filter((e) => e.kind === "hidden")).toHaveLength(1)
    expect(emitter.events).toHaveLength(1)
  })

  it("403s when the caller does not own the report (and leaves the visibility untouched)", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published" })
    await expect(service.unlistReport("stranger", r.id, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.reports.get(r.id)!.visibility).toBe("public")
  })

  it("404s unlisting a missing report", async () => {
    const { service } = makeHarness()
    await expect(
      service.unlistReport("owner", "00000000-0000-0000-0000-000000000000", true),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s unlisting a soft-deleted report", async () => {
    const { repo, service } = makeHarness()
    const r = repo.seedReport({ reporterUserId: "owner", deletedAt: new Date() })
    await expect(service.unlistReport("owner", r.id, true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("listMyReports", () => {
  it("returns the caller's non-deleted reports newest-first and paginates by cursor", async () => {
    const { repo, service } = makeHarness()
    const r1 = repo.seedReport({ reporterUserId: "me" })
    const r2 = repo.seedReport({ reporterUserId: "me" })
    const r3 = repo.seedReport({ reporterUserId: "me" })
    repo.seedReport({ reporterUserId: "other" })
    repo.seedReport({ reporterUserId: "me", deletedAt: new Date() })

    const page1 = await service.listMyReports("me", { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    expect(page1.items[0]!.id).toBe(r3.id)
    expect(page1.items[1]!.id).toBe(r2.id)

    const page2 = await service.listMyReports("me", { limit: 2, cursor: page1.nextCursor! })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]!.id).toBe(r1.id)
    expect(page2.nextCursor).toBeNull()
  })

  it("does NOT populate report-chat metadata on the LIST path even when a loader is wired (detail-only)", async () => {
    let called = 0
    const { repo, service } = makeHarness({
      loadReportChatMeta: () => {
        called += 1
        return Promise.resolve({ joined: true, memberCount: 9, messageCount: 9, unread: 9 })
      },
    })
    repo.seedReport({ reporterUserId: "me" })
    repo.seedReport({ reporterUserId: "me" })

    const page = await service.listMyReports("me", { limit: 10 })
    expect(page.items.length).toBeGreaterThan(0)
    for (const item of page.items) {
      expect(item.chatJoined).toBeUndefined()
      expect(item.chatMemberCount).toBeUndefined()
      expect(item.chatMessageCount).toBeUndefined()
      expect(item.chatUnread).toBeUndefined()
    }
    expect(called).toBe(0)
  })

  it("does NOT skip a row when two reports share the SAME created_at across a page boundary (P1-3)", async () => {
    const { repo, service } = makeHarness()
    const tie = new Date("2026-05-31T12:00:00.000Z")
    const later = new Date("2026-05-31T12:00:01.000Z")
    repo.seedReport({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", reporterUserId: "me", createdAt: tie })
    repo.seedReport({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", reporterUserId: "me", createdAt: tie })
    repo.seedReport({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", reporterUserId: "me", createdAt: later })

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

    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toContain("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    expect(seen).toContain("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    expect(seen).toContain("cccccccc-cccc-cccc-cccc-cccccccccccc")
    expect(seen[0]).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc")
  })
})

describe("listReportsInBBox", () => {
  it("clusters at low zoom and returns per-category counts over the candidates", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.11, lng: -118.34 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.12, lng: -118.33 })
    repo.seedReport({ status: "published", visibility: "public", category: "hazard", lat: 10, lng: 10 })
    repo.seedReport({ status: "held", visibility: "public", category: "trash", lat: 34.1, lng: -118.35 })

    const bbox = { west: -118.5, south: 34.0, east: -118.2, north: 34.2 }
    const low = await service.listReportsInBBox(bbox, null, null, 3)
    expect(low.pins).toHaveLength(0)
    expect(low.clusters.length).toBeGreaterThanOrEqual(1)
    const total = low.clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBe(3)
    expect(low.counts).toEqual({ trash: 2, graffiti: 1 })
  })

  it("returns individual pins at high zoom", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })

    const bbox = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }
    const high = await service.listReportsInBBox(bbox, null, null, 16)
    expect(high.clusters).toHaveLength(0)
    expect(high.pins).toHaveLength(2)
  })

  it("enriches high-zoom pins with title + a presigned first-photo thumbUrl", async () => {
    const { repo, service } = makeHarness()
    const bbox = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }

    const withThumb = repo.seedReport({
      status: "published", visibility: "public", category: "trash",
      lat: 34.10, lng: -118.35, title: "Mattress dumped", description: "blocking the sidewalk",
    })
    repo.seedMedia({ reportId: withThumb.id, status: "ready", r2Key: "uploads/a", thumbKey: "thumbs/a" })

    const noThumb = repo.seedReport({
      status: "published", visibility: "public", category: "graffiti",
      lat: 34.11, lng: -118.34, title: "Graffiti on the wall",
    })
    repo.seedMedia({ reportId: noThumb.id, status: "ready", r2Key: "uploads/b", thumbKey: null })

    const noMedia = repo.seedReport({
      status: "published", visibility: "public", category: "hazard",
      lat: 34.12, lng: -118.33, title: "Pothole",
    })

    const pendingOnly = repo.seedReport({
      status: "published", visibility: "public", category: "water",
      lat: 34.13, lng: -118.32, title: null,
    })
    repo.seedMedia({ reportId: pendingOnly.id, status: "validating", r2Key: "uploads/d", thumbKey: "thumbs/d" })

    const high = await service.listReportsInBBox(bbox, null, null, 16)
    const byId = new Map(high.pins.map((p) => [p.id, p]))

    expect(byId.get(withThumb.id)).toMatchObject({ title: "Mattress dumped", description: "blocking the sidewalk", thumbUrl: "memory://thumbs/a" })
    expect(byId.get(noThumb.id)).toMatchObject({ title: "Graffiti on the wall", description: null, thumbUrl: "memory://uploads/b" })
    expect(byId.get(noMedia.id)).toMatchObject({ title: "Pothole", description: null, thumbUrl: null })

    const pending = byId.get(pendingOnly.id)!
    expect(pending.thumbUrl).toBeNull()
    expect(pending.title).toBeUndefined()
  })

  it("previews a video's poster but never a thumbless video's raw key", async () => {
    const { repo, service } = makeHarness()
    const bbox = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }

    const posterOnly = repo.seedReport({
      status: "published", visibility: "public", category: "trash",
      lat: 34.10, lng: -118.35, title: "Dumping caught on video",
    })
    repo.seedMedia({
      reportId: posterOnly.id, status: "ready", kind: "video",
      r2Key: "uploads/clip.mp4", thumbKey: "thumbs/clip.jpg",
    })

    const thumbless = repo.seedReport({
      status: "published", visibility: "public", category: "hazard",
      lat: 34.11, lng: -118.34, title: "Video still transcoding",
    })
    repo.seedMedia({
      reportId: thumbless.id, status: "ready", kind: "video",
      r2Key: "uploads/raw.mp4", thumbKey: null,
    })

    const high = await service.listReportsInBBox(bbox, null, null, 16)
    const byId = new Map(high.pins.map((p) => [p.id, p]))
    expect(byId.get(posterOnly.id)!.thumbUrl).toBe("memory://thumbs/clip.jpg")
    expect(byId.get(thumbless.id)!.thumbUrl).toBeNull()
  })

  it("filters by category when provided", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 34.11, lng: -118.34 })

    const bbox = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }
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

  it("M14: a world bbox at zoom 22 produces ZERO per-pin rows (no presign fan-out)", async () => {
    const { repo, service } = makeHarness()
    repo.seedReport({ status: "published", visibility: "public", category: "trash", lat: 34.10, lng: -118.35 })
    repo.seedReport({ status: "published", visibility: "public", category: "graffiti", lat: 40.71, lng: -74.0 })

    const world = { west: -180, south: -85, east: 180, north: 85 }
    const attack = await service.listReportsInBBox(world, null, null, 22)

    expect(attack.pins).toHaveLength(0)
    expect(attack.clusters.length).toBeGreaterThanOrEqual(1)
    expect(attack.counts).toEqual({ trash: 1, graffiti: 1 })
  })
})

describe("effectiveMapZoom / impliedZoomForBBox (M14)", () => {
  it("clamps a claimed street-level zoom down to what a world bbox implies", () => {
    const world = { west: -180, south: -90, east: 180, north: 90 }
    expect(impliedZoomForBBox(world)).toBeLessThan(CLUSTER_ZOOM_THRESHOLD)
    expect(effectiveMapZoom(world, 22)).toBeLessThan(CLUSTER_ZOOM_THRESHOLD)
  })

  it("leaves a genuine neighborhood viewport alone (clamping is one-directional)", () => {
    const hood = { west: -118.36, south: 34.09, east: -118.31, north: 34.14 }
    expect(impliedZoomForBBox(hood)).toBeGreaterThanOrEqual(CLUSTER_ZOOM_THRESHOLD)
    expect(effectiveMapZoom(hood, 4)).toBe(4)
  })

  it("never returns a negative or non-finite zoom for a degenerate bbox", () => {
    const degenerate = { west: 0, south: 0, east: 0, north: 0 }
    expect(impliedZoomForBBox(degenerate)).toBe(0)
    expect(effectiveMapZoom(degenerate, Number.NaN)).toBe(0)
  })

  const PHONE_WIDTH_PT = 402
  const PHONE_HEIGHT_PT = 874
  const REGION_PAD_FACTOR = 1.6
  const DOWNTOWN_LA = { lat: 34.05, lng: -118.25 }

  function phoneFetchBBox(mapZoom: number) {
    const pxPerDeg = (512 * Math.pow(2, mapZoom)) / 360
    const halfLng = (PHONE_WIDTH_PT / pxPerDeg / 2) * REGION_PAD_FACTOR
    const halfLat =
      ((PHONE_HEIGHT_PT / pxPerDeg) * Math.cos((DOWNTOWN_LA.lat * Math.PI) / 180) / 2) *
      REGION_PAD_FACTOR
    return {
      west: DOWNTOWN_LA.lng - halfLng,
      east: DOWNTOWN_LA.lng + halfLng,
      south: DOWNTOWN_LA.lat - halfLat,
      north: DOWNTOWN_LA.lat + halfLat,
    }
  }

  it("lets a phone's padded fetch bbox reach individual pins from map zoom 11", () => {
    expect(effectiveMapZoom(phoneFetchBBox(11), 16)).toBeGreaterThanOrEqual(CLUSTER_ZOOM_THRESHOLD)
    expect(effectiveMapZoom(phoneFetchBBox(14), 16)).toBeGreaterThanOrEqual(CLUSTER_ZOOM_THRESHOLD)
  })

  it("still clusters the same phone viewport one zoom step further out", () => {
    expect(effectiveMapZoom(phoneFetchBBox(10), 16)).toBeLessThan(CLUSTER_ZOOM_THRESHOLD)
    expect(effectiveMapZoom(phoneFetchBBox(8), 16)).toBeLessThan(CLUSTER_ZOOM_THRESHOLD)
  })
})

describe("searchReports", () => {
  it("returns only published+public+non-deleted reports as ReportPinDTOs with description/addr/referenceCode carried", async () => {
    const { repo, service } = makeHarness()
    const pub = repo.seedReport({
      status: "published", visibility: "public", category: "trash",
      title: "Broken streetlight", description: "out for a week", addr: "5th Ave",
      referenceCode: "TR-7-000009",
    })
    repo.seedReport({ status: "held", visibility: "public", title: "Held one", publishedAt: null })
    repo.seedReport({ status: "published", visibility: "hidden", title: "Hidden one" })
    repo.seedReport({ status: "published", visibility: "public", title: "Deleted one", deletedAt: new Date() })

    const res = await service.searchReports({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]!.id).toBe(pub.id)
    expect(res.items[0]).toMatchObject({
      id: pub.id,
      category: "trash",
      status: "published",
      title: "Broken streetlight",
      description: "out for a week",
      addr: "5th Ave",
      referenceCode: "TR-7-000009",
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
    expect(ids.has(byTitle.id)).toBe(true)
    expect(ids.has(byAddr.id)).toBe(true)
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
    expect(page1.items.map((p) => p.id)).toEqual([r3.id, r2.id])
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
    expect(seen[0]).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc")
  })
})

/**
 * F058: owner-only report media (held / unlisted, and any still-`validating` asset) used to be signed with
 * the PUBLIC presigner, which returns a permanent unsigned CDN URL whenever R2_PUBLIC_BASE is configured.
 * The presigner is chosen per report + per asset now; the public map surfaces keep the public one.
 */
describe("report media presigner selection (F058)", () => {
  function presignHarness() {
    const repo = new InMemoryReportRepository()
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve("0644000"),
      presignMedia: (r2Key: string) => Promise.resolve({ url: `public://${r2Key}` }),
      presignPrivateMedia: (r2Key: string) => Promise.resolve({ url: `signed://${r2Key}` }),
    })
    return { repo, service }
  }

  it("signs a HELD or UNLISTED report's media privately, and a published+public one publicly", async () => {
    const { repo, service } = presignHarness()
    const published = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })
    repo.seedMedia({ reportId: published.id, status: "ready", r2Key: "k/pub.jpg" })
    const held = repo.seedReport({ reporterUserId: "owner", status: "held", visibility: "public" })
    repo.seedMedia({ reportId: held.id, status: "ready", r2Key: "k/held.jpg" })
    const unlisted = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "hidden" })
    repo.seedMedia({ reportId: unlisted.id, status: "ready", r2Key: "k/unlisted.jpg" })

    expect((await service.getReport(published.id, { userId: "owner" })).media[0]!.url).toBe("public://k/pub.jpg")
    expect((await service.getReport(held.id, { userId: "owner" })).media[0]!.url).toBe("signed://k/held.jpg")
    expect((await service.getReport(unlisted.id, { userId: "owner" })).media[0]!.url).toBe(
      "signed://k/unlisted.jpg",
    )
  })

  it("signs a still-VALIDATING asset privately even on a published+public report", async () => {
    const { repo, service } = presignHarness()
    const r = repo.seedReport({ reporterUserId: "owner", status: "published", visibility: "public" })
    repo.seedMedia({ reportId: r.id, status: "validating", r2Key: "k/pending.jpg" })

    const dto = await service.getReport(r.id, { userId: "owner" })
    expect(dto.media[0]!.url).toBe("signed://k/pending.jpg")
  })
})
