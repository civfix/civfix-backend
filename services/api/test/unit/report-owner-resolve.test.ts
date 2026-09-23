import { describe, expect, it } from "vitest"
import type { ReportStatus } from "@civfix/shared"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService } from "../../src/services/report-service.js"
import type { ReportRepository } from "../../src/services/report-types.js"
import { InMemoryReportRepository } from "../helpers/reports.js"

const REPORT_ID = "11111111-1111-1111-1111-111111111111"
const OWNER = "owner-1"

function repoWithRow(status: ReportStatus) {
  const fake = makeFakeSql([
    {
      match: /SELECT reporter_user_id, deleted_at, status, visibility/,
      rows: [{ reporter_user_id: OWNER, deleted_at: null, status, visibility: "public" }],
    },
  ])
  const repo = makeDrizzleReportRepository(fake.sql as unknown as Sql)
  const writes = () => fake.statements.filter((s) => /UPDATE reports|INSERT INTO/.test(s.sql))
  return { repo, writes }
}

const RESOLVE = { status: "resolved" as const, note: "Marked resolved by the reporter" }
const REOPEN = { status: "published" as const, note: "Reopened by the reporter" }

describe("resolveByOwner status transitions", () => {
  it("resolving an already-resolved report is unchanged and writes nothing", async () => {
    const { repo, writes } = repoWithRow("resolved")

    expect(await repo.resolveByOwner(REPORT_ID, OWNER, RESOLVE)).toBe("unchanged")
    expect(writes()).toHaveLength(0)
  })

  it("reopening a report the city is working on keeps its progress status", async () => {
    for (const status of ["in_progress", "acknowledged", "published"] as const) {
      const { repo, writes } = repoWithRow(status)

      expect(await repo.resolveByOwner(REPORT_ID, OWNER, REOPEN)).toBe("unchanged")
      expect(writes()).toHaveLength(0)
    }
  })

  it("reopening a resolved report moves it back to published", async () => {
    const { repo, writes } = repoWithRow("resolved")

    expect(await repo.resolveByOwner(REPORT_ID, OWNER, REOPEN)).toBe("updated")
    expect(writes().map((s) => s.values[0])).toEqual(["published", REPORT_ID])
  })

  it("resolving a report the city is working on still resolves it", async () => {
    const { repo, writes } = repoWithRow("in_progress")

    expect(await repo.resolveByOwner(REPORT_ID, OWNER, RESOLVE)).toBe("updated")
    expect(writes()).toHaveLength(2)
  })

  it("a pre-publication report is still an invalid state", async () => {
    const { repo, writes } = repoWithRow("held")

    expect(await repo.resolveByOwner(REPORT_ID, OWNER, RESOLVE)).toBe("invalid_state")
    expect(writes()).toHaveLength(0)
  })
})

describe("resolveReport on an unchanged status", () => {
  it("returns the report without announcing a status change in the report chat", async () => {
    const memory = new InMemoryReportRepository()
    const seeded = memory.seedReport({ reporterUserId: OWNER, status: "resolved" })
    const repo: ReportRepository = Object.assign(Object.create(memory) as ReportRepository, {
      resolveByOwner: () => Promise.resolve("unchanged" as const),
    })
    const events: unknown[] = []
    const service = makeReportService({
      repo,
      resolveJurisdictionGeoid: () => Promise.resolve(null),
      presignMedia: (r2Key: string) => Promise.resolve({ url: `memory://${r2Key}` }),
      reportChatEmitter: {
        emit: (event: unknown) => {
          events.push(event)
          return Promise.resolve()
        },
      },
    })

    const dto = await service.resolveReport(OWNER, seeded.id, true)

    expect(dto.status).toBe("resolved")
    expect(events).toHaveLength(0)
  })
})
