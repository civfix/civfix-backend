import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleAnalyticsRepository } from "../../src/services/host/analytics-repository.drizzle.js"
import type { AnalyticsRepository } from "../../src/services/host/analytics-repository.js"

const pg = await withPg()

const DAY_MS = 86_400_000

interface SeededEvents {
  organized: string
  cohost: string
  coordinator: string
  teamStaff: string
  orgAdmin: string
  orgOwned: string
  orgMember: string
  unrelated: string
  everyRelation: string
  organizedInMemberOrg: string
}

describe.skipIf(!pg)("hostedEventIds resolves every hosting relation (integration)", () => {
  let h: PgHarness
  let analytics: AnalyticsRepository
  let host: string
  let other: string
  let orgAdmin: string
  let orgOwned: string
  let orgMember: string
  let events: SeededEvents

  async function user(name: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id`
    return row!.id
  }

  async function organization(ownerId: string): Promise<string> {
    const slug = `hosted-${randomUUID().slice(0, 8)}`
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO organizations (slug, name) VALUES (${slug}, ${slug}) RETURNING id`
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${row!.id}, ${ownerId}, 'owner')`
    return row!.id
  }

  async function event(
    organizerUserId: string,
    daysAhead: number,
    organizationId: string | null = null,
  ): Promise<string> {
    return seedCleanup(h.sql, {
      organizerUserId,
      organizationId,
      title: `Hosted ${daysAhead}`,
      scheduledAt: new Date(Date.now() + daysAhead * DAY_MS),
    })
  }

  async function teamRole(cleanupId: string, userId: string, role: string): Promise<void> {
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${userId}, ${role})`
  }

  beforeAll(async () => {
    h = pg as PgHarness
    analytics = makeDrizzleAnalyticsRepository(h.sql)
    host = await user("Host")
    other = await user("Other")

    orgAdmin = await organization(other)
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${orgAdmin}, ${host}, 'admin')`
    orgOwned = await organization(host)
    orgMember = await organization(other)
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${orgMember}, ${host}, 'member')`

    const cohost = await event(other, 2)
    await teamRole(cohost, host, "cohost")
    const coordinator = await event(other, 3)
    await teamRole(coordinator, host, "coordinator")
    const teamStaff = await event(other, 4)
    await teamRole(teamStaff, host, "staff")
    const everyRelation = await event(host, 9, orgOwned)
    await teamRole(everyRelation, host, "organizer")
    events = {
      organized: await event(host, 1),
      cohost,
      coordinator,
      teamStaff,
      orgAdmin: await event(other, 5, orgAdmin),
      orgOwned: await event(other, 6, orgOwned),
      orgMember: await event(other, 7, orgMember),
      unrelated: await event(other, 8),
      everyRelation,
      organizedInMemberOrg: await event(host, 10, orgMember),
    }
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("returns organizer, co-host, coordinator and org owner/admin events once each, newest first", async () => {
    expect(await analytics.hostedEventIds(host, null, 50)).toEqual([
      events.organizedInMemberOrg,
      events.everyRelation,
      events.orgOwned,
      events.orgAdmin,
      events.coordinator,
      events.cohost,
      events.organized,
    ])
  })

  it("leaves out a lesser team role, a plain org membership and an unrelated event", async () => {
    const ids = await analytics.hostedEventIds(host, null, 50)
    expect(ids).not.toContain(events.teamStaff)
    expect(ids).not.toContain(events.orgMember)
    expect(ids).not.toContain(events.unrelated)
  })

  it("narrows to one organization after resolving the hosting relations", async () => {
    expect(await analytics.hostedEventIds(host, orgAdmin, 50)).toEqual([events.orgAdmin])
    expect(await analytics.hostedEventIds(host, orgOwned, 50)).toEqual([
      events.everyRelation,
      events.orgOwned,
    ])
    expect(await analytics.hostedEventIds(host, orgMember, 50)).toEqual([
      events.organizedInMemberOrg,
    ])
  })

  it("applies the limit after ordering", async () => {
    expect(await analytics.hostedEventIds(host, null, 2)).toEqual([
      events.organizedInMemberOrg,
      events.everyRelation,
    ])
  })

  it("returns nothing for a user who hosts nothing", async () => {
    expect(await analytics.hostedEventIds(await user("Nobody"), null, 50)).toEqual([])
  })
})
