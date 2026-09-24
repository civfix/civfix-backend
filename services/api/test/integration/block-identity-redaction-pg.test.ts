import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { HIDDEN_USER_LABEL } from "../../src/services/hidden-identity.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const GEOID = LA_CITY.geoid

const BOTH_BLOCK_DIRECTIONS = ["viewer-blocked-other", "other-blocked-viewer"] as const

const pg = await withPg()

describe.skipIf(!pg)("block identity redaction (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, bio, avatar_url)
      VALUES (${name}, ${testHandle()}, ${`${name} bio`}, ${`https://cdn.example/${name}.jpg`})
      RETURNING id
    `
    return u!.id
  }

  async function block(blockerId: string, blockedId: string): Promise<void> {
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${blockerId}, ${blockedId})`
  }

  async function unblock(blockerId: string, blockedId: string): Promise<void> {
    await h.sql`DELETE FROM user_blocks WHERE blocker_id = ${blockerId} AND blocked_id = ${blockedId}`
  }

  async function withBlockDirection(
    direction: (typeof BOTH_BLOCK_DIRECTIONS)[number],
    viewer: string,
    other: string,
    assertions: () => Promise<void>,
  ): Promise<void> {
    const [blocker, blocked] =
      direction === "viewer-blocked-other" ? [viewer, other] : [other, viewer]
    await block(blocker, blocked)
    try {
      await assertions()
    } finally {
      await unblock(blocker, blocked)
    }
  }

  async function creditHours(userId: string, hours: number): Promise<void> {
    await h.sql`
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      VALUES (${userId}, ${GEOID}, ${hours})
    `
  }

  async function newCleanup(organizerId: string): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Redaction sweep",
      lng: -118.25,
      lat: 34.05,
    })
  }

  async function joinCleanup(cleanupId: string, userId: string, role: string): Promise<void> {
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${userId}, ${role})
    `
  }

  async function newReport(reporterId: string): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell
      )
      VALUES (
        ${reporterId}, gen_random_uuid(),
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        'manual', 'trash', 'published', 'public', 'h0'
      )
      RETURNING id
    `
    return r!.id
  }

  async function joinReportChat(reportId: string, userId: string, role: string): Promise<void> {
    await h.sql`
      INSERT INTO report_chat_members (report_id, user_id, role)
      VALUES (${reportId}, ${userId}, ${role})
    `
  }

  async function newGroup(ownerId: string, memberIds: string[]): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, kind, visibility)
      VALUES ('Redaction room', ${ownerId}, 'group', 'private')
      RETURNING id
    `
    const groupId = g!.id
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${ownerId}, 'owner')
    `
    for (const id of memberIds) {
      await h.sql`
        INSERT INTO chat_group_members (group_id, user_id, role) VALUES (${groupId}, ${id}, 'member')
      `
    }
    return groupId
  }

  describe("jurisdiction leaderboard (CVX-031)", () => {
    it("keeps rank + hours but hides WHO, in BOTH directions, never the viewer's own row", async () => {
      const viewer = await newUser("BoardViewer")
      const other = await newUser("BoardOther")
      await creditHours(other, 40)
      await creditHours(viewer, 20)
      const repo = makeDrizzleVolunteerHoursRepository(h.sql)

      const open = await repo.leaderboard(GEOID, 20, 0, viewer, true)
      const openOther = open.entries.find((e) => e.userId === other)!
      expect(openOther.name).toBe("BoardOther")
      expect(openOther.rank).toBe(1)
      expect(openOther.handle).not.toBeUndefined()

      for (const direction of BOTH_BLOCK_DIRECTIONS) {
        await withBlockDirection(direction, viewer, other, async () => {
          const page = await repo.leaderboard(GEOID, 20, 0, viewer, true)
          expect(page.entries).toHaveLength(2)

          const redacted = page.entries.find((e) => e.userId === other)!
          expect(redacted.rank).toBe(1)
          expect(redacted.hours).toBe(40)
          expect(redacted.name).toBe(HIDDEN_USER_LABEL)
          expect(redacted.handle).toBeUndefined()
          expect(redacted.avatarUrl).toBeUndefined()

          const mine = page.entries.find((e) => e.userId === viewer)!
          expect(mine.name).toBe("BoardViewer")
          expect(mine.rank).toBe(2)
          expect(mine.hours).toBe(20)
          expect(page.viewerRank).toBe(2)
          expect(page.viewerHours).toBe(20)
          expect(page.participantCount).toBe(2)
        })
      }
    })

    it("an ANONYMOUS read redacts nobody (there is no viewer to have blocked anyone)", async () => {
      const one = await newUser("AnonOne")
      const two = await newUser("AnonTwo")
      await creditHours(one, 9)
      await creditHours(two, 8)
      await block(one, two)

      const page = await makeDrizzleVolunteerHoursRepository(h.sql).leaderboard(
        GEOID,
        50,
        0,
        null,
        false,
      )
      expect(page.entries.map((e) => e.userId)).toEqual(expect.arrayContaining([one, two]))
      expect(page.entries.every((e) => e.name !== HIDDEN_USER_LABEL)).toBe(true)
    })
  })

  describe("event attendee roster (CVX-034)", () => {
    it("redacts a blocked attendee in BOTH directions and keeps the roster complete", async () => {
      const organizer = await newUser("RosterOrg")
      const viewer = await newUser("RosterViewer")
      const other = await newUser("RosterOther")
      const cleanupId = await newCleanup(organizer)
      await joinCleanup(cleanupId, organizer, "organizer")
      await joinCleanup(cleanupId, viewer, "member")
      await joinCleanup(cleanupId, other, "member")
      const repo = makeDrizzleCleanupRepository(h.sql)
      const args = { cleanupId, viewerId: viewer, onlyFollowed: false, limit: 50 }

      const open = await repo.listAttendees(args)
      expect(open).toHaveLength(3)
      expect(open.find((a) => a.id === other)!.displayName).toBe("RosterOther")
      expect(open.find((a) => a.id === other)!.avatarUrl).toBe(
        "https://cdn.example/RosterOther.jpg",
      )

      for (const direction of BOTH_BLOCK_DIRECTIONS) {
        await withBlockDirection(direction, viewer, other, async () => {
          const roster = await repo.listAttendees(args)
          expect(roster).toHaveLength(3)

          const redacted = roster.find((a) => a.id === other)!
          expect(redacted.displayName).toBe(HIDDEN_USER_LABEL)
          expect(redacted.handle).toBeNull()
          expect(redacted.bio).toBeNull()
          expect(redacted.avatarUrl).toBeNull()
          expect(redacted.role).toBe("member")

          expect(roster.find((a) => a.id === viewer)!.displayName).toBe("RosterViewer")
          expect(roster.find((a) => a.id === organizer)!.displayName).toBe("RosterOrg")
        })
      }
    })
  })

  describe("report chat participant list (CVX-034)", () => {
    it("returns the roster with avatars and redacts a blocked participant in BOTH directions", async () => {
      const owner = await newUser("ChatOwner")
      const viewer = await newUser("ChatViewer")
      const other = await newUser("ChatOther")
      const reportId = await newReport(owner)
      await joinReportChat(reportId, owner, "owner")
      await joinReportChat(reportId, viewer, "member")
      await joinReportChat(reportId, other, "member")
      const repo = makeReportChatRepository(h.sql)

      const open = await repo.listMembers(reportId, viewer)
      expect(open).toHaveLength(3)
      expect(open[0]!.role).toBe("owner")
      const openOther = open.find((m) => m.user.id === other)!
      expect(openOther.user.name).toBe("ChatOther")
      expect(openOther.user.avatarUrl).toBe("https://cdn.example/ChatOther.jpg")

      for (const direction of BOTH_BLOCK_DIRECTIONS) {
        await withBlockDirection(direction, viewer, other, async () => {
          const roster = await repo.listMembers(reportId, viewer)
          expect(roster).toHaveLength(3)

          const redacted = roster.find((m) => m.user.id === other)!
          expect(redacted.user.name).toBe(HIDDEN_USER_LABEL)
          expect(redacted.user.handle).toBeNull()
          expect(redacted.user.bio).toBeNull()
          expect(redacted.user.avatarUrl).toBeUndefined()
          expect(redacted.role).toBe("member")

          expect(roster.find((m) => m.user.id === viewer)!.user.name).toBe("ChatViewer")
          expect(roster.find((m) => m.user.id === owner)!.user.name).toBe("ChatOwner")
        })
      }
    })
  })

  describe("chat group member list (CVX-034)", () => {
    it("redacts a blocked member in BOTH directions and keeps the member count", async () => {
      const owner = await newUser("GroupOwner")
      const viewer = await newUser("GroupViewer")
      const other = await newUser("GroupOther")
      const groupId = await newGroup(owner, [viewer, other])
      const repo = makeChatGroupRepository(h.sql)

      const open = await repo.listMembers(groupId, viewer, null, 50)
      expect(open.members).toHaveLength(3)
      const openOther = open.members.find((m) => m.user.id === other)!
      expect(openOther.user.name).toBe("GroupOther")

      for (const direction of BOTH_BLOCK_DIRECTIONS) {
        await withBlockDirection(direction, viewer, other, async () => {
          const page = await repo.listMembers(groupId, viewer, null, 50)
          expect(page.members).toHaveLength(3)

          const redacted = page.members.find((m) => m.user.id === other)!
          expect(redacted.user.name).toBe(HIDDEN_USER_LABEL)
          expect(redacted.user.handle).toBeNull()
          expect(redacted.user.bio).toBeNull()
          expect(redacted.user.avatarUrl).toBeUndefined()
          expect(redacted.user.deleted).toBeUndefined()
          expect(redacted.role).toBe("member")

          expect(page.members.find((m) => m.user.id === viewer)!.user.name).toBe("GroupViewer")
          expect(page.members.find((m) => m.user.id === owner)!.user.name).toBe("GroupOwner")
        })
      }
    })
  })
})
