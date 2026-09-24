import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { ReportDTO } from "@civfix/shared"
import type { Queryable, Sql } from "../../src/db/client.js"
import { makeDrizzleAnonReportRepository } from "../../src/services/anon-repository.drizzle.js"
import type { CreateAnonReportTxArgs } from "../../src/services/anon-service.js"
import { attachChatMedia } from "../../src/services/chat-attachments.drizzle.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "../../src/services/host/event-media.js"
import { claimableAsReportMedia } from "../../src/services/media-bindings.js"
import { avatarClaimQuery } from "../../src/services/media-claim-repository.drizzle.js"
import {
  makeMediaIntakeService,
  type NewMediaAsset,
} from "../../src/services/media-intake-service.js"
import {
  UNSESSIONED_UPLOADER,
  anonUploader,
  userUploader,
} from "../../src/services/media-uploader.js"
import { makeDrizzlePostRepository } from "../../src/services/post-repository.drizzle.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import type { CreateReportTxArgs } from "../../src/services/report-service.types.js"
import { makeFakeSql, type FakeSqlControl, type RecordedStatement } from "../helpers/fake-sql.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const UPLOAD_ID = "44444444-4444-4444-8444-444444444444"
const UNAVAILABLE = "One or more media uploads are unavailable."

function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim()
}

function statementMatching(fake: FakeSqlControl, pattern: RegExp): RecordedStatement {
  const found = fake.statements.find((s) => pattern.test(s.sql))
  if (!found) throw new Error(`no statement matched ${String(pattern)}`)
  return found
}

function expectLockedBeforeClaim(fake: FakeSqlControl, claim: RegExp): void {
  const lockAt = fake.statements.findIndex(
    (s) => /FROM media_assets/.test(s.sql) && /FOR UPDATE/.test(s.sql),
  )
  const claimAt = fake.statements.findIndex((s) => claim.test(s.sql))
  expect(lockAt).toBeGreaterThanOrEqual(0)
  expect(claimAt).toBeGreaterThan(lockAt)
}

class CapturingMediaRepository extends InMemoryMediaRepository {
  readonly inserted: NewMediaAsset[] = []

  override insert(row: NewMediaAsset): Promise<void> {
    this.inserted.push(row)
    return super.insert(row)
  }
}

describe("createUpload records who uploaded", () => {
  const request = {
    kind: "image" as const,
    contentType: "image/jpeg",
    byteSize: 1024,
    sha256: "a".repeat(64),
  }

  function service(repo: CapturingMediaRepository) {
    return makeMediaIntakeService({ repo, storage: new FakeStorage(), jobs: new FakeJobs() })
  }

  it("stores the signed-in account, over any anon session it also carries", async () => {
    const repo = new CapturingMediaRepository()
    const userId = randomUUID()

    await service(repo).createUpload(request, { userId, anonSessionId: "anon-1" })

    expect(repo.inserted[0]?.uploader).toBe(userUploader(userId))
  })

  it("stores the signed anon session for a guest", async () => {
    const repo = new CapturingMediaRepository()

    await service(repo).createUpload(request, { anonSessionId: "anon-1", ipKey: "1.2.3.4" })

    expect(repo.inserted[0]?.uploader).toBe(anonUploader("anon-1"))
  })

  it("stores the unsessioned marker, never an IP, for a caller with no session at all", async () => {
    const repo = new CapturingMediaRepository()

    await service(repo).createUpload(request, { ipKey: "1.2.3.4" })

    expect(repo.inserted[0]?.uploader).toBe(UNSESSIONED_UPLOADER)
  })
})

describe("claimableAsReportMedia", () => {
  it("requires the caller's upload, or an unattributed one, inside the claim window", async () => {
    const fake = makeFakeSql([])
    const uploader = userUploader(randomUUID())

    await fake.sql`${claimableAsReportMedia(fake.sql as unknown as Queryable, [uploader])}`

    const statement = fake.statements[0]!
    const text = squash(statement.sql)
    expect(text).toContain("media_assets.uploader IN (?)")
    expect(text).toContain("OR media_assets.uploader IS NULL")
    expect(text).toContain("media_assets.created_at > now() - make_interval(secs => ?)")
    expect(statement.values).toContain(uploader)
    expect(statement.values).toContain(MEDIA_CLAIM_WINDOW_SEC)
  })
})

function reportArgs(reporterUserId: string): CreateReportTxArgs {
  const reportId = randomUUID()
  return {
    reportId,
    reporterUserId,
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
    mediaUploadIds: [UPLOAD_ID],
    timelineNote: null,
    idempotency: { key: randomUUID(), scope: "report_create", userOrAnon: null },
    buildSnapshot: () => Promise.resolve({ id: reportId } as unknown as ReportDTO),
  }
}

function anonArgs(mediaUploaders: string[]): CreateAnonReportTxArgs {
  const reportId = randomUUID()
  return {
    reportId,
    anonSessionId: "anon-token",
    idempotencyKey: randomUUID(),
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
    mediaUploadIds: [UPLOAD_ID],
    mediaUploaders,
    claimCodeHash: "hash",
    reportCap: 5,
    responseSnapshot: { reportId, status: "held", claimCode: "code" },
  }
}

const REPORT_CLAIM = /UPDATE media_assets\s+SET report_id/
const POST_CLAIM = /UPDATE media_assets\s+SET post_id/
const CHAT_CLAIM = /UPDATE media_assets\s+SET "?chat_message_id/

describe("every uploadId claim binds only the caller's own upload", () => {
  it("an authenticated report claims as its reporter, after locking the rows", async () => {
    const reporter = randomUUID()
    const fake = makeFakeSql([{ match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] }])

    await expect(
      makeDrizzleReportRepository(fake.sql as unknown as Sql).createReportTx(reportArgs(reporter)),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })

    const claim = statementMatching(fake, REPORT_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?)")
    expect(claim.values).toContain(userUploader(reporter))
    expectLockedBeforeClaim(fake, REPORT_CLAIM)
  })

  it("an anonymous report claims as the anon subjects the service resolved", async () => {
    const fake = makeFakeSql([
      { match: /reference_counters/i, rows: [{ next_val: 1 }] },
      { match: /UPDATE anon_tokens/i, rows: [{ report_count: 1 }] },
    ])
    const uploaders = [anonUploader("anon-token"), UNSESSIONED_UPLOADER]

    await expect(
      makeDrizzleAnonReportRepository(fake.sql as unknown as Sql).createAnonReportTx(
        anonArgs(uploaders),
      ),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })

    const claim = statementMatching(fake, REPORT_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?,?)")
    expect(claim.values).toEqual(expect.arrayContaining(uploaders))
    expectLockedBeforeClaim(fake, REPORT_CLAIM)
  })

  it("a post claims as its author", async () => {
    const author = randomUUID()
    const fake = makeFakeSql([{ match: /INSERT INTO posts/, rows: [{ id: randomUUID() }] }])
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })

    await expect(
      repo.createPost({
        authorId: author,
        kind: "post",
        body: "hello",
        replyToId: null,
        repostOfId: null,
        eventId: null,
        reportId: null,
        mediaUploadIds: [UPLOAD_ID],
        mentionedUserIds: [],
        organizationId: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })

    const claim = statementMatching(fake, POST_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?)")
    expect(claim.values).toContain(userUploader(author))
    expectLockedBeforeClaim(fake, POST_CLAIM)
  })

  it("a signed-in report also claims the uploads its browser made as a guest", async () => {
    const reporter = randomUUID()
    const fake = makeFakeSql([{ match: /INSERT INTO reference_counters/, rows: [{ next_val: 1 }] }])

    await expect(
      makeDrizzleReportRepository(fake.sql as unknown as Sql).createReportTx({
        ...reportArgs(reporter),
        guestAnonSessionId: "guest-token",
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })

    const claim = statementMatching(fake, REPORT_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?,?)")
    expect(claim.values).toEqual(
      expect.arrayContaining([userUploader(reporter), anonUploader("guest-token")]),
    )
    expect(claim.values).not.toContain(UNSESSIONED_UPLOADER)
  })

  it("a signed-in post also claims the uploads its browser made as a guest", async () => {
    const author = randomUUID()
    const fake = makeFakeSql([{ match: /INSERT INTO posts/, rows: [{ id: randomUUID() }] }])
    const repo = makeDrizzlePostRepository(fake.sql as unknown as Sql, {
      presignMedia: () => Promise.resolve({ url: "u" }),
      presignAvatar: () => Promise.resolve("a"),
    })

    await expect(
      repo.createPost({
        authorId: author,
        guestAnonSessionId: "guest-token",
        kind: "post",
        body: "hello",
        replyToId: null,
        repostOfId: null,
        eventId: null,
        reportId: null,
        mediaUploadIds: [UPLOAD_ID],
        mentionedUserIds: [],
        organizationId: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 422 })

    const claim = statementMatching(fake, POST_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?,?)")
    expect(claim.values).toEqual(
      expect.arrayContaining([userUploader(author), anonUploader("guest-token")]),
    )
    expect(claim.values).not.toContain(UNSESSIONED_UPLOADER)
  })

  it("a chat or DM attachment claims as its sender", async () => {
    const sender = randomUUID()
    const fake = makeFakeSql([{ match: CHAT_CLAIM, rows: [{ upload_id: UPLOAD_ID }] }])

    await attachChatMedia(
      fake.sql as unknown as Queryable,
      randomUUID(),
      [UPLOAD_ID],
      new Date(),
      sender,
    )

    const claim = statementMatching(fake, CHAT_CLAIM)
    expect(squash(claim.sql)).toContain("media_assets.uploader IN (?)")
    expect(claim.values).toContain(userUploader(sender))
    expectLockedBeforeClaim(fake, CHAT_CLAIM)
  })
})

describe("chat attach refuses uploads it could not claim", () => {
  it("fails the send instead of dropping an unclaimable upload", async () => {
    const fake = makeFakeSql([{ match: CHAT_CLAIM, rows: [{ upload_id: UPLOAD_ID }] }])

    await expect(
      attachChatMedia(
        fake.sql as unknown as Queryable,
        randomUUID(),
        [UPLOAD_ID, randomUUID()],
        new Date(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: UNAVAILABLE },
    })
  })

  it("counts a repeated uploadId once", async () => {
    const fake = makeFakeSql([{ match: CHAT_CLAIM, rows: [{ upload_id: UPLOAD_ID }] }])

    await expect(
      attachChatMedia(
        fake.sql as unknown as Queryable,
        randomUUID(),
        [UPLOAD_ID, UPLOAD_ID],
        new Date(),
        randomUUID(),
      ),
    ).resolves.toBeUndefined()
  })
})

describe("avatar claim", () => {
  it("locks the media row it selects and requires the claimant's own upload", async () => {
    const fake = makeFakeSql([])
    const userId = randomUUID()

    await avatarClaimQuery(fake.sql, UPLOAD_ID, { uploader: userUploader(userId), userId })

    const statement = fake.statements[0]!
    const text = squash(statement.sql)
    expect(text).toMatch(/FOR UPDATE OF m$/)
    expect(text).toContain("(m.uploader = ? OR m.uploader IS NULL)")
    expect(statement.values).toContain(userUploader(userId))
  })
})
