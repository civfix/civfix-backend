import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CleanupStatus } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import { makeDrizzleCertificateRepository } from "../../src/services/certificate-repository.drizzle.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"
import { insertModerationItem } from "../../src/services/admin/moderation-repository.drizzle.js"
import type { TranscriptModel } from "../../src/services/certificate-model.js"

const pg = await withPg()

async function insertUser(h: PgHarness, name: string, email?: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, email) VALUES (${name}, ${email ?? null}) RETURNING id
  `
  return rows[0]!.id
}

class SpyObjectStore {
  readonly deleted: string[] = []
  failOn: string | null = null
  delete(key: string): Promise<void> {
    if (key === this.failOn) return Promise.reject(new Error("r2 boom"))
    this.deleted.push(key)
    return Promise.resolve()
  }
}

async function insertReport(
  h: PgHarness,
  opts: { reporterId: string | null; visibility?: string; status?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell,
      jurisdiction_geoid, created_at, published_at
    )
    VALUES (
      ${opts.reporterId},
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      'trash',
      ${opts.status ?? "published"},
      ${opts.visibility ?? "public"},
      'h0',
      ${null},
      ${new Date()},
      ${null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertCleanup(
  h: PgHarness,
  opts: { organizerId: string; status?: CleanupStatus },
): Promise<string> {
  return await seedCleanup(h.sql, {
    organizerUserId: opts.organizerId,
    title: "Cleanup",
    status: opts.status,
  })
}

async function insertIdentity(
  h: PgHarness,
  opts: { name: string; handle: string; device?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle, email)
    VALUES (${opts.name}, ${opts.handle}, ${`${opts.handle}@example.test`})
    RETURNING id
  `
  const id = rows[0]!.id
  if (opts.device !== undefined) {
    await h.sql`
      INSERT INTO user_moderation (user_id, strikes, removals, last_device, updated_at)
      VALUES (${id}, 2, 1, ${opts.device}, now())
    `
  }
  return id
}

async function insertPost(
  h: PgHarness,
  opts: { authorId: string; body: string; visibility?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO posts (author_id, kind, body, visibility)
    VALUES (${opts.authorId}, 'post', ${opts.body}, ${opts.visibility ?? "public"})
    RETURNING id
  `
  return rows[0]!.id
}

async function metaOf(h: PgHarness, itemId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql<{ meta: Record<string, unknown> }[]>`
    SELECT meta FROM moderation_items WHERE id = ${itemId}
  `
  return rows[0]!.meta
}

describe.skipIf(!pg)(
  "account deletion content cascade (PgUserStore.softDeleteAndAnonymize)",
  () => {
    afterAll(async () => {
      await pg?.teardown()
    })

    it("unlists the deleted user's public reports + active events, sparing others and past events", async () => {
      const h = pg!
      const victim = await insertUser(h, "Victim")
      const bystander = await insertUser(h, "Bystander")

      const victimReport = await insertReport(h, { reporterId: victim, visibility: "public" })
      const bystanderReport = await insertReport(h, { reporterId: bystander, visibility: "public" })
      const anonReport = await insertReport(h, { reporterId: null, visibility: "public" })
      const upcoming = await insertCleanup(h, { organizerId: victim, status: "upcoming" })
      const active = await insertCleanup(h, { organizerId: victim, status: "active" })
      const past = await insertCleanup(h, { organizerId: victim, status: "done" })
      const bystanderEvent = await insertCleanup(h, { organizerId: bystander, status: "upcoming" })

      await new PgUserStore(h.db).softDeleteAndAnonymize(victim)

      const reportVis = async (id: string) =>
        (await h.sql<{ visibility: string }[]>`SELECT visibility FROM reports WHERE id = ${id}`)[0]!
          .visibility
      const cleanupStatus = async (id: string) =>
        (await h.sql<{ status: string }[]>`SELECT status FROM cleanups WHERE id = ${id}`)[0]!.status

      expect(await reportVis(victimReport)).toBe("hidden")
      expect(await cleanupStatus(upcoming)).toBe("cancelled")
      expect(await cleanupStatus(active)).toBe("cancelled")
      expect(await cleanupStatus(past)).toBe("done")
      expect(await reportVis(bystanderReport)).toBe("public")
      expect(await reportVis(anonReport)).toBe("public")
      expect(await cleanupStatus(bystanderEvent)).toBe("upcoming")

      const rows = await h.sql<
        { deleted_at: Date | null; email: string | null; display_name: string; handle: string }[]
      >`
      SELECT deleted_at, email, display_name, handle FROM users WHERE id = ${victim}
    `
      expect(rows[0]!.deleted_at).not.toBeNull()
      expect(rows[0]!.email).toBeNull()
      expect(rows[0]!.display_name).toBe("Deleted User")
      expect(rows[0]!.handle).toMatch(/^deleted_[0-9a-f]{12}$/)
    })

    it("revokes + scrubs issued certificates, keeps the verifiable facts, and drops their R2 objects", async () => {
      const h = pg!
      const victim = await insertUser(h, "Certified Victim")
      const bystander = await insertUser(h, "Certified Bystander")
      const repo = makeDrizzleCertificateRepository(h.sql)

      const seed = async (userId: string, code: string): Promise<string> => {
        const id = randomUUID()
        const row = await repo.insert({
          id,
          userId,
          code,
          locale: "en",
          holderName: "Certified",
          holderHandle: "certified",
          holderVerified: true,
          totalHours: 8,
          entryCount: 3,
          periodStart: new Date("2026-01-01T00:00:00.000Z"),
          periodEnd: new Date("2026-02-01T00:00:00.000Z"),
          ledgerFingerprint: `fp-${id}`,
          snapshot: { v: 1, holder: { displayName: "Certified" } } as unknown as TranscriptModel,
          r2Key: `certificates/service-hours/2026/02/${id}.pdf`,
          documentSha256: "b".repeat(64),
          byteSize: 40000,
          issuedAt: new Date("2026-02-02T00:00:00.000Z"),
        })
        return row.r2Key
      }
      const liveKey = await seed(victim, "V1CT1MC0DE00")
      const alreadyRevokedKey = await seed(victim, "V1CT1MOLD001")
      const holderRevokedAt = new Date("2026-03-03T00:00:00.000Z")
      await repo.revoke(victim, "V1CT1MOLD001", "holder", holderRevokedAt)
      const bystanderKey = await seed(bystander, "BYSTANDER001")

      const objects = new SpyObjectStore()
      await new PgUserStore(h.db, { certificateObjects: objects }).softDeleteAndAnonymize(victim)

      const counted = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM service_hours_certificates WHERE user_id = ${victim}
    `
      expect(counted[0]!.count).toBe(2)

      const victimRows = await h.sql<
        {
          code: string
          holder_name: string
          holder_handle: string | null
          snapshot: unknown
          revoked_at: Date | null
          revoked_reason: string | null
          document_sha256: string
          total_hours: string
          entry_count: number
          issued_at: Date
        }[]
      >`
      SELECT code, holder_name, holder_handle, snapshot, revoked_at, revoked_reason,
             document_sha256, total_hours, entry_count, issued_at
      FROM service_hours_certificates WHERE user_id = ${victim} ORDER BY code
    `
      const live = victimRows.find((r) => r.code === "V1CT1MC0DE00")!
      const old = victimRows.find((r) => r.code === "V1CT1MOLD001")!
      expect(live.revoked_at).not.toBeNull()
      expect(live.revoked_reason).toBe("account_closed")
      expect(old.revoked_reason).toBe("holder")
      expect(old.revoked_at?.toISOString()).toBe(holderRevokedAt.toISOString())

      for (const row of victimRows) {
        expect(row.holder_name).toBe("Deleted User")
        expect(row.holder_handle).toBeNull()
        expect(row.snapshot).toEqual({})
      }

      expect(live.document_sha256).toBe("b".repeat(64))
      expect(Number(live.total_hours)).toBe(8)
      expect(live.entry_count).toBe(3)
      expect(live.issued_at.toISOString()).toBe("2026-02-02T00:00:00.000Z")

      expect(objects.deleted.sort()).toEqual([liveKey, alreadyRevokedKey].sort())
      expect(objects.deleted).not.toContain(bystanderKey)

      const victimCert = await repo.findByCode("V1CT1MC0DE00")
      expect(victimCert?.holderDeleted).toBe(true)
      const bystanderCert = await repo.findByCode("BYSTANDER001")
      expect(bystanderCert?.holderDeleted).toBe(false)
      expect(bystanderCert?.holderName).toBe("Certified")
      expect(bystanderCert?.revokedAt).toBeNull()
    })

    it("a failing R2 delete does not fail the erasure (the DB scrub already committed)", async () => {
      const h = pg!
      const victim = await insertUser(h, "Unluckily Certified")
      const repo = makeDrizzleCertificateRepository(h.sql)
      const id = randomUUID()
      const r2Key = `certificates/service-hours/2026/02/${id}.pdf`
      await repo.insert({
        id,
        userId: victim,
        code: "FA1L1NGK3Y00",
        locale: "en",
        holderName: "Unluckily Certified",
        holderHandle: "unlucky",
        holderVerified: false,
        totalHours: 2,
        entryCount: 1,
        periodStart: null,
        periodEnd: null,
        ledgerFingerprint: `fp-${id}`,
        snapshot: { v: 1 } as unknown as TranscriptModel,
        r2Key,
        documentSha256: "c".repeat(64),
        byteSize: 1000,
        issuedAt: new Date("2026-02-02T00:00:00.000Z"),
      })

      const objects = new SpyObjectStore()
      objects.failOn = r2Key
      const warnings: unknown[] = []
      await expect(
        new PgUserStore(h.db, {
          certificateObjects: objects,
          logger: { warn: (obj: unknown) => warnings.push(obj) },
        }).softDeleteAndAnonymize(victim),
      ).resolves.toMatchObject({ id: victim })

      expect(warnings).toHaveLength(1)
      const row = await repo.findByCode("FA1L1NGK3Y00")
      expect(row?.revokedReason).toBe("account_closed")
      expect(row?.holderName).toBe("Deleted User")
    })

    it("includes the certificates in the data export, without the snapshot or the object key", async () => {
      const h = pg!
      const email = `dsar-${randomUUID()}@example.test`
      const holder = await insertUser(h, "Exporting Holder", email)
      const repo = makeDrizzleCertificateRepository(h.sql)
      const id = randomUUID()
      await repo.insert({
        id,
        userId: holder,
        code: "3XP0RTC0DE00",
        locale: "en",
        holderName: "Exporting Holder",
        holderHandle: "exporter",
        holderVerified: true,
        totalHours: 12.5,
        entryCount: 4,
        periodStart: new Date("2026-01-01T00:00:00.000Z"),
        periodEnd: new Date("2026-02-01T00:00:00.000Z"),
        ledgerFingerprint: `fp-${id}`,
        snapshot: { v: 1, secret: "itinerary" } as unknown as TranscriptModel,
        r2Key: `certificates/service-hours/2026/02/${id}.pdf`,
        documentSha256: "d".repeat(64),
        byteSize: 2048,
        issuedAt: new Date("2026-02-02T00:00:00.000Z"),
      })

      const mailer = new FakeMailer()
      const service = makeDataExportService({
        sql: h.sql,
        mailer,
        users: new PgUserStore(h.db),
        fromNoReply: "no-reply@civfix.org",
        supportEmail: "support@civfix.org",
      })
      const result = await service.exportData(holder)
      expect(result).toEqual({ ok: true, email })

      const attachment = mailer.lastOutbound()!.attachments![0]!
      const parsed = JSON.parse(new TextDecoder().decode(attachment.content)) as {
        certificates: Array<Record<string, unknown>>
      }
      expect(parsed.certificates).toHaveLength(1)
      const cert = parsed.certificates[0]!
      expect(cert.code).toBe("3XP0RTC0DE00")
      expect(cert.holder_name).toBe("Exporting Holder")
      expect(cert.total_hours).toBe(12.5)
      expect(cert.entry_count).toBe(4)
      expect(cert.document_sha256).toBe("d".repeat(64))
      expect(cert.revoked_at).toBeNull()
      expect("snapshot" in cert).toBe(false)
      expect("r2_key" in cert).toBe(false)
    })

    it("scrubs the frozen identity snapshot moderation items froze, sparing other subjects", async () => {
      const h = pg!
      const victim = await insertIdentity(h, {
        name: "Jane Q. Smith",
        handle: `jqsmith${Date.now().toString(36)}`,
        device: "iPhone 15 Pro / iOS 18.2",
      })
      const bystander = await insertIdentity(h, {
        name: "Neighborly Nate",
        handle: `nate${Date.now().toString(36)}`,
        device: "Pixel 8 / Android 15",
      })

      const aboutVictim = await insertModerationItem(h.sql, {
        kind: "pattern",
        subjectType: "user",
        subjectId: victim,
        reporter: "Neighborly Nate",
        reporterUserId: bystander,
        desc: "keeps posting the same pin",
      })
      const bystanderReport = await insertReport(h, { reporterId: bystander })
      const filedByVictim = await insertModerationItem(h.sql, {
        kind: "image",
        subjectType: "report",
        subjectId: bystanderReport,
        reporter: "Jane Q. Smith",
        reporterUserId: victim,
        desc: "my neighbour at 12 Elm St dumped this",
      })
      const unrelated = await insertModerationItem(h.sql, {
        kind: "pattern",
        subjectType: "user",
        subjectId: bystander,
        reporter: "Anonymous",
        desc: "unrelated",
      })
      const unrelatedBefore = await metaOf(h, unrelated)

      await new PgUserStore(h.db).softDeleteAndAnonymize(victim)

      const scrubbed = await metaOf(h, aboutVictim)
      const scrubbedUser = scrubbed.user as Record<string, unknown>
      expect(scrubbedUser.id).toBe(victim)
      expect(scrubbedUser.name).toBe("Deleted User")
      expect(scrubbedUser.handle).toBe("")
      expect(scrubbedUser.device).toBe("")
      expect(scrubbedUser.joined).toBe("")
      expect(scrubbedUser.strikes).toBe(2)
      expect(scrubbed.reporter).toBe("Neighborly Nate")

      const asReporter = await metaOf(h, filedByVictim)
      expect(asReporter.reporter).toBe("Deleted User")
      expect(asReporter.desc).toBe("")
      expect((asReporter.user as Record<string, unknown>).name).toBe("Neighborly Nate")

      expect(await metaOf(h, unrelated)).toEqual(unrelatedBefore)
    })

    it("unlists the deleted user's public posts, leaving other authors' posts in the feed", async () => {
      const h = pg!
      const victim = await insertUser(h, "Posting Victim")
      const bystander = await insertUser(h, "Posting Bystander")
      const victimPublic = await insertPost(h, { authorId: victim, body: "public post" })
      const victimAlreadyHidden = await insertPost(h, {
        authorId: victim,
        body: "already hidden",
        visibility: "hidden",
      })
      const bystanderPublic = await insertPost(h, { authorId: bystander, body: "bystander post" })

      await new PgUserStore(h.db).softDeleteAndAnonymize(victim)

      const visibilityOf = async (id: string) =>
        (await h.sql<{ visibility: string }[]>`SELECT visibility FROM posts WHERE id = ${id}`)[0]!
          .visibility
      expect(await visibilityOf(victimPublic)).toBe("hidden")
      expect(await visibilityOf(victimAlreadyHidden)).toBe("hidden")
      expect(await visibilityOf(bystanderPublic)).toBe("public")
    })
  },
)
