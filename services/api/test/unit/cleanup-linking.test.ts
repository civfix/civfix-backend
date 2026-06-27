import { describe, it, expect, beforeEach } from "vitest"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryReportRepository } from "../helpers/reports.js"
import { AppError, type CreateCleanupRequest } from "@civfix/shared"

/**
 * Unit tests for the event<->report linking feature over the in-memory repos (no DB, no Docker):
 *   - createCleanup links the seeded reports (junction + 'report_linked' timeline) and hydrates the gallery;
 *   - PATCH updateCleanup is HOST-GATED (403 for a non-organizer) and reconciles links (add + remove);
 *   - linking is rejected on a non-cleanup eventKind (create AND update);
 *   - the gallery only shows published+public reports (held/hidden/deleted never leak);
 *   - the report service hydrates linkedEvents from the cleanup repo's batched loader.
 */

const ORG = "11111111-1111-1111-1111-111111111111"
const STRANGER = "22222222-2222-2222-2222-222222222222"
const R1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
const R2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"
const R3 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3"

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
  }
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  // Two visible reports + one held one (must never leak into the gallery / be linkable).
  repo.seedReport({ id: R1, title: "Bin 1", category: "trash", thumbKey: "thumb/r1.jpg" })
  repo.seedReport({ id: R2, title: "Graffiti", category: "graffiti" })
  repo.seedReport({ id: R3, title: "Held one", status: "held" })
  service = makeCleanupService({ repo })
})

describe("createCleanup linking", () => {
  it("links the seeded reports + writes a report_linked timeline row + hydrates the gallery", async () => {
    const dto = await service.createCleanup(baseInput({ linkedReportIds: [R1, R2] }), ORG)

    expect(dto.eventKind).toBe("cleanup")
    expect(dto.linkedReports.map((r) => r.id).sort()).toEqual([R1, R2].sort())
    // The thumb key is presigned via the identity pass-through default.
    const r1 = dto.linkedReports.find((r) => r.id === R1)!
    expect(r1.thumbUrl).toBe("thumb/r1.jpg")
    expect(r1.title).toBe("Bin 1")
    // Junction rows + a report_linked timeline row per link.
    expect(repo.links.filter((l) => l.cleanupId === dto.id)).toHaveLength(2)
    expect(repo.timeline.filter((t) => t.cleanupId === dto.id && t.kind === "report_linked")).toHaveLength(2)
  })

  it("rejects an invisible (held) report at create time with a 422", async () => {
    await expect(service.createCleanup(baseInput({ linkedReportIds: [R1, R3] }), ORG)).rejects.toMatchObject(
      { code: "VALIDATION" },
    )
    // Nothing was created/linked (the validation runs before the create tx).
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
    // The title was not changed.
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
    // Desired set drops R1, adds R2.
    const updated = await service.updateCleanup(created.id, { linkedReportIds: [R2] }, ORG)
    expect(updated.linkedReports.map((r) => r.id)).toEqual([R2])
    expect(repo.links.filter((l) => l.cleanupId === created.id).map((l) => l.reportId)).toEqual([R2])
    // A report_linked (R1 then R2) + a report_unlinked (R1) row exist.
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

describe("getCleanup + gallery visibility", () => {
  it("hydrates linkedReports on getCleanup but never leaks a held report", async () => {
    const created = await service.createCleanup(baseInput({ linkedReportIds: [R1, R2] }), ORG)
    // Seed a link to the held report directly (bypassing the visibility gate) - it must still be hidden.
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

    // A report service wired to the SAME cleanup repo's batched loader.
    const reportRepo = new InMemoryReportRepository()
    // Seed the report row the report service reads (matching the cleanup repo's R1 visibility).
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
    // The cleanup's real lifecycle status flows through (a freshly created cleanup is "upcoming").
    expect(dto.linkedEvents[0]!.status).toBe("upcoming")
    expect(dto.linkedEvents[0]!.organizer.id).toBe(ORG)
    expect(typeof dto.linkedEvents[0]!.linkedAt).toBe("string")
  })
})

describe("listCleanups linkedReports hydration (#70 map blend)", () => {
  it("hydrates linkedReports per page item: the linked cleanup gets its reports, others get []", async () => {
    // A cleanup linked to two visible reports, a plain cleanup with no links, and a non-cleanup event.
    const linked = await service.createCleanup(
      baseInput({ title: "Linked cleanup", linkedReportIds: [R1, R2] }),
      ORG,
    )
    const plain = await service.createCleanup(baseInput({ title: "Plain cleanup" }), ORG)
    const ov = await service.createCleanup(
      baseInput({ title: "Volunteer day", eventKind: "other_volunteer" }),
      ORG,
    )
    // Force a link onto the non-cleanup event (bypassing the create-time cleanup-only gate) to prove the
    // eventKind filter in hydrateLinkedReportsForMany still returns [] for it.
    repo.seedLink(ov.id, R1, ORG)

    const { items } = await service.listCleanups({ when: "upcoming" }, { userId: null })
    const byId = new Map(items.map((c) => [c.id, c]))

    // The linked cleanup carries its gallery (presigned thumb via the identity pass-through default).
    const linkedItem = byId.get(linked.id)!
    expect(linkedItem.linkedReports.map((r) => r.id).sort()).toEqual([R1, R2].sort())
    expect(linkedItem.linkedReports.find((r) => r.id === R1)!.thumbUrl).toBe("thumb/r1.jpg")

    // Regroup correctness: a report linked to one cleanup never leaks into another's gallery.
    expect(byId.get(plain.id)!.linkedReports).toEqual([])
    // eventKind filter: a non-cleanup event carries no links even when one is seeded directly.
    expect(byId.get(ov.id)!.linkedReports).toEqual([])
  })

  it("never leaks a held report into a list item's gallery", async () => {
    const linked = await service.createCleanup(baseInput({ linkedReportIds: [R1] }), ORG)
    // Seed a link to the held report directly (bypassing the visibility gate) - it must stay hidden in the list.
    repo.seedLink(linked.id, R3, ORG)

    const { items } = await service.listCleanups({ when: "upcoming" }, { userId: null })
    const item = items.find((c) => c.id === linked.id)!
    expect(item.linkedReports.map((r) => r.id)).toEqual([R1])
    expect(item.linkedReports.some((r) => r.id === R3)).toBe(false)
  })
})

// Touch AppError so the import is meaningful even if a future refactor drops a direct reference.
void AppError
