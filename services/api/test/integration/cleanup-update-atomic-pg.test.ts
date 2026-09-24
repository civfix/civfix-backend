import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  MAX_EVENTS_PER_REPORT,
  makeDrizzleCleanupRepository,
} from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository, DesiredSlot } from "../../src/services/cleanup-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const DAY_MS = 86_400_000

describe.skipIf(!pg)("an event edit commits whole or not at all (integration)", () => {
  let h: PgHarness
  let repo: CleanupRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleCleanupRepository(h.sql)
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

  async function newCleanup(organizerId: string, title: string, startsInMs = 2 * DAY_MS) {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title,
      lng: -118.25,
      lat: 34.05,
      scheduledAt: new Date(Date.now() + startsInMs),
      jurisdictionGeoid: LA_CITY.geoid,
    })
  }

  async function newPublicReport(title: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, title, status, visibility, h3_cell, jurisdiction_geoid
      )
      VALUES (
        gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', ${title},
        'published', 'public', 'h0', ${LA_CITY.geoid}
      )
      RETURNING id
    `
    return row!.id
  }

  async function titleOf(cleanupId: string): Promise<string> {
    const [row] = await h.sql<
      { title: string }[]
    >`SELECT title FROM cleanups WHERE id = ${cleanupId}`
    return row!.title
  }

  function newSlot(title: string): DesiredSlot {
    return {
      title,
      description: null,
      capacity: null,
      startsAt: null,
      endsAt: null,
      sortOrder: 0,
    }
  }

  it("keeps the title when the link cap refuses the same save", async () => {
    const org = await newUser("Atomic Org")
    const cleanupId = await newCleanup(org, "Atomic sweep")
    const saturated = await newPublicReport("Linked everywhere")
    for (let i = 0; i < MAX_EVENTS_PER_REPORT; i += 1) {
      const other = await newCleanup(org, `Other sweep ${i}`)
      await h.sql`
        INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
        VALUES (${other}, ${saturated}, ${org})
      `
    }

    await expect(
      repo.updateCleanupWithEdits(
        cleanupId,
        { title: "Renamed" },
        { actorUserId: org, links: [saturated], slots: null, refusalOnceEnded: null },
      ),
    ).rejects.toMatchObject({ httpStatus: 422 })

    expect(await titleOf(cleanupId)).toBe("Atomic sweep")
    const linked = await h.sql`SELECT 1 FROM cleanup_reports WHERE cleanup_id = ${cleanupId}`
    expect(linked).toHaveLength(0)
  })

  it("rolls the title and the links back when the slot board hits the title index", async () => {
    const org = await newUser("Slot Org")
    const cleanupId = await newCleanup(org, "Slot sweep")
    const report = await newPublicReport("Fresh link")

    await expect(
      repo.updateCleanupWithEdits(
        cleanupId,
        { title: "Renamed" },
        {
          actorUserId: org,
          links: [report],
          slots: [newSlot("Grill"), newSlot("GRILL")],
          refusalOnceEnded: null,
        },
      ),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { slots: "duplicate slot title" } })

    expect(await titleOf(cleanupId)).toBe("Slot sweep")
    const linked = await h.sql`SELECT 1 FROM cleanup_reports WHERE cleanup_id = ${cleanupId}`
    expect(linked).toHaveLength(0)
  })

  it("applies the title, the link and the slot together when nothing refuses", async () => {
    const org = await newUser("Happy Org")
    const cleanupId = await newCleanup(org, "Happy sweep")
    const report = await newPublicReport("Happy link")

    const outcome = await repo.updateCleanupWithEdits(
      cleanupId,
      { title: "Renamed" },
      { actorUserId: org, links: [report], slots: [newSlot("Grill")], refusalOnceEnded: null },
    )

    expect(outcome.kind).toBe("updated")
    expect(await titleOf(cleanupId)).toBe("Renamed")
    const slots = await h.sql<{ title: string }[]>`
      SELECT title FROM cleanup_slots WHERE cleanup_id = ${cleanupId}
    `
    expect(slots.map((s) => s.title)).toEqual(["Grill"])
  })

  it("reports a cancelled event without writing to it", async () => {
    const org = await newUser("Cancelled Org")
    const cleanupId = await newCleanup(org, "Cancelled sweep")
    await h.sql`UPDATE cleanups SET status = 'cancelled' WHERE id = ${cleanupId}`

    const outcome = await repo.updateCleanupWithEdits(
      cleanupId,
      { title: "Renamed" },
      { actorUserId: org, links: null, slots: null, refusalOnceEnded: null },
    )

    expect(outcome).toEqual({ kind: "cancelled" })
    expect(await titleOf(cleanupId)).toBe("Cancelled sweep")
  })

  it("throws the caller's refusal for an event that has already ended", async () => {
    const org = await newUser("Ended Org")
    const cleanupId = await newCleanup(org, "Ended sweep", -2 * DAY_MS)
    const refusal = AppError.conflict("ended")

    await expect(
      repo.updateCleanupWithEdits(
        cleanupId,
        { title: "Renamed" },
        { actorUserId: org, links: null, slots: null, refusalOnceEnded: refusal },
      ),
    ).rejects.toBe(refusal)

    expect(await titleOf(cleanupId)).toBe("Ended sweep")
  })
})
