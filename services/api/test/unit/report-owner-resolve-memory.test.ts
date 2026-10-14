import { describe, expect, it } from "vitest"
import { InMemoryReportRepository } from "../helpers/reports.js"

const OWNER = "owner-1"
const RESOLVE = { status: "resolved" as const, note: "Marked resolved by the reporter" }
const REOPEN = { status: "published" as const, note: "Reopened by the reporter" }

describe("InMemoryReportRepository.resolveByOwner mirrors the database transitions", () => {
  it("resolving an already-resolved report is unchanged and writes no timeline row", async () => {
    const repo = new InMemoryReportRepository()
    const report = repo.seedReport({ reporterUserId: OWNER, status: "resolved" })

    expect(await repo.resolveByOwner(report.id, OWNER, RESOLVE)).toBe("unchanged")
    expect(repo.reports.get(report.id)!.status).toBe("resolved")
    expect(repo.timeline).toHaveLength(0)
  })

  it("reopening a report that is not resolved keeps the city's progress status", async () => {
    for (const status of ["in_progress", "acknowledged", "published"] as const) {
      const repo = new InMemoryReportRepository()
      const report = repo.seedReport({ reporterUserId: OWNER, status })

      expect(await repo.resolveByOwner(report.id, OWNER, REOPEN)).toBe("unchanged")
      expect(repo.reports.get(report.id)!.status).toBe(status)
      expect(repo.timeline).toHaveLength(0)
    }
  })

  it("still applies a real toggle and records it on the timeline", async () => {
    const repo = new InMemoryReportRepository()
    const report = repo.seedReport({ reporterUserId: OWNER, status: "in_progress" })

    expect(await repo.resolveByOwner(report.id, OWNER, RESOLVE)).toBe("updated")
    expect(await repo.resolveByOwner(report.id, OWNER, REOPEN)).toBe("updated")
    expect(repo.reports.get(report.id)!.status).toBe("published")
    expect(repo.timeline.map((t) => t.status)).toEqual(["resolved", "published"])
  })

  it("a pre-publication report is still an invalid state", async () => {
    const repo = new InMemoryReportRepository()
    const report = repo.seedReport({ reporterUserId: OWNER, status: "held" })

    expect(await repo.resolveByOwner(report.id, OWNER, RESOLVE)).toBe("invalid_state")
    expect(repo.timeline).toHaveLength(0)
  })
})
