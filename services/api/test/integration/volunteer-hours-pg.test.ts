
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { makeVolunteerHoursService } from "../../src/services/volunteer-hours-service.js"
import { parseTimeCursor } from "../../src/db/cursor-helpers.js"
import { CALIFORNIA, LA_CITY, LA_COUNTY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid

const pg = await withPg()

describe.skipIf(!pg)("volunteer hours (integration)", () => {
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

  async function newCleanup(organizerId: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Hours sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        now() - interval '1 day', 'done', ${GEOID}
      )
    `
    return id
  }

  async function rollupFor(userId: string): Promise<number> {
    const rows = await h.sql<{ total: number }[]>`
      SELECT total_hours::float8 AS total FROM user_jurisdiction_hours
      WHERE user_id = ${userId} AND jurisdiction_geoid = ${GEOID}
    `
    return rows[0]?.total ?? 0
  }

  it("credits per-attendee hours in one statement and overwrites per row on re-log (rollup delta)", async () => {
    const org = await newUser("Hours Org")
    const alice = await newUser("Hours Alice")
    const bob = await newUser("Hours Bob")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: org, hours: 2 },
        { userId: alice, hours: 4.5 },
        { userId: bob, hours: 1 },
      ],
    })
    expect(credited.credited).toBe(3)
    expect(credited.changed.map((c) => [c.userId, c.hours, c.previousHours]).sort()).toEqual(
      [
        [org, 2, null],
        [alice, 4.5, null],
        [bob, 1, null],
      ].sort(),
    )

    const ledger = await h.sql<{ user_id: string; hours: number; logged_by: string }[]>`
      SELECT user_id, hours::float8 AS hours, logged_by_user_id AS logged_by
      FROM volunteer_hours WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(ledger).toHaveLength(3)
    const byUser = Object.fromEntries(ledger.map((r) => [r.user_id, r.hours]))
    expect(byUser).toEqual({ [org]: 2, [alice]: 4.5, [bob]: 1 })
    expect(ledger.every((r) => r.logged_by === org)).toBe(true)

    expect(await rollupFor(org)).toBe(2)
    expect(await rollupFor(alice)).toBe(4.5)
    expect(await rollupFor(bob)).toBe(1)

    const relogged = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: alice, hours: 3 },
        { userId: bob, hours: 2 },
      ],
    })
    expect(relogged.credited).toBe(2)
    expect(relogged.changed.map((c) => [c.userId, c.previousHours, c.hours]).sort()).toEqual(
      [
        [alice, 4.5, 3],
        [bob, 1, 2],
      ].sort(),
    )

    const rows = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(rows[0]!.count).toBe(3)
    expect(await rollupFor(alice)).toBe(3)
    expect(await rollupFor(bob)).toBe(2)
    expect(await rollupFor(org)).toBe(2)

    const totals = await repo.totalsFor(alice)
    expect(totals.totalHours).toBe(3)
    expect(totals.byJurisdiction).toEqual([{ geoid: GEOID, name: LA_CITY.name, hours: 3 }])
  })

  it("a geoid-less event writes the ledger but never the rollup", async () => {
    const org = await newUser("Hours NoGeo Org")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo sweep',
        ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [{ userId: org, hours: 2.5 }],
    })
    expect(credited.credited).toBe(1)

    const ledger = await h.sql<{ hours: number }[]>`
      SELECT hours::float8 AS hours FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${org}
    `
    expect(ledger[0]!.hours).toBe(2.5)
    expect(await rollupFor(org)).toBe(0)
  })

  it("F066: geoid-less hours are counted in totalHours/totalsFor, not silently zeroed by the rollup", async () => {
    const org = await newUser("Hours F066 Org")
    const alice = await newUser("Hours F066 Alice")
    const mapped = await newCleanup(org)
    const unmapped = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${unmapped}, ${org}, 'site', 'Unmapped sweep',
        ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({ actorId: org, cleanupId: mapped, geoid: GEOID, entries: [{ userId: alice, hours: 2 }] })
    await repo.logEventHours({ actorId: org, cleanupId: unmapped, geoid: null, entries: [{ userId: alice, hours: 1.5 }] })

    const ledgerRows = await h.sql<{ total: number }[]>`
      SELECT COALESCE(SUM(hours), 0)::float8 AS total FROM volunteer_hours
      WHERE user_id = ${alice} AND voided_at IS NULL AND source <> 'report'
    `
    const totals = await repo.totalsFor(alice)
    expect(totals.totalHours).toBe(3.5)
    expect(totals.totalHours).toBe(ledgerRows[0]!.total)
    expect(await repo.totalHoursFor(alice)).toBe(3.5)
    expect(totals.byJurisdiction).toEqual([{ geoid: GEOID, name: LA_CITY.name, hours: 2 }])
  })

  it("re-logging after the event moves OUT of coverage reverses the old jurisdiction's rollup", async () => {
    const org = await newUser("Hours Moved Org")
    const alice = await newUser("Hours Moved Alice")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: org, hours: 2 },
        { userId: alice, hours: 3 },
      ],
    })
    expect(await rollupFor(org)).toBe(2)
    expect(await rollupFor(alice)).toBe(3)

    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [
        { userId: org, hours: 4 },
        { userId: alice, hours: 1 },
      ],
    })
    expect(credited.credited).toBe(2)

    const ledger = await h.sql<{ user_id: string; hours: number; geoid: string | null }[]>`
      SELECT user_id, hours::float8 AS hours, jurisdiction_geoid AS geoid
      FROM volunteer_hours WHERE cleanup_id = ${cleanupId} AND source = 'event'
    `
    expect(ledger).toHaveLength(2)
    expect(ledger.every((r) => r.geoid === null)).toBe(true)
    expect(Object.fromEntries(ledger.map((r) => [r.user_id, r.hours]))).toEqual({
      [org]: 4,
      [alice]: 1,
    })

    expect(await rollupFor(org)).toBe(0)
    expect(await rollupFor(alice)).toBe(0)
    const totals = await repo.totalsFor(alice)
    expect(totals.byJurisdiction).toEqual([])
    expect(totals.totalHours).toBe(1)
  })

  it("re-logging a never-mapped event just overwrites (no phantom reversal)", async () => {
    const org = await newUser("Hours NoGeo Twice")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo re-log',
        ST_SetSRID(ST_MakePoint(-118.31, 34.11), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: org, hours: 1 }] })
    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: null,
      entries: [{ userId: org, hours: 6 }],
    })
    expect(credited.credited).toBe(1)

    const ledger = await h.sql<{ hours: number; geoid: string | null }[]>`
      SELECT hours::float8 AS hours, jurisdiction_geoid AS geoid FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${org}
    `
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.hours).toBe(6)
    expect(ledger[0]!.geoid).toBeNull()
    const rows = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM user_jurisdiction_hours WHERE user_id = ${org}
    `
    expect(rows[0]!.count).toBe(0)
  })

  it("M21: every upsert appends an immutable audit row carrying the previous + new value", async () => {
    const org = await newUser("Audit Org")
    const alice = await newUser("Audit Alice")
    const cohost = await newUser("Audit Cohost")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    async function auditRows(): Promise<
      { user_id: string; actor_user_id: string; previous_hours: number | null; new_hours: number }[]
    > {
      return h.sql`
        SELECT user_id, actor_user_id, previous_hours::float8 AS previous_hours, new_hours::float8 AS new_hours
        FROM volunteer_hours_audit
        WHERE cleanup_id = ${cleanupId}
        ORDER BY created_at ASC, new_hours ASC
      `
    }

    await repo.logEventHours({ actorId: org, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 2 }] })
    let rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: alice, actor_user_id: org, previous_hours: null, new_hours: 2 })

    await repo.logEventHours({ actorId: org, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 20 }] })
    await repo.logEventHours({ actorId: cohost, cleanupId, geoid: GEOID, entries: [{ userId: alice, hours: 2 }] })

    rows = await auditRows()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.previous_hours, r.new_hours])).toEqual([
      [null, 2],
      [2, 20],
      [20, 2],
    ])
    expect(rows.map((r) => r.actor_user_id)).toEqual([org, org, cohost])

    const ledger = await h.sql<{ hours: number }[]>`
      SELECT hours::float8 AS hours FROM volunteer_hours
      WHERE cleanup_id = ${cleanupId} AND source = 'event' AND user_id = ${alice}
    `
    expect(ledger[0]!.hours).toBe(2)
  })

  it("M21: the audit is written for the geoid-less branch too", async () => {
    const org = await newUser("Audit NoGeo Org")
    const alice = await newUser("Audit NoGeo Alice")
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${org}, 'site', 'No-geo audit sweep',
        ST_SetSRID(ST_MakePoint(-118.3, 34.1), 4326),
        now() - interval '1 day', 'done'
      )
    `
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: alice, hours: 1 }] })
    await repo.logEventHours({ actorId: org, cleanupId, geoid: null, entries: [{ userId: alice, hours: 5 }] })

    const rows = await h.sql<{ previous_hours: number | null; new_hours: number }[]>`
      SELECT previous_hours::float8 AS previous_hours, new_hours::float8 AS new_hours
      FROM volunteer_hours_audit WHERE cleanup_id = ${cleanupId} ORDER BY created_at ASC, new_hours ASC
    `
    expect(rows.map((r) => [r.previous_hours, r.new_hours])).toEqual([
      [null, 1],
      [1, 5],
    ])
  })


  async function newUserWithFlag(name: string, flag: boolean | null): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, show_volunteer_hours)
      VALUES (${name}, ${flag}) RETURNING id
    `
    return u!.id
  }

  async function insertEntry(args: {
    id: string
    userId: string
    hours: number
    source: "event" | "report" | "manual"
    createdAt: string
    cleanupId?: string | null
    reportId?: string | null
    geoid?: string | null
    loggedBy?: string | null
    voided?: boolean
  }): Promise<void> {
    await h.sql`
      INSERT INTO volunteer_hours
        (id, user_id, hours, source, cleanup_id, report_id, jurisdiction_geoid, logged_by_user_id,
         created_at, voided_at)
      VALUES (
        ${args.id}, ${args.userId}, ${args.hours}, ${args.source},
        ${args.cleanupId ?? null}, ${args.reportId ?? null}, ${args.geoid ?? null},
        ${args.loggedBy ?? null},
        ${args.createdAt}::timestamptz,
        ${args.voided === true ? args.createdAt : null}
      )
    `
  }

  it("listEntries pages the keyset newest-first, tie-breaking on the id", async () => {
    const owner = await newUser("Ledger Owner")
    const at = "2026-05-01T12:00:00.000Z"
    const ids = [
      "1a000000-0000-4000-8000-000000000001",
      "1a000000-0000-4000-8000-000000000002",
      "1a000000-0000-4000-8000-000000000003",
      "1a000000-0000-4000-8000-000000000004",
    ]
    for (const id of ids) {
      await insertEntry({ id, userId: owner, hours: 1, source: "manual", createdAt: at })
    }
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const first = await repo.listEntries({ userId: owner, cursor: null, limit: 2 })
    expect(first.items.map((e) => e.id)).toEqual([ids[3], ids[2]])
    expect(first.nextCursor).not.toBeNull()

    const parsed = parseTimeCursor(first.nextCursor)
    const second = await repo.listEntries({ userId: owner, cursor: parsed, limit: 2 })
    expect(second.items.map((e) => e.id)).toEqual([ids[1], ids[0]])
    expect(second.nextCursor).toBeNull()
  })

  it("listEntries filters voided rows and honours the source filter", async () => {
    const owner = await newUser("Ledger Filter Owner")
    await insertEntry({
      id: "1b000000-0000-4000-8000-000000000001",
      userId: owner,
      hours: 3,
      source: "event",
      createdAt: "2026-05-02T12:00:00.000Z",
    })
    await insertEntry({
      id: "1b000000-0000-4000-8000-000000000002",
      userId: owner,
      hours: 0.1,
      source: "report",
      createdAt: "2026-05-03T12:00:00.000Z",
    })
    await insertEntry({
      id: "1b000000-0000-4000-8000-000000000003",
      userId: owner,
      hours: 9,
      source: "event",
      createdAt: "2026-05-04T12:00:00.000Z",
      voided: true,
    })
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const all = await repo.listEntries({ userId: owner, cursor: null, limit: 50 })
    expect(all.items.map((e) => e.source)).toEqual(["event"])

    const eventsOnly = await repo.listEntries({
      userId: owner,
      cursor: null,
      limit: 50,
      sources: ["event"],
    })
    expect(eventsOnly.items.map((e) => e.hours)).toEqual([3])

    const reportsOnly = await repo.listEntries({
      userId: owner,
      cursor: null,
      limit: 50,
      sources: ["report"],
    })
    expect(reportsOnly.items.map((e) => e.hours)).toEqual([0.1])
  })

  it("entriesForCertificate excludes report rows from BOTH the items and the count", async () => {
    const owner = await newUser("Certificate Ledger Owner")
    await insertEntry({
      id: "1d000000-0000-4000-8000-000000000001",
      userId: owner,
      hours: 2.5,
      source: "event",
      createdAt: "2026-05-10T12:00:00.000Z",
    })
    await insertEntry({
      id: "1d000000-0000-4000-8000-000000000002",
      userId: owner,
      hours: 0.1,
      source: "report",
      createdAt: "2026-05-11T12:00:00.000Z",
      reportId: await newReport(owner),
    })
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const page = await repo.entriesForCertificate({
      userId: owner,
      geoid: null,
      from: null,
      to: null,
      limit: 50,
    })
    expect(page.items.map((e) => e.source)).toEqual(["event"])
    expect(page.entryCount).toBe(1)
    expect(page.totalHours).toBe(2.5)
  })

  it("listEntries joins out the event title, reference code, jurisdiction name and creditedBy", async () => {
    const host = await newUser("Ledger Host")
    const alice = await newUser("Ledger Alice")
    await h.sql`UPDATE users SET handle = 'ledgerhost' WHERE id = ${host}`
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, reference_code, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${cleanupId}, ${host}, 'site', 'Ocean Beach sweep', 'EVENT-LA-000999',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        '2026-04-10T17:00:00.000Z'::timestamptz, 'done', ${GEOID}
      )
    `
    await insertEntry({
      id: "1c000000-0000-4000-8000-000000000001",
      userId: alice,
      hours: 2.5,
      source: "event",
      createdAt: "2026-04-11T09:00:00.000Z",
      cleanupId,
      geoid: GEOID,
      loggedBy: host,
    })
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const page = await repo.listEntries({ userId: alice, cursor: null, limit: 10 })
    const row = page.items[0]!
    expect(row.cleanupTitle).toBe("Ocean Beach sweep")
    expect(row.cleanupReferenceCode).toBe("EVENT-LA-000999")
    expect(row.jurisdictionName).toBe(LA_CITY.name)
    expect(row.occurredAt.toISOString()).toBe("2026-04-10T17:00:00.000Z")
    expect(row.createdAt.toISOString()).toBe("2026-04-11T09:00:00.000Z")
    expect(row.creditedBy).toEqual({
      id: host,
      name: "Ledger Host",
      handle: "ledgerhost",
      organization: null,
    })
  })

  it("C18: the leaderboard excludes FALSE, includes NULL and TRUE, and skips tombstones", async () => {
    const geoid = LA_COUNTY.geoid
    const neverChose = await newUserWithFlag("Board Null", null)
    const optedIn = await newUserWithFlag("Board True", true)
    const optedOut = await newUserWithFlag("Board False", false)
    const gone = await newUserWithFlag("Board Deleted", null)
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${gone}`

    for (const [userId, hours] of [
      [neverChose, 6],
      [optedIn, 4],
      [optedOut, 99],
      [gone, 50],
    ] as const) {
      await h.sql`
        INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
        VALUES (${userId}, ${geoid}, ${hours})
      `
    }
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const page = await repo.leaderboard(geoid, 25, 0, null, true)
    expect(page.entries.map((e) => e.userId)).toEqual([neverChose, optedIn])
    expect(page.entries.map((e) => e.rank)).toEqual([1, 2])
    const [raw] = await h.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM user_jurisdiction_hours ujh JOIN users u ON u.id = ujh.user_id
      WHERE ujh.jurisdiction_geoid = ${geoid} AND ujh.total_hours > 0
        AND u.deleted_at IS NULL AND u.show_volunteer_hours IS NOT FALSE
    `
    expect(page.participantCount).toBe(raw!.count)
    expect(page.participantCount).toBe(2)

    const hiddenViewer = await repo.leaderboard(geoid, 25, 0, optedOut, true)
    expect(hiddenViewer.viewerRank).toBeNull()
    expect(hiddenViewer.viewerHours).toBeNull()
  })

  it("B48: viewerRank is the count of strictly-greater totals + 1, so a tie shares a rank", async () => {
    const geoid = CALIFORNIA.geoid
    const top = await newUser("Rank Top")
    const tieA = await newUser("Rank Tie A")
    const tieB = await newUser("Rank Tie B")
    for (const [userId, hours] of [
      [top, 10],
      [tieA, 5],
      [tieB, 5],
    ] as const) {
      await h.sql`
        INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
        VALUES (${userId}, ${geoid}, ${hours})
      `
    }
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const asTieA = await repo.leaderboard(geoid, 25, 0, tieA, true)
    const asTieB = await repo.leaderboard(geoid, 25, 0, tieB, true)
    expect(asTieA.viewerRank).toBe(2)
    expect(asTieB.viewerRank).toBe(2)
    expect(asTieA.viewerHours).toBe(5)
    expect(asTieA.entries.map((e) => e.rank)).toEqual([1, 2, 3])

    const asTop = await repo.leaderboard(geoid, 25, 0, top, true)
    expect(asTop.viewerRank).toBe(1)

    const preview = await repo.leaderboard(geoid, 3, 0, tieA, false)
    expect(preview.participantCount).toBeNull()
    expect(preview.viewerRank).toBeNull()

    const deep = await repo.leaderboard(geoid, 25, 25, tieA, true)
    expect(deep.participantCount).toBeNull()
    expect(deep.viewerRank).toBe(2)
  })

  it("C18: hoursVisibilityFor resolves all three states, a tombstone and an unknown id", async () => {
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    const neverChose = await newUserWithFlag("Vis Null", null)
    const optedIn = await newUserWithFlag("Vis True", true)
    const optedOut = await newUserWithFlag("Vis False", false)
    const gone = await newUserWithFlag("Vis Deleted", true)
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${gone}`

    expect(await repo.hoursVisibilityFor(neverChose)).toEqual({ aggregate: true, items: false })
    expect(await repo.hoursVisibilityFor(optedIn)).toEqual({ aggregate: true, items: true })
    expect(await repo.hoursVisibilityFor(optedOut)).toEqual({ aggregate: false, items: false })
    expect(await repo.hoursVisibilityFor(gone)).toEqual({ aggregate: false, items: false })
    expect(await repo.hoursVisibilityFor(randomUUID())).toEqual({
      aggregate: false,
      items: false,
    })
  })

  it("C10: listEventHours scopes by user and reports anyLogged independently of the filter", async () => {
    const org = await newUser("EventHours Org")
    const alice = await newUser("EventHours Alice")
    const dave = await newUser("EventHours Dave")
    const cleanupId = await newCleanup(org)
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const before = await repo.listEventHours(cleanupId, dave)
    expect(before.entries).toEqual([])
    expect(before.anyLogged).toBe(false)

    await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [
        { userId: alice, hours: 2 },
        { userId: org, hours: 1 },
      ],
    })

    const all = await repo.listEventHours(cleanupId, null)
    expect(all.entries.map((e) => e.userId).sort()).toEqual([alice, org].sort())
    expect(all.anyLogged).toBe(true)
    expect(all.entries[0]!.loggedAt).toBeInstanceOf(Date)

    const mine = await repo.listEventHours(cleanupId, alice)
    expect(mine.entries.map((e) => [e.userId, e.hours])).toEqual([[alice, 2]])

    const uncredited = await repo.listEventHours(cleanupId, dave)
    expect(uncredited.entries).toEqual([])
    expect(uncredited.anyLogged).toBe(true)
  })

  it("the public projection is aggregate-visible for NULL, itemised for TRUE, empty-identical for FALSE", async () => {
    const geoid = GEOID
    const host = await newUser("Public Host")
    const cleanupId = await newCleanup(host)

    async function seedHolder(flag: boolean | null, name: string): Promise<string> {
      const id = await newUserWithFlag(name, flag)
      await h.sql`
        INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
        VALUES (${id}, 3, 'event', ${cleanupId}, ${geoid}, ${host})
      `
      await h.sql`
        INSERT INTO volunteer_hours (user_id, hours, source, report_id, jurisdiction_geoid)
        VALUES (${id}, 0.1, 'report', ${await newReport(id)}, ${geoid})
      `
      await h.sql`
        INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
        VALUES (${id}, ${geoid}, 3.1)
      `
      return id
    }

    const repo = makeDrizzleVolunteerHoursRepository(h.sql)
    const service = makeVolunteerHoursService({
      repo,
      cleanups: {
        load: () => Promise.resolve(null),
        listMemberIds: () => Promise.resolve([]),
        roleOf: () => Promise.resolve(null),
      },
    })
    const viewer = await newUser("Public Viewer")

    const nullUser = await seedHolder(null, "Public Null")
    const nullRes = await service.getPublicHours({ id: nullUser }, viewer)
    expect(nullRes.visible).toBe(true)
    expect(nullRes.totalHours).toBe(3.1)
    expect(nullRes.reportHours).toBe(0)
    expect(nullRes.items).toEqual([])
    expect(nullRes.nextCursor).toBeNull()

    const trueUser = await seedHolder(true, "Public True")
    const trueRes = await service.getPublicHours({ id: trueUser }, viewer)
    expect(trueRes.visible).toBe(true)
    expect(trueRes.items.map((e) => e.source)).toEqual(["event"])
    expect(trueRes.items[0]?.creditedBy?.id).toBe(host)
    expect(trueRes.reportHours).toBe(0)

    const falseUser = await seedHolder(false, "Public False")
    const falseRes = await service.getPublicHours({ id: falseUser }, viewer)
    expect(falseRes).toEqual({
      visible: true,
      totalHours: 0,
      byJurisdiction: [],
      items: [],
      reportHours: 0,
      nextCursor: null,
    })
    const selfRes = await service.getPublicHours({ id: falseUser }, falseUser)
    expect(selfRes.visible).toBe(true)
    expect(selfRes.items.map((e) => e.source)).toEqual(["event"])
  })

  async function newReport(reporterId: string): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility,
        h3_cell, jurisdiction_geoid
      )
      VALUES (
        ${reporterId}, ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'device',
        'trash', 'published', 'public',
        '8a2a1072b59ffff', ${GEOID}
      )
      RETURNING id
    `
    return r!.id
  }
})
