import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { AppError } from "@civfix/shared"
import type { FastifyRequest } from "fastify"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { resolveAuthContext } from "../../src/auth/context.js"
import type { Sql } from "../../src/db/client.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CreateCleanupTxArgs } from "../../src/services/cleanup-repository.types.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "../../src/services/host/event-media.js"
import { makeDrizzleOrganizationRepository } from "../../src/services/host/organization-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { SavePageArgs } from "../../src/services/host/registration-repository.types.js"
import {
  MEDIA_CHECKS_JOB,
  makeMediaIntakeService,
} from "../../src/services/media-intake-service.js"
import { anonUploader, userUploader } from "../../src/services/media-uploader.js"
import {
  makeFakeSql,
  type FakeSqlControl,
  type RecordedStatement,
  type SqlHandler,
} from "../helpers/fake-sql.js"
import { bearer, makeAuthHarness } from "../helpers/auth.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const MEDIA_ID = "44444444-4444-4444-8444-444444444444"
const GROUP_ID = "55555555-5555-4555-8555-555555555555"
const UPLOAD_ID = "66666666-6666-4666-8666-666666666666"
const GUEST_TOKEN_ID = "77777777-7777-4777-8777-777777777777"
const MEDIA_CLAIM = /UPDATE media_assets\s+SET purpose/

function squash(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim()
}

function statementMatching(fake: FakeSqlControl, pattern: RegExp): RecordedStatement {
  const found = fake.statements.find((s) => pattern.test(s.sql))
  if (!found) throw new Error(`no statement matched ${String(pattern)}`)
  return found
}

function expectClaimsAs(claim: RecordedStatement, userId: string): void {
  const text = squash(claim.sql)
  expect(text).toContain("media_assets.uploader IN (?)")
  expect(text).toContain("OR media_assets.uploader IS NULL")
  expect(text).toContain("media_assets.created_at > now() - make_interval(secs => ?)")
  expect(claim.values).toContain(userUploader(userId))
  expect(claim.values).toContain(MEDIA_CLAIM_WINDOW_SEC)
}

function repoSql(fake: FakeSqlControl): Sql {
  return fake.sql as unknown as Sql
}

function cleanupArgs(organizerUserId: string): CreateCleanupTxArgs {
  return {
    cleanupId: randomUUID(),
    organizerUserId,
    type: "site",
    eventKind: "cleanup",
    title: "Beach cleanup",
    description: null,
    lat: 33.99,
    lng: -118.47,
    scheduledAt: new Date("2026-10-01T17:00:00.000Z"),
    status: "upcoming",
    bring: null,
    address: null,
    addressSource: null,
    jurisdictionGeoid: null,
    jurCode: 1,
    linkedReportIds: [],
    slots: [],
    host: { endsAt: new Date("2026-10-01T21:00:00.000Z"), coverMediaId: MEDIA_ID },
  }
}

describe("event media claims bind only the acting host's own uploads", () => {
  it("a new event claims its cover and gallery as the organizer", async () => {
    const organizer = randomUUID()
    const fake = makeFakeSql([{ match: /reference_counters/i, rows: [{ next_val: 1 }] }])

    await expect(
      makeDrizzleCleanupRepository(repoSql(fake)).createCleanupTx(cleanupArgs(organizer)),
    ).rejects.toMatchObject({ httpStatus: 422 })

    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), organizer)
  })

  it("an event edit claims new images as the editor, while images already on the event stay", async () => {
    const editor = randomUUID()
    const fake = makeFakeSql([{ match: /UPDATE cleanups SET/, rows: [{ id: randomUUID() }] }])

    await expect(
      makeDrizzleCleanupRepository(repoSql(fake)).updateCleanup(
        randomUUID(),
        { galleryMediaIds: [MEDIA_ID] },
        editor,
      ),
    ).rejects.toMatchObject({ httpStatus: 422 })

    const claim = statementMatching(fake, MEDIA_CLAIM)
    expectClaimsAs(claim, editor)
    expect(squash(claim.sql)).toContain(") OR (media_assets.created_at > now()")
  })
})

describe("event page media claims bind only the acting host's own uploads", () => {
  function pageArgs(actorUserId: string, over: Partial<SavePageArgs>): SavePageArgs {
    return {
      cleanupId: randomUUID(),
      actorUserId,
      slug: undefined,
      themeAccent: undefined,
      blocks: [],
      blockMediaIds: [],
      seo: undefined,
      coverMediaId: undefined,
      now: new Date(),
      ...over,
    }
  }

  it("claims block images as the saving host", async () => {
    const host = randomUUID()
    const fake = makeFakeSql([{ match: /FOR SHARE/, rows: [{ id: randomUUID() }] }])

    const outcome = await makeDrizzleHostRegistrationRepository(repoSql(fake)).savePage(
      pageArgs(host, { blockMediaIds: [MEDIA_ID] }),
    )

    expect(outcome).toEqual({ kind: "block_media_not_found" })
    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), host)
  })

  it("claims the page cover as the saving host", async () => {
    const host = randomUUID()
    const fake = makeFakeSql([{ match: /FOR SHARE/, rows: [{ id: randomUUID() }] }])

    const outcome = await makeDrizzleHostRegistrationRepository(repoSql(fake)).savePage(
      pageArgs(host, { coverMediaId: MEDIA_ID }),
    )

    expect(outcome).toEqual({ kind: "cover_not_found" })
    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), host)
  })
})

describe("organization media claims bind only the acting member's own uploads", () => {
  it("a new organization claims its logo as its creator", async () => {
    const creator = randomUUID()
    const fake = makeFakeSql([])

    await expect(
      makeDrizzleOrganizationRepository(repoSql(fake)).createOrganizationTx({
        organizationId: randomUUID(),
        slug: "tidy-org",
        name: "Tidy Org",
        description: null,
        websiteUrl: null,
        logoMediaId: MEDIA_ID,
        socialLinks: null,
        createdBy: creator,
        now: new Date(),
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      fields: { logoMediaId: "That image is unavailable." },
    })

    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), creator)
  })

  it("an organization edit claims its new logo as the editor", async () => {
    const editor = randomUUID()
    const fake = makeFakeSql([{ match: /UPDATE organizations SET/, rows: [{ id: randomUUID() }] }])

    await expect(
      makeDrizzleOrganizationRepository(repoSql(fake)).updateOrganizationTx(
        randomUUID(),
        { logoMediaId: MEDIA_ID },
        new Date(),
        editor,
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      fields: { logoMediaId: "That image is unavailable." },
    })

    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), editor)
  })

  it("a verification application claims its documents as the submitter", async () => {
    const submitter = randomUUID()
    const fake = makeFakeSql([])

    await expect(
      makeDrizzleOrganizationRepository(repoSql(fake)).applyVerificationTx({
        verificationId: randomUUID(),
        organizationId: randomUUID(),
        kind: "nonprofit",
        einNumber: null,
        documentMediaIds: [MEDIA_ID],
        note: null,
        submittedBy: submitter,
        now: new Date(),
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      fields: { documents: "One or more documents are unavailable." },
    })

    expectClaimsAs(statementMatching(fake, MEDIA_CLAIM), submitter)
  })
})

describe("finalizing an upload", () => {
  const request = {
    kind: "image" as const,
    contentType: "image/jpeg",
    byteSize: 1024,
    sha256: "a".repeat(64),
  }

  async function harness(owner: { userId?: string; anonSessionId?: string }) {
    const repo = new InMemoryMediaRepository()
    const storage = new FakeStorage()
    const jobs = new FakeJobs()
    const service = makeMediaIntakeService({ repo, storage, jobs })
    const { uploadId } = await service.createUpload(request, owner)
    const asset = (await repo.findByUploadId(uploadId))!
    await storage.put(asset.r2Key, new Uint8Array(request.byteSize), { contentType: "image/jpeg" })
    return { repo, jobs, service, uploadId, asset }
  }

  async function refusal(run: () => Promise<unknown>) {
    const err = (await run().then(
      () => null,
      (e: unknown) => e,
    )) as AppError | null
    expect(err).not.toBeNull()
    return { httpStatus: err!.httpStatus, code: err!.code, message: err!.message }
  }

  it("refuses another caller's upload exactly as it refuses an unknown one", async () => {
    const { repo, jobs, service, uploadId } = await harness({ userId: randomUUID() })

    const foreign = await refusal(() => service.finalize({ uploadId }, { userId: randomUUID() }))
    const unknown = await refusal(() =>
      service.finalize({ uploadId: randomUUID() }, { userId: randomUUID() }),
    )

    expect(foreign).toEqual(unknown)
    expect(foreign.httpStatus).toBe(404)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(0)
    expect((await repo.findByUploadId(uploadId))?.finalizedAt).toBeNull()
  })

  it("refuses a guest finalizing a signed-in user's upload, and a stranger replaying a finalized one", async () => {
    const owner = randomUUID()
    const { service, uploadId } = await harness({ userId: owner })

    await expect(service.finalize({ uploadId }, { anonSessionId: "anon-1" })).rejects.toMatchObject(
      { httpStatus: 404 },
    )
    await service.finalize({ uploadId }, { userId: owner })
    await expect(service.finalize({ uploadId }, {})).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("lets the uploader finalize and replay idempotently", async () => {
    const owner = randomUUID()
    const { jobs, service, uploadId, asset } = await harness({ userId: owner })

    const first = await service.finalize({ uploadId }, { userId: owner })
    const replay = await service.finalize({ uploadId }, { userId: owner })

    expect(first).toEqual({ mediaId: asset.id, status: "validating" })
    expect(replay).toEqual(first)
    expect(jobs.jobsFor(MEDIA_CHECKS_JOB)).toHaveLength(1)
  })

  it("accepts the guest session that uploaded, once the same browser has also signed in", async () => {
    const auth = await makeAuthHarness()
    try {
      const { token } = await auth.signIn("guest-then-member@example.org")
      const context = await resolveAuthContext({
        server: auth.app,
        headers: bearer(token),
        cookies: { civfix_anon: signAnonToken(GUEST_TOKEN_ID, auth.env.ANON_TOKEN_SIGNING_KEY) },
      } as unknown as FastifyRequest)
      const { service, uploadId } = await harness({ anonSessionId: GUEST_TOKEN_ID })

      await expect(
        service.finalize(
          { uploadId },
          {
            userId: context.userId ?? undefined,
            anonSessionId: context.anonSessionId,
            guestAnonSessionId: context.guestAnonSessionId,
          },
        ),
      ).resolves.toMatchObject({ status: "validating" })
    } finally {
      await auth.app.close()
    }
  })

  it("accepts an unattributed upload only inside the claim window", async () => {
    const fresh = await harness({ userId: randomUUID() })
    fresh.repo.patch(fresh.asset.id, { uploader: null })
    await expect(
      fresh.service.finalize({ uploadId: fresh.uploadId }, { userId: randomUUID() }),
    ).resolves.toMatchObject({ status: "validating" })

    const stale = await harness({ userId: randomUUID() })
    stale.repo.patch(stale.asset.id, {
      uploader: null,
      createdAt: new Date(Date.now() - (MEDIA_CLAIM_WINDOW_SEC + 60) * 1000),
    })
    await expect(
      stale.service.finalize({ uploadId: stale.uploadId }, { userId: randomUUID() }),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("records the uploader it later checks against", async () => {
    const { asset } = await harness({ anonSessionId: "anon-2" })

    expect(asset.uploader).toBe(anonUploader("anon-2"))
  })
})

describe("group avatar claims run in the transaction that writes the avatar", () => {
  function transactional(handlers: SqlHandler[]) {
    const fake = makeFakeSql(handlers)
    const inner = fake.sql.begin
    fake.sql.begin = async (cb) => {
      fake.statements.push({ sql: "BEGIN", values: [] })
      const out = await inner(cb)
      fake.statements.push({ sql: "COMMIT", values: [] })
      return out
    }
    return fake
  }

  const avatarRow = { id: MEDIA_ID, r2_key: "uploads/a", served_key: null }

  function expectLockedAndWrittenInOneTransaction(fake: FakeSqlControl, write: RegExp): void {
    const at = (pattern: RegExp) => fake.statements.findIndex((s) => pattern.test(s.sql))
    const begin = at(/^BEGIN$/)
    const lock = at(/FOR UPDATE OF m/)
    const written = at(write)
    const commit = at(/^COMMIT$/)
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(lock).toBeGreaterThan(begin)
    expect(written).toBeGreaterThan(lock)
    expect(commit).toBeGreaterThan(written)
  }

  it("a new group locks its avatar upload and inserts the group in the same transaction", async () => {
    const owner = randomUUID()
    const fake = transactional([
      { match: /FOR UPDATE OF m/, rows: [avatarRow] },
      { match: /INSERT INTO chat_groups/, rows: [{ id: GROUP_ID }] },
    ])

    await makeChatGroupRepository(repoSql(fake)).create(
      {
        kind: "group",
        name: "Block party",
        description: null,
        avatarUploadId: UPLOAD_ID,
        ownerId: owner,
        visibility: "private",
      },
      [],
    )

    expectLockedAndWrittenInOneTransaction(fake, /INSERT INTO chat_groups/)
    expect(statementMatching(fake, /INSERT INTO chat_groups/).values).toContain(MEDIA_ID)
    expect(statementMatching(fake, /FOR UPDATE OF m/).values).toContain(userUploader(owner))
  })

  it("an avatar change locks the upload and updates the group in the same transaction", async () => {
    const admin = randomUUID()
    const fake = transactional([{ match: /FOR UPDATE OF m/, rows: [avatarRow] }])

    await makeChatGroupRepository(repoSql(fake)).update(
      GROUP_ID,
      { avatarUploadId: UPLOAD_ID },
      admin,
    )

    expectLockedAndWrittenInOneTransaction(fake, /UPDATE chat_groups SET/)
    const lock = statementMatching(fake, /FOR UPDATE OF m/)
    expect(lock.values).toContain(userUploader(admin))
    expect(lock.values).toContain(GROUP_ID)
  })

  it("writes nothing when the avatar upload is not the caller's to claim", async () => {
    const fake = transactional([])

    await expect(
      makeChatGroupRepository(repoSql(fake)).update(
        GROUP_ID,
        { name: "Renamed", avatarUploadId: UPLOAD_ID },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      fields: { avatarUploadId: "That image is unavailable." },
    })

    expect(fake.statements.some((s) => /UPDATE chat_groups/.test(s.sql))).toBe(false)
  })
})
