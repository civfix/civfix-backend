import { describe, it, expect } from "vitest"
import type { CreateReportRequest, ReportDTO } from "@civfix/shared"
import { makeReportService } from "../../src/services/report-service.js"
import { InMemoryReportRepository } from "../helpers/reports.js"

const KEY = "11111111-1111-1111-1111-111111111111"
const OWNER = "u1"
const STALE_URL = "https://media.example/expired-signature"

function createReq(): CreateReportRequest {
  return {
    idempotencyKey: KEY,
    category: "trash",
    type: "dump",
    lat: 34.05,
    lng: -118.25,
    geomSource: "device",
    mediaUploadIds: [],
  }
}

function makeHarness(over: Partial<Parameters<typeof makeReportService>[0]> = {}) {
  const repo = new InMemoryReportRepository()
  let issued = 0
  const warnings: { obj: unknown; msg?: string }[] = []
  const service = makeReportService({
    repo,
    resolveJurisdictionGeoid: () => Promise.resolve(null),
    presignMedia: (r2Key: string) => {
      issued += 1
      return Promise.resolve({ url: `memory://${r2Key}?sig=${issued}` })
    },
    logger: { warn: (obj: unknown, msg?: string) => warnings.push({ obj, msg }) },
    ...over,
  })
  return { repo, service, warnings }
}

describe("createReport idempotent replay", () => {
  it("re-reads the report so replayed media URLs are freshly signed, not the create-time snapshot", async () => {
    const { repo, service } = makeHarness()
    const report = repo.seedReport({ reporterUserId: OWNER })
    repo.seedMedia({ reportId: report.id, status: "ready", r2Key: "served/photo.jpg" })
    const snapshot = {
      id: report.id,
      category: "trash",
      type: "dump",
      status: "published",
      visibility: "public",
      lat: 34.1,
      lng: -118.35,
      geomSource: "device",
      createdAt: report.createdAt.toISOString(),
      mine: true,
      gov: false,
      following: false,
      media: [{ id: "m-stale", kind: "image", url: STALE_URL, status: "ready" }],
      mediaPending: 0,
      timeline: [],
      linkedEvents: [],
    } as unknown as ReportDTO
    repo.idempotency.set(`report_create:${KEY}:${OWNER}`, {
      key: KEY,
      scope: "report_create",
      userOrAnon: OWNER,
      snapshot,
    })

    const dto = await service.createReport(createReq(), { userId: OWNER })

    expect(dto.id).toBe(report.id)
    expect(dto.media).toHaveLength(1)
    expect(dto.media[0]!.url).not.toBe(STALE_URL)
    expect(dto.media[0]!.url).toMatch(/^memory:\/\/served\/photo\.jpg\?sig=/)
    expect(repo.reports.size).toBe(1)
  })
})

describe("getReport optional meta loaders", () => {
  it("logs a discussion-meta failure instead of dropping it silently", async () => {
    const { repo, service, warnings } = makeHarness({
      loadDiscussionMeta: () => Promise.reject(new Error("discussion db down")),
    })
    const report = repo.seedReport({ reporterUserId: OWNER })

    const dto = await service.getReport(report.id, { userId: OWNER })

    expect(dto.id).toBe(report.id)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.obj).toMatchObject({ reportId: report.id })
    expect(String((warnings[0]!.obj as { err: unknown }).err)).toMatch(/discussion db down/)
  })

  it("logs a chat-meta failure instead of dropping it silently", async () => {
    const { repo, service, warnings } = makeHarness({
      loadReportChatMeta: () => Promise.reject(new Error("chat db down")),
    })
    const report = repo.seedReport({ reporterUserId: OWNER })

    const dto = await service.getReport(report.id, { userId: OWNER })

    expect(dto.id).toBe(report.id)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.obj).toMatchObject({ reportId: report.id })
  })
})
