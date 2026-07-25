import { afterAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleUserActivityRepository } from "../../src/services/user-activity-repository.drizzle.js"

/**
 * UserActivity repository (Docker-gated). Verifies the keyset UNION's server-rendered, verb-phrased
 * titles ("Reported X" / "Hosted X" / "Joined X" / "Followed X") AND that private messaging never leaks:
 * a cleanup/group-chat message by the subject must NOT produce an activity row (the 'commented_event'
 * leg was removed; DMs were never included). Skips when Docker is unavailable; CI runs it.
 */

const pg = await withPg()

async function insertUser(h: PgHarness, name: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name) VALUES (${name}) RETURNING id
  `
  return rows[0]!.id
}

async function insertReport(h: PgHarness, reporterId: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (
      reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell,
      jurisdiction_geoid, created_at, published_at
    )
    VALUES (
      ${reporterId}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual',
      'trash', 'published', 'public', 'h0', ${null}, ${new Date()}, ${null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertCleanup(h: PgHarness, organizerId: string, title: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO cleanups (organizer_user_id, type, title, geom, scheduled_at, status)
    VALUES (
      ${organizerId}, 'site', ${title},
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), ${new Date()}, 'upcoming'
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("user activity repository (verb-phrased titles + chat excluded)", () => {
  // Release this file's pools + drop its database (the shared container itself is globalSetup's).
  afterAll(async () => {
    await pg?.teardown()
  })

  it("renders 'Reported/Hosted/Joined/Followed X' titles and omits group-chat posts", async () => {
    const h = pg!
    const subject = await insertUser(h, "Subject")
    const organizer = await insertUser(h, "Organizer")
    const followee = await insertUser(h, "Casey Rivers")

    await insertReport(h, subject) // -> "Reported trash"
    await insertCleanup(h, subject, "Beach Cleanup") // -> "Hosted Beach Cleanup"
    const joined = await insertCleanup(h, organizer, "Park Day") // subject joins -> "Joined Park Day"
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${joined}, ${subject}, 'attendee')
    `
    await h.sql`
      INSERT INTO follows_people (follower_id, followee_id, created_at)
      VALUES (${subject}, ${followee}, ${new Date()})
    `
    // A group-chat message by the subject — must NOT surface as activity.
    await h.sql`
      INSERT INTO chat_messages (id, cleanup_id, sender_id, kind, body, created_at)
      VALUES (gen_random_uuid(), ${joined}, ${subject}, 'text', 'see you there', ${new Date()})
    `

    const repo = makeDrizzleUserActivityRepository(h.sql)
    const items = await repo.listActivity({ userId: subject, cursor: null, limit: 50 })

    const titleFor = (kind: string) => items.find((i) => i.kind === kind)?.title ?? null
    expect(titleFor("created_report")).toMatch(/^Reported /)
    expect(titleFor("hosted_event")).toBe("Hosted Beach Cleanup")
    expect(titleFor("attended_event")).toBe("Joined Park Day")
    expect(titleFor("followed_user")).toBe("Followed Casey Rivers")

    // Private/group messaging never appears in activity.
    expect(items.some((i) => i.kind === "commented_event")).toBe(false)
  })
})
