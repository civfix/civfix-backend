import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import { makeDrizzleCertificateRepository } from "../../src/services/certificate-repository.drizzle.js"
import type { TranscriptModel } from "../../src/services/certificate-model.js"


const pg = await withPg()

async function insertUser(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
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
   */
  it("keeps issued certificates as rows but flips their public answer to account_closed", async () => {
    const h = pg!
    const victim = await insertUser(h, "Certified Victim")
    const bystander = await insertUser(h, "Certified Bystander")
    const repo = makeDrizzleCertificateRepository(h.sql)

    const seed = async (userId: string, code: string): Promise<void> => {
      const id = randomUUID()
      await repo.insert({
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
        snapshot: { v: 1 } as unknown as TranscriptModel,
        r2Key: `certificates/service-hours/2026/02/${id}.pdf`,
        documentSha256: "b".repeat(64),
        byteSize: 40000,
        issuedAt: new Date("2026-02-02T00:00:00.000Z"),
      })
    }
    await seed(victim, "V1CT1MC0DE00")
    await seed(bystander, "BYSTANDER001")

    await new PgUserStore(h.db).softDeleteAndAnonymize(victim)

    const counted = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM service_hours_certificates WHERE user_id = ${victim}
    `
    expect(counted[0]!.count).toBe(1)

    const victimCert = await repo.findByCode("V1CT1MC0DE00")
    expect(victimCert?.holderDeleted).toBe(true)
    const bystanderCert = await repo.findByCode("BYSTANDER001")
    expect(bystanderCert?.holderDeleted).toBe(false)
  })
})
