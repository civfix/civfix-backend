import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { describe, it, expect, beforeEach } from "vitest"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { LINKED_REPORTS_LIST_PREVIEW } from "../../src/services/cleanup-dto.js"
import {
  LINKED_EVENTS_PER_REPORT_CAP,
  MAX_EVENTS_PER_REPORT,
} from "../../src/services/cleanup-repository.drizzle.js"
import { AppError, type CreateCleanupRequest } from "@civfix/shared"


const ORG = "11111111-1111-1111-1111-111111111111"
const STRANGER = "22222222-2222-2222-2222-222222222222"
const R1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
const R2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"
const R3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3"
const R4 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4"

let repo: InMemoryCleanupRepository
let service: CleanupService

function baseInput(over: Partial<CreateCleanupRequest> = {}): CreateCleanupRequest {
  return {
    title: over.title ?? "Beach cleanup",
    type: over.type ?? "site",
    eventKind: over.eventKind ?? "cleanup",
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.linkedReportIds !== undefined ? { linkedReportIds: over.linkedReportIds } : {}),
    lat: over.lat ?? 34.0,
    lng: over.lng ?? -118.49,
    scheduledAt: over.scheduledAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    ...(over.bring !== undefined ? { bring: over.bring } : {}),
    ...(over.address !== undefined ? { address: over.address } : {}),
    slots: over.slots ?? [{ title: "Volunteers" }],
  }
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedReport({ id: R1, title: "Bin 1", category: "trash", thumbKey: "thumb/r1.jpg" })
  repo.seedReport({ id: R2, title: "Graffiti", category: "graffiti" })
  repo.seedReport({ id: R3, title: "Held one", status: "held" })
  repo.seedReport({ id: R4, title: "Fixed hazard", category: "hazard", status: "resolved" })
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
  })
})

describe("createCleanup linking", () => {
  it("links the seeded reports + writes a report_linked timeline row + hydrates the gallery", async () => {
    const dto = await service.createCleanup(baseInput({ linkedReportIds: [R1, R2] }), ORG)

    expect(dto.eventKind).toBe("cleanup")
    expect(dto.linkedReports.map((r) => r.id).sort()).toEqual([R1, R2].sort())
    const r1 = dto.linkedReports.find((r) => r.id === R1)!
    expect(r1.thumbUrl).toBe("thumb/r1.jpg")
    expect(r1.title).toBe("Bin 1")
    expect(repo.links.filter((l) => l.cleanupId === dto.id)).toHaveLength(2)
    expect(repo.timeline.filter((t) => t.cleanupId === dto.id && t.kind === "report_linked")).toHaveLength(2)
  })

  it("rejects an invisible (held) report at create time with a 422", async () => {
    await expect(service.createCleanup(baseInput({ linkedReportIds: [R1, R3] }), ORG)).rejects.toMatchObject(
      { code: "VALIDATION" },
    )
    expect(repo.cleanups.size).toBe(0)
    expect(repo.links).toHaveLength(0)
  })

  it("rejects linking on a non-cleanup eventKind (other_volunteer)", async () => {
    await expect(
      service.createCleanup(baseInput({ eventKind: "other_volunteer", linkedReportIds: [R1] }), ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("creates an other_volunteer event with no links + an empty gallery", async () => {
    const dto = await service.createCleanup(baseInput({ eventKind: "other_volunteer" }), ORG)
    expect(dto.eventKind).toBe("other_volunteer")
    expect(dto.linkedReports).toEqual([])
  })
})

describe("updateCleanup (host-gated PATCH)", () => {
  it("403s a non-organizer", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(service.updateCleanup(created.id, { title: "Hijack" }, STRANGER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.cleanups.get(created.id)?.title).toBe("Beach cleanup")
  })

  it("404s a missing cleanup", async () => {
    await expect(
      service.updateCleanup("ffffffff-ffff-ffff-ffff-ffffffffffff", { title: "x" }, ORG),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("applies a scalar patch for the organizer", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    const updated = await service.updateCleanup(
      created.id,
      { title: "Renamed", address: "South gate", lat: 35, lng: -119 },
      ORG,
    )
    expect(updated.title).toBe("Renamed")
    expect(updated.address).toBe("South gate")
    expect(updated.lat).toBe(35)
    expect(updated.lng).toBe(-119)
  })

  it("reconciles linkedReports to the full desired set (add + remove)", async () => {
    const created = await service.createCleanup(baseInput({ linkedReportIds: [R1] }), ORG)
    const updated = await service.updateCleanup(created.id, { linkedReportIds: [R2] }, ORG)
    expect(updated.linkedReports.map((r) => r.id)).toEqual([R2])
    expect(repo.links.filter((l) => l.cleanupId === created.id).map((l) => l.reportId)).toEqual([R2])
    const kinds = repo.timeline.filter((t) => t.cleanupId === created.id).map((t) => t.kind)
    expect(kinds).toContain("report_unlinked")
  })

  it("rejects reconciling links on a non-cleanup eventKind", async () => {
    const created = await service.createCleanup(baseInput({ eventKind: "other_volunteer" }), ORG)
    await expect(
      service.updateCleanup(created.id, { linkedReportIds: [R1] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("rejects linking an invisible (held) report on update", async () => {
    const created = await service.createCleanup(baseInput(), ORG)
    await expect(
      service.updateCleanup(created.id, { linkedReportIds: [R3] }, ORG),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("drops existing links when the event is switched to other_volunteer", async () => {
    const created = await service.createCleanup(baseInput({ linkedReportIds: [R1, R2] }), ORG)
    const updated = await service.updateCleanup(created.id, { eventKind: "other_volunteer" }, ORG)
    expect(updated.eventKind).toBe("other_volunteer")
    expect(updated.linkedReports).toEqual([])
    expect(repo.links.filter((l) => l.cleanupId === created.id)).toHaveLength(0)
  })
})

describe("linking a report in a post-publication status (H8-b widening)", () => {
  it("links a resolved report at create time and shows it in the gallery", async () => {
    const dto = await service.createCleanup(baseInput({ linkedReportIds: [R1, R4] }), ORG)
    expect(dto.linkedReports.map((r) => r.id).sort()).toEqual([R1, R4].sort())
    const fixed = dto.linkedReports.find((r) => r.id === R4)
    expect(fixed?.status).toBe("resolved")
  })

  it("links a report in each other public progress status (acknowledged, in_progress)", async () => {
    const ack = repo.seedReport({ title: "Acked", status: "acknowledged" })
    const wip = repo.seedReport({ title: "Being fixed", status: "in_progress" })
    const dto = await service.createCleanup(baseInput({ linkedReportIds: [ack.id, wip.id] }), ORG)
    expect(dto.linkedReports.map((r) => r.id).sort()).toEqual([ack.id, wip.id].sort())
  })

  it("still rejects the PRE-publication and moderator-hidden statuses", async () => {
    const submitted = repo.seedReport({ title: "Fresh", status: "submitted" })
    const rejected = repo.seedReport({ title: "Nope", status: "rejected" })
    const hidden = repo.seedReport({ title: "Unlisted", visibility: "hidden" })
    for (const id of [R3, submitted.id, rejected.id, hidden.id]) {
      await expect(
        service.createCleanup(baseInput({ linkedReportIds: [id] }), ORG),
      ).rejects.toMatchObject({ code: "VALIDATION" })
    }
  })
})

describe("getCleanup + gallery visibility", () => {
  it("hydrates linkedReports on getCleanup but never leaks a held report", async () => {
    const created = await service.createCleanup(baseInput({ linkedReportIds: [R1, R2] }), ORG)
    repo.seedLink(created.id, R3, ORG)

    const dto = await service.getCleanup(created.id, { userId: STRANGER })
    expect(dto.linkedReports.map((r) => r.id).sort()).toEqual([R1, R2].sort())
    expect(dto.linkedReports.some((r) => r.id === R3)).toBe(false)
  })
})

describe("report service linkedEvents hydration", () => {
  it("projects the cleanup the report is linked to into ReportDTO.linkedEvents", async () => {
    const created = await service.createCleanup(
      baseInput({ title: "Linked event", linkedReportIds: [R1] }),
      ORG,
    )

    const reportRepo = new InMemoryReportRepository()
    reportRepo.seedReport({
      id: R1,
      reporterUserId: ORG,
      category: "trash",
      status: "published",
      visibility: "public",
      lat: 34,
      lng: -118.49,
    })
    const reportService: ReportService = makeReportService({
      repo: reportRepo,
      resolveJurisdictionGeoid: () => Promise.resolve(null),
      presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
      loadLinkedEventsForReports: (ids) => repo.loadLinkedEventsForReports(ids),
    })

    const dto = await reportService.getReport(R1, { userId: ORG })
    expect(dto.linkedEvents).toHaveLength(1)
    expect(dto.linkedEvents[0]!.id).toBe(created.id)
    expect(dto.linkedEvents[0]!.title).toBe("Linked event")
    expect(dto.linkedEvents[0]!.eventKind).toBe("cleanup")
    expect(dto.linkedEvents[0]!.status).toBe("upcoming")
    expect(dto.linkedEvents[0]!.organizer.id).toBe(ORG)
    expect(typeof dto.linkedEvents[0]!.linkedAt).toBe("string")
  })
})

describe("listCleanups linkedReports hydration (#70 map blend)", () => {
  it("hydrates linkedReports per page item: the linked cleanup gets its reports, others get []", async () => {
    const linked = await service.createCleanup(
      baseInput({ title: "Linked cleanup", linkedReportIds: [R1, R2] }),
      ORG,
    )
    const plain = await service.createCleanup(baseInput({ title: "Plain cleanup" }), ORG)
    const ov = await service.createCleanup(
      baseInput({ title: "Volunteer day", eventKind: "other_volunteer" }),
      ORG,
    )
    repo.seedLink(ov.id, R1, ORG)

    const { items } = await service.listCleanups({ when: "upcoming" }, { userId: null })
    const byId = new Map(items.map((c) => [c.id, c]))

    const linkedItem = byId.get(linked.id)!
    expect(linkedItem.linkedReports.map((r) => r.id).sort()).toEqual([R1, R2].sort())
    expect(linkedItem.linkedReports.find((r) => r.id === R1)!.thumbUrl).toBe("thumb/r1.jpg")

    expect(byId.get(plain.id)!.linkedReports).toEqual([])
    expect(byId.get(ov.id)!.linkedReports).toEqual([])
  })

  it("F064: the LIST gallery is capped at the preview size while the DETAIL read keeps every link", async () => {
    const extra = Array.from(
      { length: 10 },
      (_, i) => `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb${String(i).padStart(4, "0")}`,
    )
    for (const [i, id] of extra.entries()) repo.seedReport({ id, title: `Bulk ${i}`, category: "trash" })
    const linked = await service.createCleanup(
      baseInput({ title: "Big gallery", linkedReportIds: extra }),
      ORG,
    )

    const { items } = await service.listCleanups({ when: "upcoming" }, { userId: null })
    const item = items.find((c) => c.id === linked.id)!
    expect(item.linkedReports).toHaveLength(LINKED_REPORTS_LIST_PREVIEW)

    const detail = await service.getCleanup(linked.id, { userId: null })
    expect(detail.linkedReports).toHaveLength(extra.length)
  })

  it("F065: a report cannot be linked past MAX_EVENTS_PER_REPORT, and its linkedEvents read is bounded", async () => {
    for (let i = 0; i < MAX_EVENTS_PER_REPORT; i++) {
      const c = repo.seedCleanup({ organizerUserId: ORG, title: `Event ${i}` })
      repo.seedLink(c.id, R1, ORG)
    }
    await expect(
      service.createCleanup(baseInput({ title: "One too many", linkedReportIds: [R1] }), ORG),
    ).rejects.toMatchObject({ httpStatus: 422 })

    const grouped = await repo.loadLinkedEventsForReports([R1])
    expect(grouped.get(R1)).toHaveLength(LINKED_EVENTS_PER_REPORT_CAP)
  })

  it("never leaks a held report into a list item's gallery", async () => {
    const linked = await service.createCleanup(baseInput({ linkedReportIds: [R1] }), ORG)
    repo.seedLink(linked.id, R3, ORG)

    const { items } = await service.listCleanups({ when: "upcoming" }, { userId: null })
    const item = items.find((c) => c.id === linked.id)!
    expect(item.linkedReports.map((r) => r.id)).toEqual([R1])
    expect(item.linkedReports.some((r) => r.id === R3)).toBe(false)
  })
})

void AppError
