import { describe, expect, it } from "vitest"
import type { AnonReportResponse } from "@civfix/shared"
import { makeDrizzleAnonReportRepository } from "../../src/services/anon-repository.drizzle.js"
import {
  ANON_REPORT_CREATE_SCOPE,
  type CreateAnonReportTxArgs,
} from "../../src/services/anon-service.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import type { Queryable, Sql } from "../../src/db/client.js"
import { mediaBoundElsewhere } from "../../src/services/media-bindings.js"
import { anonUploader } from "../../src/services/media-uploader.js"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"

const REPORT_ID = "44444444-4444-4444-8444-444444444444"
const ANON_ID = "55555555-5555-4555-8555-555555555555"
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666"
const ORIGINAL_CODE = "original-claim-code"
const FRESH_CODE = "fresh-claim-code"

const UPLOAD_ID = "77777777-7777-4777-8777-777777777777"
const UNAVAILABLE = "One or more media uploads are unavailable."

const UNIQUE_VIOLATION = Object.assign(new Error("duplicate key"), { code: "23505" })

function createArgs(): CreateAnonReportTxArgs {
  return {
    reportId: REPORT_ID,
    anonSessionId: ANON_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    lat: 34.1,
    lng: -118.3,
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
    h3Cell: "8a2830828767fff",
    mediaUploadIds: [],
    mediaUploaders: [anonUploader(ANON_ID)],
    claimCodeHash: "hash-of-original",
    reportCap: 5,
    responseSnapshot: { reportId: REPORT_ID, status: "held", claimCode: ORIGINAL_CODE },
  }
}

function repoOver(fake: FakeSqlControl) {
  return makeDrizzleAnonReportRepository(fake.sql as unknown as Sql, {
    newClaimCode: () => FRESH_CODE,
  })
}

function storedSnapshot(snapshot: object) {
  return { match: /SELECT response_snapshot/i, rows: [{ response_snapshot: snapshot }] }
}

function rotation(rows: unknown[]) {
  return { match: /UPDATE reports\s+SET claim_code_hash/i, rows }
}

describe("anonymous submit idempotency snapshot", () => {
  it("never stores the plaintext claim code", async () => {
    const fake = makeFakeSql([
      { match: /reference_counters/i, rows: [{ next_val: 1 }] },
      { match: /UPDATE anon_tokens/i, rows: [{ report_count: 1 }] },
      { match: /INSERT INTO moderation_items/i, rows: [{ id: "mod-1" }] },
    ])

    const result = await repoOver(fake).createAnonReportTx(createArgs())

    expect(result).toEqual({
      kind: "created",
      snapshot: { reportId: REPORT_ID, status: "held", claimCode: ORIGINAL_CODE },
    })
    const insert = fake.statements.find((s) => /INSERT INTO idempotency_keys/i.test(s.sql))
    expect(insert).toBeDefined()
    expect(JSON.stringify(insert!.values)).not.toContain(ORIGINAL_CODE)
    expect(JSON.stringify(insert!.values)).toContain(REPORT_ID)
  })
})

describe("replaying an anonymous submit", () => {
  it("answers with a freshly minted code and rotates the report onto it", async () => {
    const fake = makeFakeSql([
      storedSnapshot({ reportId: REPORT_ID, status: "held" }),
      rotation([{ id: REPORT_ID }]),
    ])

    const replay = await repoOver(fake).findIdempotentSnapshot(
      IDEMPOTENCY_KEY,
      ANON_REPORT_CREATE_SCOPE,
      ANON_ID,
    )

    expect(replay).toEqual<AnonReportResponse>({
      reportId: REPORT_ID,
      status: "held",
      claimCode: FRESH_CODE,
    })
    const rotate = fake.statements.find((s) => /UPDATE reports/i.test(s.sql))!
    expect(rotate.values).toContain(await sha256Hex(FRESH_CODE))
    expect(rotate.values).toContain(REPORT_ID)
    expect(rotate.values).toContain(ANON_ID)
    expect(rotate.sql).toMatch(/reporter_user_id IS NULL/i)
    expect(rotate.sql).toMatch(/claim_code_hash IS NOT NULL/i)
  })

  it("ignores a plaintext code left in a snapshot written before this change", async () => {
    const fake = makeFakeSql([
      storedSnapshot({ reportId: REPORT_ID, status: "held", claimCode: ORIGINAL_CODE }),
      rotation([{ id: REPORT_ID }]),
    ])

    const replay = await repoOver(fake).findIdempotentSnapshot(
      IDEMPOTENCY_KEY,
      ANON_REPORT_CREATE_SCOPE,
      ANON_ID,
    )

    expect(replay?.claimCode).toBe(FRESH_CODE)
  })

  it("answers a conflict instead of a dead code when the report was already claimed", async () => {
    const fake = makeFakeSql([
      storedSnapshot({ reportId: REPORT_ID, status: "held" }),
      rotation([]),
    ])

    await expect(
      repoOver(fake).findIdempotentSnapshot(IDEMPOTENCY_KEY, ANON_REPORT_CREATE_SCOPE, ANON_ID),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("returns nothing and rotates nothing when no snapshot exists", async () => {
    const fake = makeFakeSql([])

    const replay = await repoOver(fake).findIdempotentSnapshot(
      IDEMPOTENCY_KEY,
      ANON_REPORT_CREATE_SCOPE,
      ANON_ID,
    )

    expect(replay).toBeNull()
    expect(fake.statements.some((s) => /UPDATE reports/i.test(s.sql))).toBe(false)
  })

  it("replays with a fresh code when the key race is lost inside the create transaction", async () => {
    const fake = makeFakeSql([
      { match: /reference_counters/i, rows: [{ next_val: 1 }] },
      storedSnapshot({ reportId: REPORT_ID, status: "held" }),
      rotation([{ id: REPORT_ID }]),
    ])
    const sql = fake.sql as unknown as Sql & { begin: unknown }
    sql.begin = () => Promise.reject(UNIQUE_VIOLATION)

    const result = await makeDrizzleAnonReportRepository(sql, {
      newClaimCode: () => FRESH_CODE,
    }).createAnonReportTx(createArgs())

    expect(result).toEqual({
      kind: "replayed",
      snapshot: { reportId: REPORT_ID, status: "held", claimCode: FRESH_CODE },
    })
  })
})

function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim()
}

async function renderBoundElsewhere(): Promise<string> {
  const fake = makeFakeSql([])
  await fake.sql`${mediaBoundElsewhere(fake.sql as unknown as Queryable, null)}`
  return squash(fake.statements[0]?.sql ?? "")
}

describe("anonymous report create: media claim predicate", () => {
  it("only claims report-purpose media that no avatar, logo or event binds", async () => {
    const fake = makeFakeSql([
      { match: /reference_counters/i, rows: [{ next_val: 1 }] },
      { match: /UPDATE anon_tokens/i, rows: [{ report_count: 1 }] },
    ])

    await expect(
      repoOver(fake).createAnonReportTx({ ...createArgs(), mediaUploadIds: [UPLOAD_ID] }),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })

    const claim = fake.statements.find((s) => /UPDATE media_assets\s+SET report_id/.test(s.sql))
    expect(claim).toBeDefined()
    const text = squash(claim!.sql)
    expect(text).toContain("purpose = 'report'")
    expect(text).toContain(`NOT (${await renderBoundElsewhere()})`)
    expect(text).toContain("post_id IS NULL AND chat_message_id IS NULL")
    expect(text).not.toContain("--")
  })
})
