/**
 * Service-hours certificates against a live Postgres (Docker-gated).
 *
 * The unit suite runs the routes against the in-memory twin, which cannot exercise the two things that
 * actually make this feature safe:
 *
 *   1. The PARTIAL unique index `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL`. Two taps on
 *      "Prepare transcript" race with no lock and no advisory serialization: exactly ONE row must
 *      survive, the loser must recover by re-reading the winner, and both callers must see one document
 *      with one code. A twin that checks a Map in a single-threaded loop proves nothing about that.
 *   2. The PARTIAL-ness itself — revoking must FREE the slot so the holder can re-issue over the same
 *      ledger and get a NEW code.
 *
 * Plus the TOAST rule (a source grep for `SELECT *`, per DP §4.5/§8.8) and the tombstoned-holder
 * projection, which needs a real `users.deleted_at`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CERTIFICATE_CODE_RE } from "@civfix/shared"
import { FakeStorage } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { makeDrizzleCertificateRepository } from "../../src/services/certificate-repository.drizzle.js"
import {
  makeCertificateService,
  type CertificateService,
} from "../../src/services/certificate-service.js"

const GEOID = LA_CITY.geoid

const pg = await withPg()

describe.skipIf(!pg)("service-hours certificates (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** A `done` event in LA_CITY, so `logEventHours` has something to credit against. */
  async function newCleanup(organizerId: string, title: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${id}, ${organizerId}, 'site', ${title},
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        now() - interval '2 days', 'done', ${GEOID}
      )
    `
    return id
  }

  /** Credit `hours` to `userId` through the real ledger repo, exactly as a host would. */
  async function credit(
    organizerId: string,
    userId: string,
    hours: number,
    title = "Beach cleanup",
  ): Promise<string> {
    const cleanupId = await newCleanup(organizerId, title)
    await makeDrizzleVolunteerHoursRepository(h.sql).logEventHours({
      actorId: organizerId,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId, hours }],
    })
    return cleanupId
  }

  function makeService(storage = new FakeStorage()): {
    service: CertificateService
    storage: FakeStorage
  } {
    return {
      service: makeCertificateService({
        repo: makeDrizzleCertificateRepository(h.sql),
        hours: makeDrizzleVolunteerHoursRepository(h.sql),
        storage,
      }),
      storage,
    }
  }

  it("issues a row whose code is canonical, whose snapshot round-trips, and whose object exists", async () => {
    const org = await newUser("Cert Org")
    const holder = await newUser("Cert Holder")
    await credit(org, holder, 3.5)

    const { service, storage } = makeService()
    const { certificate, reused } = await service.issue(holder)

    expect(reused).toBe(false)
    expect(certificate.code).toMatch(CERTIFICATE_CODE_RE)
    expect(certificate.totalHours).toBe(3.5)
    expect(certificate.entryCount).toBe(1)
    expect(certificate.url).toBeTruthy()

    const rows = await h.sql<
      {
        code: string
        r2_key: string
        entry_count: number
        total_hours: string
        snapshot: { v: number; rows: { hours: number }[]; holder: { displayName: string } }
      }[]
    >`
      SELECT code, r2_key, entry_count, total_hours, snapshot
      FROM service_hours_certificates WHERE user_id = ${holder}
    `
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.code).toBe(certificate.code)
    expect(row.entry_count).toBe(1)
    // jsonb round-trip: the stored model is exactly what was rendered.
    expect(row.snapshot.v).toBe(1)
    expect(row.snapshot.holder.displayName).toBe("Cert Holder")
    expect(row.snapshot.rows).toHaveLength(1)
    expect(row.snapshot.rows[0]!.hours).toBe(3.5)

    // The object landed in the media bucket under the C16 prefix.
    expect(row.r2_key).toMatch(/^certificates\/service-hours\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/)
    expect(await storage.head(row.r2_key)).not.toBeNull()
  })

  it("TWO CONCURRENT ISSUES over the same ledger leave exactly ONE row, and both callers get it", async () => {
    const org = await newUser("Race Org")
    const holder = await newUser("Race Holder")
    await credit(org, holder, 2)

    // Two independent service instances, as two in-flight requests would be — no shared state beyond
    // the database and the bucket.
    const storage = new FakeStorage()
    const a = makeService(storage).service
    const b = makeService(storage).service

    const [first, second] = await Promise.all([a.issue(holder), b.issue(holder)])

    const rows = await h.sql<{ code: string; r2_key: string }[]>`
      SELECT code, r2_key FROM service_hours_certificates
      WHERE user_id = ${holder} AND revoked_at IS NULL
    `
    // The partial unique index is what makes this true; the service's conflict branch is what keeps the
    // loser from 500ing.
    expect(rows).toHaveLength(1)
    const winner = rows[0]!
    expect(first.certificate.code).toBe(winner.code)
    expect(second.certificate.code).toBe(winner.code)
    // Exactly one of the two rendered documents survives; the loser's object is swept best-effort.
    const keys = [...storage.objects.keys()]
    expect(keys).toEqual([winner.r2_key])
    // Exactly one of the two calls did a fresh render.
    expect([first.reused, second.reused].filter((r) => r === true)).toHaveLength(1)
  })

  it("a repeat issue over an UNCHANGED ledger reuses the row and renders nothing new", async () => {
    const org = await newUser("Reuse Org")
    const holder = await newUser("Reuse Holder")
    await credit(org, holder, 1.25)

    const { service, storage } = makeService()
    const first = await service.issue(holder)
    const second = await service.issue(holder)

    expect(second.certificate.code).toBe(first.certificate.code)
    expect(second.reused).toBe(true)
    expect(storage.objects.size).toBe(1)
    const counted = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM service_hours_certificates WHERE user_id = ${holder}
    `
    expect(counted[0]!.count).toBe(1)
  })

  it("revoking FREES the partial-index slot, so the same ledger mints a NEW code", async () => {
    const org = await newUser("Revoke Org")
    const holder = await newUser("Revoke Holder")
    await credit(org, holder, 6)

    const { service, storage } = makeService()
    const first = await service.issue(holder)
    expect(storage.objects.size).toBe(1)

    const revoked = await service.revoke(holder, first.certificate.code)
    expect(revoked.certificate.status).toBe("revoked")
    // The download link dies with the object.
    expect(storage.objects.size).toBe(0)

    const second = await service.issue(holder)
    expect(second.certificate.code).not.toBe(first.certificate.code)
    expect(second.reused).toBe(false)

    const rows = await h.sql<{ code: string; revoked_at: Date | null; revoked_reason: string | null }[]>`
      SELECT code, revoked_at, revoked_reason FROM service_hours_certificates
      WHERE user_id = ${holder} ORDER BY issued_at ASC
    `
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.code === first.certificate.code)!.revoked_at).not.toBeNull()
    expect(rows.find((r) => r.code === first.certificate.code)!.revoked_reason).toBe("holder")
    expect(rows.find((r) => r.code === second.certificate.code)!.revoked_at).toBeNull()
  })

  /**
   * THE OPERATOR REMEDY, end to end — `scripts/revoke-certificate.ts` (`pnpm db:certificate:revoke`).
   *
   * The product's revoke is holder-gated and hardcodes the reason `"holder"`, which would publicly blame
   * the volunteer for a correction civfix made. The operator path is the SAME repository call with an
   * operator reason, and it is the remedy `drizzle/0065_void_report_volunteer_hours.sql` and the runbook's
   * §1b point at, so it is pinned here rather than left to a hand-written UPDATE: the reason must reach
   * the PUBLIC verify projection verbatim, and the revoke must free the partial-index slot so the holder
   * can re-issue a corrected transcript.
   */
  it("an OPERATOR revoke reaches verify() with its own reason and frees the re-issue slot", async () => {
    const org = await newUser("Operator Org")
    const holder = await newUser("Operator Holder")
    await credit(org, holder, 5)

    const { service, storage } = makeService()
    const issued = await service.issue(holder)
    expect(storage.objects.size).toBe(1)

    // Exactly what the script does: find the row by its printed code, then revoke it BY THAT ROW'S OWN
    // user id (the operator is not the holder and has no session), with an operator reason.
    const repo = makeDrizzleCertificateRepository(h.sql)
    const found = await repo.findByCode(issued.certificate.code)
    expect(found?.userId).toBe(holder)
    const row = await repo.revoke(found!.userId, issued.certificate.code, "ledger_corrected", new Date())
    expect(row?.revokedReason).toBe("ledger_corrected")

    // The person holding the paper is told WHY, and is not told the volunteer withdrew it.
    const verified = await service.verify(issued.certificate.code)
    expect(verified.status).toBe("revoked")
    expect(verified.revokedReason).toBe("ledger_corrected")

    // Idempotent: a second run never rewrites the first revocation's reason or timestamp.
    const again = await repo.revoke(holder, issued.certificate.code, "issued_in_error", new Date())
    expect(again?.revokedReason).toBe("ledger_corrected")
    expect(again?.revokedAt?.getTime()).toBe(row?.revokedAt?.getTime())

    // The partial unique index is free again, so the holder can re-issue once the ledger is corrected.
    const reissued = await service.issue(holder)
    expect(reissued.reused).toBe(false)
    expect(reissued.certificate.code).not.toBe(issued.certificate.code)
  })

  it("verify reports a valid document, a revoked one, and 404s an unknown code", async () => {
    const org = await newUser("Verify Org")
    const holder = await newUser("Verify Holder")
    await credit(org, holder, 4)

    const { service } = makeService()
    const issued = await service.issue(holder)

    const valid = await service.verify(issued.certificate.code)
    expect(valid.status).toBe("valid")
    expect(valid.holderName).toBe("Verify Holder")
    expect(valid.totalHours).toBe(4)
    expect(Object.keys(valid)).not.toContain("url")

    await service.revoke(holder, issued.certificate.code)
    const afterRevoke = await service.verify(issued.certificate.code)
    expect(afterRevoke.status).toBe("revoked")
    expect(afterRevoke.holderName).toBe("Verify Holder")
    expect(afterRevoke.revokedReason).toBe("holder")

    await expect(service.verify("ZZZZZZZZZZZZ")).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a SOFT-DELETED holder verifies as account_closed with the name withheld", async () => {
    const org = await newUser("Tombstone Org")
    const holder = await newUser("Tombstone Holder")
    await credit(org, holder, 2.5)

    const { service } = makeService()
    const issued = await service.issue(holder)

    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${holder}`

    const res = await service.verify(issued.certificate.code)
    expect(res.status).toBe("revoked")
    expect(res.revokedReason).toBe("account_closed")
    // The tombstone means the identity is not echoed back, but the code still answers honestly.
    expect(Object.keys(res)).not.toContain("holderName")
    expect(res.totalHours).toBe(2.5)

    // And a tombstoned account can no longer issue.
    await expect(service.issue(holder)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("409s an empty ledger without rendering or storing anything", async () => {
    const holder = await newUser("No Hours")
    const { service, storage } = makeService()
    await expect(service.issue(holder)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(storage.objects.size).toBe(0)
  })

  /**
   * DP §4.5: `snapshot` is ~200 KB of jsonb at the 1000-entry cap and lives out of line in TOAST. A
   * `SELECT *` on the list or public-verify path would detoast it on every read. Cheap source grep, same
   * shape as the "THE RULE" grep tests in @civfix/ui — an assertion about the code, because no runtime
   * assertion can see a detoast.
   */
  it("the certificate repo SQL never uses SELECT * and never SELECTs the snapshot column", () => {
    const raw = readFileSync(
      fileURLToPath(
        new URL("../../src/services/certificate-repository.drizzle.ts", import.meta.url),
      ),
      "utf8",
    )
    // Strip comments first: the file's own header EXPLAINS the rule and quotes `SELECT *`, so a naive
    // grep would fail on the documentation rather than on the code.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

    expect(code).not.toMatch(/SELECT\s+\*/i)
    // `snapshot` may appear ONLY in the INSERT column list — never in a projection. The SQL keyword is
    // matched CASE-SENSITIVELY at a line start: the TypeScript row type is named `CertificateRowSelect`,
    // and a case-insensitive `/select/` happily matches that identifier and then swallows the next
    // statement whole.
    const selectBlocks = code.match(/^\s*SELECT\b[\s\S]*?\bFROM\b/gm) ?? []
    expect(selectBlocks.length).toBeGreaterThan(0)
    for (const block of selectBlocks) {
      expect(block, "a read path selects the TOASTed snapshot column").not.toMatch(/\bsnapshot\b/)
    }
    // …and the RETURNING projections must not drag it back either.
    for (const block of code.match(/^\s*RETURNING\b[\s\S]*?`/gm) ?? []) {
      expect(block, "a RETURNING projection selects the TOASTed snapshot column").not.toMatch(
        /\bsnapshot\b/,
      )
    }
  })
})
