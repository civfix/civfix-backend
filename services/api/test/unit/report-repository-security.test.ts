import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ReportDTO } from "@civfix/shared"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import type { Queryable, Sql } from "../../src/db/client.js"
import { mediaBoundElsewhere } from "../../src/services/media-bindings.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import type { CreateReportTxArgs } from "../../src/services/report-service.types.js"

const UNAVAILABLE = "One or more media uploads are unavailable."

function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim()
}

async function renderFragment(build: (tag: Queryable) => unknown): Promise<string> {
  const fake = makeFakeSql([])
  await fake.sql`${build(fake.sql as unknown as Queryable)}`
  return squash(fake.statements[0]?.sql ?? "")
}

function createArgs(mediaUploadIds: string[]): CreateReportTxArgs {
  const reportId = randomUUID()
  return {
    reportId,
    reporterUserId: randomUUID(),
    idempotencyKey: randomUUID(),
    lat: 34.05,
    lng: -118.25,
    geomSource: "device",
    jurisdictionGeoid: null,
    jurCode: 0,
    category: "trash",
    type: "dump",
    title: null,
    description: null,
    addr: null,
    addrSource: null,
    addrPrecision: null,
    status: "published",
    visibility: "public",
    h3Cell: "h0",
    publishedAt: new Date(),
    mediaUploadIds,
    timelineNote: null,
    idempotency: { key: randomUUID(), scope: "report_create", userOrAnon: null },
    buildSnapshot: () => Promise.resolve({ id: reportId } as unknown as ReportDTO),
  }
}

function claimStatement(fake: FakeSqlControl): string {
  const claim = fake.statements.find((s) => /UPDATE media_assets\s+SET report_id/.test(s.sql))
  if (!claim) throw new Error("no media claim statement was sent")
  return squash(claim.sql)
}

describe("authenticated report create: media claim predicate", () => {
  it("only claims report-purpose media that no avatar, logo or event binds", async () => {
    const fake = makeFakeSql([{ match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] }])
    const repo = makeDrizzleReportRepository(fake.sql as unknown as Sql)

    await expect(repo.createReportTx(createArgs([randomUUID()]))).rejects.toMatchObject({
      httpStatus: 422,
      fields: { mediaUploadIds: UNAVAILABLE },
    })

    const claim = claimStatement(fake)
    const boundElsewhere = await renderFragment((tag) => mediaBoundElsewhere(tag, null))
    expect(claim).toContain("purpose = 'report'")
    expect(claim).toContain(`NOT (${boundElsewhere})`)
    expect(claim).toContain("post_id IS NULL AND chat_message_id IS NULL")
  })

  it("keeps the claim when every requested upload is claimable", async () => {
    const uploadIds = [randomUUID(), randomUUID()]
    const fake = makeFakeSql([
      { match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] },
      {
        match: /UPDATE media_assets\s+SET report_id/,
        rows: uploadIds.map((upload_id) => ({ upload_id })),
      },
      {
        match: /FROM reports WHERE id =/,
        rows: [
          {
            id: randomUUID(),
            lng: -118.25,
            lat: 34.05,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
    ])
    const repo = makeDrizzleReportRepository(fake.sql as unknown as Sql)

    const result = await repo.createReportTx(createArgs(uploadIds))

    expect(result.kind).toBe("created")
    expect(claimStatement(fake)).toContain("purpose = 'report'")
  })
})
