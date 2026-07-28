import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeMailer } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import { makeDrizzleCertificateRepository } from "../../src/services/certificate-repository.drizzle.js"
import { makeDataExportService } from "../../src/services/data-export-service.js"
import type { TranscriptModel } from "../../src/services/certificate-model.js"


const pg = await withPg()

async function insertUser(h: PgHarness, name: string, email?: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, email) VALUES (${name}, ${email ?? null}) RETURNING id
  `
  return rows[0]!.id
}

/** Captures the best-effort R2 deletes account erasure fires after the transaction commits. */
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
  opts: { organizerId: string; status?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
    VALUES (
      ${opts.organizerId},
      'site',
      'Cleanup',
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      ${new Date()},
      ${opts.status ?? "upcoming"}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("account deletion content cascade (PgUserStore.softDeleteAndAnonymize)", () => {
  // Release this file's pools + drop its database (the shared container itself is globalSetup's).
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
      (await h.sql<{ visibility: string }[]>`SELECT visibility FROM reports WHERE id = ${id}`)[0]!.visibility
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
    expect(rows[0]!.handle).toMatch(/^user[0-9a-f]{12}$/)
  })

  /**
   * `service_hours_certificates` has NO `ON DELETE CASCADE` to users, deliberately: account deletion in
   * this product is a soft tombstone (docs/erasure-behavior.md), so the row must survive and keep
   * answering the public verify lookup. What changes is the ANSWER — a registrar holding the paper is
   * told the account was closed rather than being told the code does not exist, and the holder's name is
   * no longer echoed back out of a record they asked to erase.
   *
   * This table is the ONLY place in the product that keeps a frozen copy of the holder's legal name plus
   * an itemised record of where they physically were and when (`snapshot`), and the rendered PDF in R2
   * prints all of it. Scrubbing `users.display_name` does not reach any of that, so erasure has to.
   */
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
    // A certificate the holder had ALREADY revoked themselves: its reason and timestamp must survive the
    // COALESCE, and its PII must be scrubbed all the same.
    const alreadyRevokedKey = await seed(victim, "V1CT1MOLD001")
    const holderRevokedAt = new Date("2026-03-03T00:00:00.000Z")
    await repo.revoke(victim, "V1CT1MOLD001", "holder", holderRevokedAt)
    const bystanderKey = await seed(bystander, "BYSTANDER001")

    const objects = new SpyObjectStore()
    await new PgUserStore(h.db, { certificateObjects: objects }).softDeleteAndAnonymize(victim)

    // 1. The ROWS survive: revocation, not deletion, is the erasure primitive here (0064's banner).
    const counted = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM service_hours_certificates WHERE user_id = ${victim}
    `
    expect(counted[0]!.count).toBe(2)

    // 2. Every one of them is REVOKED, with the reason the verify projection already synthesises.
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
    // COALESCE: the holder's own earlier revocation is not overwritten or re-dated.
    expect(old.revoked_reason).toBe("holder")
    expect(old.revoked_at?.toISOString()).toBe(holderRevokedAt.toISOString())

    // 3. Every identity column is BLANKED — including on the already-revoked row.
    for (const row of victimRows) {
      expect(row.holder_name).toBe("Deleted User")
      expect(row.holder_handle).toBeNull()
      expect(row.snapshot).toEqual({})
    }

    // 4. ...but the facts `verify` needs to keep answering "issued, then revoked" are KEPT.
    expect(live.document_sha256).toBe("b".repeat(64))
    expect(Number(live.total_hours)).toBe(8)
    expect(live.entry_count).toBe(3)
    expect(live.issued_at.toISOString()).toBe("2026-02-02T00:00:00.000Z")

    // 5. The rendered PDFs — which print the erased name — are deleted from R2, best effort, and only
    //    the victim's.
    expect(objects.deleted.sort()).toEqual([liveKey, alreadyRevokedKey].sort())
    expect(objects.deleted).not.toContain(bystanderKey)

    // 6. The public answer: tombstoned holder, and a bystander's document is untouched.
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

  /**
   * DSAR: the certificate rows are personal data twice over (a frozen name + an itinerary), so the
   * export has to carry them — and it must do so BEFORE deletion, which is the only time the holder can
   * still request one (erasure nulls the email the export is sent to).
   */
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
    // The ~200 KB TOASTed model and the internal object key stay out of an emailed attachment.
    expect("snapshot" in cert).toBe(false)
    expect("r2_key" in cert).toBe(false)
  })
})
