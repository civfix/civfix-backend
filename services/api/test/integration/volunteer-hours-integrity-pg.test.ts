
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
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
    const startsAt = new Date(scheduledAt)
    const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60 * 1000)
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Integrity sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: startsAt,
      endsAt,
      completedAt: endsAt,
      status: "done",
      jurisdictionGeoid: GEOID,
    })
  }

  it("caps one attendee at the daily limit across two events on the SAME local day", async () => {
    const org = await newUser("Cap Org")
    const alice = await newUser("Cap Alice")
    const morning = await newDoneCleanup(org, "2026-07-04T17:00:00Z")
    const evening = await newDoneCleanup(org, "2026-07-05T01:00:00Z")
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

  it("does not carry the daily cap across local days", async () => {
    const org = await newUser("Day Org")
    const alice = await newUser("Day Alice")
    const day1 = await newDoneCleanup(org, "2026-08-04T17:00:00Z")
    const day2 = await newDoneCleanup(org, "2026-08-05T17:00:00Z")
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

  it("keeps a legacy completed_at as the hours window and falls back to ends_at without one", async () => {
    const { creditableHoursForEvent } = await import("../../src/services/volunteer-hours-service.js")
    const org = await newUser("Window Org")

    const legacyId = randomUUID()
    const scheduledAt = new Date(Date.now() - 6 * 60 * 60 * 1000)
    const endsAt = new Date(scheduledAt.getTime() + 4 * 60 * 60 * 1000)
    const completedAt = new Date(scheduledAt.getTime() + 2 * 60 * 60 * 1000)
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, ends_at, status, completed_at)
      VALUES (
        ${legacyId}, ${org}, 'site', 'Legacy window',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${scheduledAt}, ${endsAt}, 'upcoming', ${completedAt}
      )
    `
    const plainId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, ends_at, status)
      VALUES (
        ${plainId}, ${org}, 'site', 'Plain window',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        ${scheduledAt}, ${endsAt}, 'upcoming'
      )
    `

    const rows = await h.sql<{ id: string; scheduled_at: Date; ends_at: Date; completed_at: Date | null }[]>`
      SELECT id, scheduled_at, ends_at, completed_at FROM cleanups
      WHERE id IN (${legacyId}, ${plainId})
    `
    const byId = new Map(rows.map((r) => [r.id, r]))
    const legacy = byId.get(legacyId)!
    const plain = byId.get(plainId)!

    expect(
      creditableHoursForEvent({
        scheduledAt: legacy.scheduled_at,
        endsAt: legacy.ends_at,
        completedAt: legacy.completed_at,
      }),
    ).toBe(3)
    expect(
      creditableHoursForEvent({
        scheduledAt: plain.scheduled_at,
        endsAt: plain.ends_at,
        completedAt: plain.completed_at,
      }),
    ).toBe(5)
  })
})
