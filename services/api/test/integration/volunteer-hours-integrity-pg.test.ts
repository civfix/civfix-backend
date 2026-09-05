
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { DAILY_HOURS_CAP } from "../../src/services/volunteer-hours-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid

const pg = await withPg()

describe.skipIf(!pg)("H9: volunteer-hours integrity bounds (integration)", () => {
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
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (
        id, organizer_user_id, type, title, geom, scheduled_at, completed_at, status, jurisdiction_geoid
      )
      VALUES (
        ${id}, ${organizerId}, 'site', 'Integrity sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${scheduledAt}::timestamptz,
        ${scheduledAt}::timestamptz + interval '4 hours',
        'done', ${GEOID}
      )
    `
    return id
  }

  it("caps one attendee at the daily limit across two events on the SAME UTC day", async () => {
    const org = await newUser("Cap Org")
    const alice = await newUser("Cap Alice")
    const morning = await newDoneCleanup(org, "2026-07-04T06:00:00Z")
    const evening = await newDoneCleanup(org, "2026-07-04T18:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: org,
      cleanupId: morning,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 20 }],
    })

    await expect(
      repo.logEventHours({
        actorId: org,
        cleanupId: evening,
        geoid: GEOID,
        entries: [{ userId: alice, hours: 5 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    const credited = await repo.logEventHours({
      actorId: org,
      cleanupId: evening,
      geoid: GEOID,
      entries: [{ userId: alice, hours: DAILY_HOURS_CAP - 20 }],
    })
    expect(credited.credited).toBe(1)
  })

  it("does not carry the daily cap across UTC days", async () => {
    const org = await newUser("Day Org")
    const alice = await newUser("Day Alice")
    const day1 = await newDoneCleanup(org, "2026-08-04T06:00:00Z")
    const day2 = await newDoneCleanup(org, "2026-08-05T06:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: org,
      cleanupId: day1,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 20 }],
    })
    const second = await repo.logEventHours({
      actorId: org,
      cleanupId: day2,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 20 }],
    })
    expect(second.credited).toBe(1)
  })

  it("refuses a host crediting someone who already credited THEM for the same event", async () => {
    const org = await newUser("Swap Org")
    const cohost = await newUser("Swap Cohost")
    const cleanupId = await newDoneCleanup(org, "2026-09-04T06:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: cohost,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: org, hours: 4 }],
    })

    await expect(
      repo.logEventHours({
        actorId: org,
        cleanupId,
        geoid: GEOID,
        entries: [{ userId: cohost, hours: 4 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("still allows a host to re-credit THEMSELF (a self-credit is not a reciprocal pair)", async () => {
    const org = await newUser("Self Org")
    const cleanupId = await newDoneCleanup(org, "2026-09-05T06:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: org, hours: 1 }],
    })
    const relog = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: org, hours: 3 }],
    })
    expect(relog.credited).toBe(1)
  })

  it("reports the rolling-window signal, computed AFTER the row it is about is written", async () => {
    const org = await newUser("Flag Org")
    const alice = await newUser("Flag Alice")
    const cleanupId = await newDoneCleanup(org, "2026-10-04T06:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    const result = await repo.logEventHours({
      actorId: org,
      cleanupId,
      geoid: GEOID,
      entries: [{ userId: alice, hours: 8 }],
      weeklyFlagHours: 5,
    })
    expect(result.anomalies).toEqual([
      { kind: "weekly_hours", userId: alice, counterpartUserId: null, hours: 8 },
    ])
  })

  it("reports a reciprocal swap across two events inside the lookback window", async () => {
    const org = await newUser("Recip Org")
    const other = await newUser("Recip Other")
    const first = await newDoneCleanup(other, "2026-11-04T06:00:00Z")
    const second = await newDoneCleanup(org, "2026-11-06T06:00:00Z")
    const repo = makeDrizzleVolunteerHoursRepository(h.sql)

    await repo.logEventHours({
      actorId: other,
      cleanupId: first,
      geoid: GEOID,
      entries: [{ userId: org, hours: 6 }],
    })
    const back = await repo.logEventHours({
      actorId: org,
      cleanupId: second,
      geoid: GEOID,
      entries: [{ userId: other, hours: 6 }],
    })
    expect(back.anomalies).toContainEqual({
      kind: "reciprocal_credit",
      userId: other,
      counterpartUserId: org,
      hours: null,
    })
  })

  it("stamps completed_at when an event is completed, and refuses completion before the minimum window", async () => {
    const { makeDrizzleCleanupRepository } = await import(
      "../../src/services/cleanup-repository.drizzle.js"
    )
    const { MIN_EVENT_DURATION_MS } = await import("../../src/services/cleanup-rules.js")
    const org = await newUser("Complete Org")
    const repo = makeDrizzleCleanupRepository(h.sql)

    const id = randomUUID()
    const scheduledAt = new Date()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${org}, 'site', 'Timing sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${scheduledAt}, 'upcoming'
      )
    `

    const tooSoon = await repo.completeCleanupTx(id, {
      note: "done",
      actorId: org,
      now: new Date(scheduledAt.getTime() + MIN_EVENT_DURATION_MS / 2),
    })
    expect(tooSoon).toBe("too_early")

    const completedAt = new Date(scheduledAt.getTime() + MIN_EVENT_DURATION_MS * 2)
    const outcome = await repo.completeCleanupTx(id, {
      note: "done",
      actorId: org,
      now: completedAt,
    })
    expect(outcome).toBe("completed")

    const [row] = await h.sql<{ completed_at: Date | null }[]>`
      SELECT completed_at FROM cleanups WHERE id = ${id}
    `
    expect(row!.completed_at?.toISOString()).toBe(completedAt.toISOString())
  })
})
