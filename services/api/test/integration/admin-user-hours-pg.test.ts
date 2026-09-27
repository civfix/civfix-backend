import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { parseTimeCursor } from "../../src/db/cursor-helpers.js"
import { buildTranscriptModel } from "../../src/services/certificate-model.js"
import { makeDrizzleCertificateRepository } from "../../src/services/certificate-repository.drizzle.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid
const PG_DEADLOCK = "40P01"

const pg = await withPg()

describe.skipIf(!pg)("operator volunteer-hours ledger (integration)", () => {
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

  async function newDoneCleanup(organizerId: string, scheduledAt: string): Promise<string> {
    const startsAt = new Date(scheduledAt)
    const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60 * 1000)
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Operator ledger sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: startsAt,
      endsAt,
      completedAt: endsAt,
      status: "done",
      jurisdictionGeoid: GEOID,
    })
  }

  async function row(entryId: string) {
    const [r] = await h.sql<
      {
        source: string
        hours: number
        cleanup_id: string | null
        jurisdiction_geoid: string | null
        logged_by_user_id: string | null
        credited_by_operator_id: string | null
        note: string | null
        service_date: string | null
        voided_at: Date | null
        voided_by_operator_id: string | null
        void_reason: string | null
      }[]
    >`
      SELECT source, hours::float8 AS hours, cleanup_id, jurisdiction_geoid, logged_by_user_id,
             credited_by_operator_id, note, service_date::text AS service_date, voided_at,
             voided_by_operator_id, void_reason
      FROM volunteer_hours WHERE id = ${entryId}
    `
    return r!
  }

  async function journalFor(cleanupId: string, userId: string) {
    return h.sql<{ actor: string; previous_hours: number | null; new_hours: number }[]>`
      SELECT actor_user_id AS actor, previous_hours::float8 AS previous_hours,
             new_hours::float8 AS new_hours
      FROM volunteer_hours_audit
      WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}
      ORDER BY created_at ASC, id ASC
    `
  }

  async function auditLogFor(userId: string) {
    return h.sql<{ actor_id: string; action: string; meta: Record<string, unknown> }[]>`
      SELECT actor_id, action, meta FROM audit_log
      WHERE target = ${`user:${userId}`}
      ORDER BY created_at ASC, id ASC
    `
  }

  async function rollupAt(userId: string): Promise<number> {
    const rows = await h.sql<{ total: number }[]>`
      SELECT total_hours::float8 AS total FROM user_jurisdiction_hours
      WHERE user_id = ${userId} AND jurisdiction_geoid = ${GEOID}
    `
    return rows[0]?.total ?? 0
  }

  /** Rollup rows of these users that disagree with the SUM of their live ledger rows. */
  async function driftFor(userIds: string[]): Promise<{ user_id: string; geoid: string }[]> {
    return h.sql<{ user_id: string; geoid: string }[]>`
      SELECT ujh.user_id, ujh.jurisdiction_geoid AS geoid
      FROM user_jurisdiction_hours ujh
      WHERE ujh.user_id = ANY(${userIds}::uuid[])
        AND ujh.total_hours <> COALESCE((
          SELECT SUM(vh.hours) FROM volunteer_hours vh
          WHERE vh.user_id = ujh.user_id
            AND vh.jurisdiction_geoid = ujh.jurisdiction_geoid
            AND vh.voided_at IS NULL
        ), 0)
      UNION ALL
      SELECT vh.user_id, vh.jurisdiction_geoid
      FROM volunteer_hours vh
      WHERE vh.user_id = ANY(${userIds}::uuid[])
        AND vh.voided_at IS NULL
        AND vh.jurisdiction_geoid IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_jurisdiction_hours ujh
          WHERE ujh.user_id = vh.user_id AND ujh.jurisdiction_geoid = vh.jurisdiction_geoid
        )
    `
  }

  it("an operator event credit is attributed to CivFix, journaled and audited as the operator, atomically", async () => {
    const host = await newUser("Op Host")
    const alice = await newUser("Op Alice")
    const operator = await newUser("Op Olive")
    const cleanupId = await newDoneCleanup(host, "2026-07-04T17:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const { entryId } = await repo.creditEventAsOperator({
      operatorId: operator,
      userId: alice,
      cleanupId,
      geoid: GEOID,
      hours: 3,
      reason: "Signed up after the event",
    })

    expect(await row(entryId)).toMatchObject({
      source: "event",
      hours: 3,
      cleanup_id: cleanupId,
      jurisdiction_geoid: GEOID,
      logged_by_user_id: CIVFIX_OFFICIAL_USER_ID,
      credited_by_operator_id: operator,
      note: "Signed up after the event",
      service_date: null,
      voided_at: null,
    })
    expect(await rollupAt(alice)).toBe(3)
    expect(await journalFor(cleanupId, alice)).toEqual([
      { actor: operator, previous_hours: null, new_hours: 3 },
    ])
    expect(await auditLogFor(alice)).toEqual([
      {
        actor_id: operator,
        action: "user.hours_credited",
        meta: {
          entryId,
          source: "event",
          cleanupId,
          hours: 3,
          reason: "Signed up after the event",
        },
      },
    ])
    const hostSheet = await repo.listEventHours(cleanupId, null)
    expect(hostSheet.entries.map((e) => [e.userId, e.creditedByOfficial])).toEqual([[alice, true]])

    await expect(
      repo.creditEventAsOperator({
        operatorId: operator,
        userId: alice,
        cleanupId,
        geoid: GEOID,
        hours: 1,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await auditLogFor(alice)).toHaveLength(1)
  })

  it("void journals (h, 0), leaves the rollup exact, and a re-credit revives the row as previous 0", async () => {
    const host = await newUser("Void Host")
    const alice = await newUser("Void Alice")
    const operator = await newUser("Void Olive")
    const cleanupId = await newDoneCleanup(host, "2026-07-06T17:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({
      actorId: host,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 3 }],
    })
    const [hostRow] = (await repo.listOperatorLedger({ userId: alice, cursor: null, limit: 10 }))
      .items

    const voided = await repo.voidEntry({
      operatorId: operator,
      userId: alice,
      entryId: hostRow!.id,
      reason: "Was not there",
    })
    expect(voided).toEqual({ id: hostRow!.id, source: "event", cleanupId, hours: 3 })
    expect(await row(hostRow!.id)).toMatchObject({
      voided_by_operator_id: operator,
      void_reason: "Was not there",
    })
    expect((await row(hostRow!.id)).voided_at).toBeInstanceOf(Date)
    expect(await rollupAt(alice)).toBe(0)

    await expect(
      repo.voidEntry({ operatorId: operator, userId: alice, entryId: hostRow!.id, reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      repo.voidEntry({ operatorId: operator, userId: host, entryId: hostRow!.id, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      repo.voidEntry({ operatorId: operator, userId: alice, entryId: randomUUID(), reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const { entryId } = await repo.creditEventAsOperator({
      operatorId: operator,
      userId: alice,
      cleanupId,
      geoid: GEOID,
      hours: 2,
      reason: "Came for the second half",
    })
    expect(entryId).toBe(hostRow!.id)
    expect(await row(entryId)).toMatchObject({
      voided_at: null,
      voided_by_operator_id: null,
      void_reason: null,
      credited_by_operator_id: operator,
      logged_by_user_id: CIVFIX_OFFICIAL_USER_ID,
    })
    expect(await rollupAt(alice)).toBe(2)
    expect(await journalFor(cleanupId, alice)).toEqual([
      { actor: host, previous_hours: null, new_hours: 3 },
      { actor: operator, previous_hours: 3, new_hours: 0 },
      { actor: operator, previous_hours: 0, new_hours: 2 },
    ])
    expect((await auditLogFor(alice)).map((a) => a.action)).toEqual([
      "user.hours_voided",
      "user.hours_credited",
    ])
    expect(await driftFor([alice])).toEqual([])
  })

  it("a manual credit stores its service date, stays out of the rollup and dates the transcript row", async () => {
    const alice = await newUser("Manual Alice")
    const operator = await newUser("Manual Olive")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const { entryId } = await repo.creditManual({
      operatorId: operator,
      userId: alice,
      hours: 1.5,
      serviceDate: "2026-06-30",
      reason: "Library fair",
    })

    expect(await row(entryId)).toMatchObject({
      source: "manual",
      cleanup_id: null,
      jurisdiction_geoid: null,
      service_date: "2026-06-30",
      logged_by_user_id: CIVFIX_OFFICIAL_USER_ID,
      credited_by_operator_id: operator,
      note: "Library fair",
    })
    expect(await rollupAt(alice)).toBe(0)
    expect(await repo.totalHoursFor(alice)).toBe(1.5)
    const serviceNoon = new Date("2026-06-30T12:00:00.000Z")
    const [listed] = (await repo.listEntries({ userId: alice, cursor: null, limit: 10 })).items
    expect(listed!.occurredAt).toEqual(serviceNoon)
    const transcript = await repo.entriesForCertificate({
      userId: alice,
      geoid: null,
      from: null,
      to: null,
      limit: 10,
    })
    expect(transcript.items.map((i) => i.occurredAt)).toEqual([serviceNoon])

    await expect(
      repo.creditManual({
        operatorId: operator,
        userId: alice,
        hours: 1.5,
        serviceDate: "2026-06-30",
        reason: "Library fair",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("the CHECKs pin service_date to manual rows and bound void_reason", async () => {
    const alice = await newUser("Check Alice")
    await expect(h.sql`
      INSERT INTO volunteer_hours (user_id, hours, source) VALUES (${alice}, 1, 'manual')
    `).rejects.toMatchObject({ constraint_name: "volunteer_hours_service_date_chk" })
    await expect(h.sql`
      INSERT INTO volunteer_hours (user_id, hours, source, service_date)
      VALUES (${alice}, 1, 'event', '2026-07-01')
    `).rejects.toMatchObject({ constraint_name: "volunteer_hours_service_date_chk" })
    await expect(h.sql`
      INSERT INTO volunteer_hours (user_id, hours, source, service_date, void_reason)
      VALUES (${alice}, 1, 'manual', '2026-07-01', ${"x".repeat(1001)})
    `).rejects.toMatchObject({ constraint_name: "volunteer_hours_void_reason_len_chk" })
  })

  it("the daily cap sums event rows on the event's local date with manual rows on that service date", async () => {
    const host = await newUser("Cap Host")
    const alice = await newUser("Cap Alice")
    const operator = await newUser("Cap Olive")
    const morning = await newDoneCleanup(host, "2026-07-08T17:00:00Z")
    const lateEvening = await newDoneCleanup(host, "2026-07-09T05:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.creditManual({
      operatorId: operator,
      userId: alice,
      hours: 20,
      serviceDate: "2026-07-08",
      reason: "Warehouse sort",
    })

    await expect(
      repo.logEventHours({
        actorId: host,
        cleanupId: morning,
        geoid: GEOID,
        entries: [{ userId: alice, hours: 5 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      repo.creditEventAsOperator({
        operatorId: operator,
        userId: alice,
        cleanupId: lateEvening,
        geoid: GEOID,
        hours: 5,
        reason: "Evening shift",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    await repo.logEventHours({
      actorId: host,
      cleanupId: morning,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 4 }],
    })
    await expect(
      repo.creditManual({
        operatorId: operator,
        userId: alice,
        hours: 0.5,
        serviceDate: "2026-07-08",
        reason: "Cleanup of the sort",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await repo.creditManual({
      operatorId: operator,
      userId: alice,
      hours: 20,
      serviceDate: "2026-07-09",
      reason: "Next day",
    })
  })

  it("concurrent host credits, operator credits and voids on one event never deadlock or drift", async () => {
    const host = await newUser("Race Host")
    const operator = await newUser("Race Olive")
    const attendees = await Promise.all(
      ["Race A", "Race B", "Race C", "Race D"].map((name) => newUser(name)),
    )
    const [a, b, c, d] = attendees as [string, string, string, string]
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    for (let round = 0; round < 6; round++) {
      const cleanupId = await newDoneCleanup(
        host,
        `2026-08-${String(round + 1).padStart(2, "0")}T17:00:00Z`,
      )
      await repo.logEventHours({
        actorId: host,
        cleanupId,
        geoid: GEOID,
        entries: [{ userId: b, hours: 2 }],
      })
      const bRow = (await repo.listOperatorLedger({ userId: b, cursor: null, limit: 1 })).items[0]!

      const outcomes = await Promise.allSettled([
        repo.logEventHours({
          actorId: host,
          cleanupId,
          geoid: GEOID,
          entries: [
            { userId: d, hours: 3 },
            { userId: a, hours: 1 },
            { userId: b, hours: 2.5 },
          ],
        }),
        repo.creditEventAsOperator({
          operatorId: operator,
          userId: c,
          cleanupId,
          geoid: GEOID,
          hours: 2,
          reason: `round ${round}`,
        }),
        repo.voidEntry({
          operatorId: operator,
          userId: b,
          entryId: bRow.id,
          reason: `round ${round}`,
        }),
        repo.creditManual({
          operatorId: operator,
          userId: a,
          hours: 1,
          serviceDate: `2026-08-${String(round + 1).padStart(2, "0")}`,
          reason: `round ${round}`,
        }),
      ])

      // Whichever of the void and the host's re-save of B wins the locks, both succeed: the void
      // takes whatever live hours B holds, and a later re-save revives the row.
      const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []))
      expect(failures.map((err) => (err as { code?: string }).code)).not.toContain(PG_DEADLOCK)
      expect(failures).toEqual([])
    }

    expect(await driftFor(attendees)).toEqual([])
    for (const userId of attendees) {
      const totals = await repo.operatorLedgerTotals(userId)
      const [ledger] = await h.sql<{ total: number }[]>`
        SELECT COALESCE(SUM(hours), 0)::float8 AS total FROM volunteer_hours
        WHERE user_id = ${userId} AND voided_at IS NULL AND source <> 'report'
      `
      expect(totals.totalHours).toBe(ledger!.total)
    }
  })

  it("pages the operator ledger by (created_at, id), voided rows included, with live and voided counts", async () => {
    const alice = await newUser("Page Alice")
    const operator = await newUser("Page Olive")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    const ids: string[] = []
    for (let day = 1; day <= 5; day++) {
      const { entryId } = await repo.creditManual({
        operatorId: operator,
        userId: alice,
        hours: 1,
        serviceDate: `2026-05-0${day}`,
        reason: `day ${day}`,
      })
      ids.unshift(entryId)
    }
    await repo.voidEntry({ operatorId: operator, userId: alice, entryId: ids[1]!, reason: "dup" })

    const first = await repo.listOperatorLedger({ userId: alice, cursor: null, limit: 3 })
    const second = await repo.listOperatorLedger({
      userId: alice,
      cursor: parseTimeCursor(first.nextCursor!),
      limit: 3,
    })
    expect([...first.items, ...second.items].map((i) => i.id)).toEqual(ids)
    expect(second.nextCursor).toBeNull()
    expect(first.items[1]).toMatchObject({
      voidedBy: { id: operator, name: "Page Olive" },
      voidReason: "dup",
      operator: { id: operator, name: "Page Olive" },
      creditedBy: { id: CIVFIX_OFFICIAL_USER_ID, official: true },
    })
    expect(await repo.operatorLedgerTotals(alice)).toEqual({
      totalHours: 4,
      liveEntries: 4,
      voidedEntries: 1,
    })
  })

  it("finds the live certificates whose snapshot itemised an entry", async () => {
    const alice = await newUser("Cert Alice")
    const certs = makeDrizzleCertificateRepository(h.sql)
    const entry = randomUUID()

    async function issue(code: string, entryIds: string[], issuedAt: string): Promise<void> {
      await certs.insert({
        id: randomUUID(),
        userId: alice,
        code,
        locale: "en",
        holderName: "Cert Alice",
        holderHandle: null,
        holderVerified: false,
        totalHours: entryIds.length,
        entryCount: entryIds.length,
        periodStart: null,
        periodEnd: null,
        ledgerFingerprint: `fp-${code}`,
        snapshot: buildTranscriptModel({
          holder: { userId: alice, displayName: "Cert Alice", handle: null },
          rows: entryIds.map((id) => ({
            id,
            source: "event" as const,
            hours: 1,
            occurredAt: new Date(issuedAt),
          })),
          locale: "en",
        }),
        r2Key: `certificates/${code}.pdf`,
        documentSha256: "0".repeat(64),
        byteSize: 1,
        issuedAt: new Date(issuedAt),
      })
    }

    const suffix = randomUUID().slice(0, 6).toUpperCase()
    await issue(`A${suffix}`, [entry], "2026-07-01T00:00:00Z")
    await issue(`B${suffix}`, [randomUUID(), entry], "2026-07-02T00:00:00Z")
    await issue(`C${suffix}`, [randomUUID()], "2026-07-03T00:00:00Z")
    await issue(`D${suffix}`, [entry], "2026-07-04T00:00:00Z")
    await certs.revoke(alice, `D${suffix}`, "ledger_corrected", new Date())

    expect(await certs.liveCodesListingEntry(alice, entry)).toEqual([
      { code: `B${suffix}`, issuedAt: new Date("2026-07-02T00:00:00Z") },
      { code: `A${suffix}`, issuedAt: new Date("2026-07-01T00:00:00Z") },
    ])
  })
})
