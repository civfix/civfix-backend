import type { BroadcastKind, BroadcastSegment } from "@civfix/contract"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { NotificationCategorySchema } from "@civfix/contract"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { audiencePages } from "../../src/services/host/broadcast-audience.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import type { BroadcastRepository } from "../../src/services/host/broadcast-repository.js"

const pg = await withPg()

describe.skipIf(!pg)("broadcast audience resolution (integration)", () => {
  let h: PgHarness
  let repo: BroadcastRepository
  let cleanupId: string
  let organizerId: string

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleBroadcastRepository(h.sql)
    organizerId = await newUser("Host")
    cleanupId = await newCleanup(organizerId)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id`
    return row!.id
  }

  async function newCleanup(organizer: string): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizer,
      title: "Beach sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
    })
  }

  async function register(userId: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_registrations (cleanup_id, user_id, status)
      VALUES (${cleanupId}, ${userId}, 'registered') RETURNING id`
    return row!.id
  }

  async function audience(critical: boolean): Promise<{ members: string[]; guests: string[] }> {
    return repo.audiencePage({
      cleanupId,
      segment: { kind: "all_registered" },
      kind: critical ? "event_cancelled" : "host_broadcast",
      afterMember: null,
      afterGuest: null,
      limit: 1000,
    })
  }

  it("includes a registered member", async () => {
    const userId = await newUser("Member")
    await register(userId)
    expect((await audience(false)).members).toContain(userId)
  })

  it("excludes a member who is banned from the event, even for a critical kind", async () => {
    const userId = await newUser("Banned")
    await register(userId)
    await h.sql`
      INSERT INTO cleanup_bans (cleanup_id, user_id, banned_by_user_id)
      VALUES (${cleanupId}, ${userId}, ${organizerId})`
    expect((await audience(false)).members).not.toContain(userId)
    expect((await audience(true)).members).not.toContain(userId)
  })

  it("excludes a deleted account", async () => {
    const userId = await newUser("Gone")
    await register(userId)
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${userId}`
    expect((await audience(true)).members).not.toContain(userId)
  })

  it("excludes a suspended account", async () => {
    const userId = await newUser("Suspended")
    await register(userId)
    await h.sql`
      INSERT INTO user_moderation (user_id, account_status) VALUES (${userId}, 'suspended')
      ON CONFLICT (user_id) DO UPDATE SET account_status = 'suspended'`
    expect((await audience(true)).members).not.toContain(userId)
  })

  it("records a one-click unsubscribe idempotently", async () => {
    const userId = await newUser("Twice")
    await register(userId)
    for (let i = 0; i < 2; i += 1) {
      await repo.recordUnsubscribe({
        scope: "event",
        cleanupId,
        subjectKind: "user",
        subjectId: userId,
        reason: "one_click",
      })
    }
    const [row] = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM broadcast_unsubscribes
       WHERE cleanup_id = ${cleanupId} AND user_id = ${userId}`
    expect(Number(row!.n)).toBe(1)
  })

  it("includes a contactable guest and excludes cancelled or scrubbed ones", async () => {
    const contactable = await newGuest({ email: "guest1@example.test" })
    const cancelled = await newGuest({ email: "guest2@example.test", cancelled: true })
    const scrubbed = await newGuest({ email: null })
    const result = await audience(true)
    expect(result.guests).toContain(contactable)
    expect(result.guests).not.toContain(cancelled)
    expect(result.guests).not.toContain(scrubbed)
  })

  async function newGuest(opts: { email: string | null; cancelled?: boolean }): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_guests (cleanup_id, name, channel, email, manage_token_hash, cancelled_at)
      VALUES (${cleanupId}, 'Guest', 'email', ${opts.email}, ${randomUUID()},
              ${opts.cancelled === true ? new Date() : null})
      RETURNING id`
    return row!.id
  }

  it("counts the same audience the pages resolve, each side capped", async () => {
    const extraMembers = [await newUser("Count1"), await newUser("Count2")]
    for (const userId of extraMembers) await register(userId)
    await newGuest({ email: "count-guest@example.test" })
    const [ticketType] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size, waitlist_enabled)
      VALUES (${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`}, NULL, 4, true)
      RETURNING id`
    await h.sql`
      UPDATE cleanup_registrations SET ticket_type_id = ${ticketType!.id}
       WHERE cleanup_id = ${cleanupId} AND user_id = ${extraMembers[0]!}`
    const [slot] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_slots (cleanup_id, title, sort_order)
      VALUES (${cleanupId}, ${`Slot ${randomUUID().slice(0, 8)}`}, 0)
      RETURNING id`
    await h.sql`
      INSERT INTO cleanup_slot_claims (cleanup_id, user_id, slot_id)
      VALUES (${cleanupId}, ${extraMembers[1]!}, ${slot!.id})`

    const segments: BroadcastSegment[] = [
      { kind: "all_registered" },
      { kind: "guests_only" },
      { kind: "checked_in" },
      { kind: "not_checked_in" },
      { kind: "waitlist" },
      { kind: "ticket_types", ids: [ticketType!.id] },
      { kind: "slots", ids: [slot!.id] },
    ]
    for (const segment of segments) {
      for (const kind of ["host_broadcast", "event_cancelled"] as const) {
        let members = 0
        let guests = 0
        for await (const page of audiencePages(repo, { cleanupId, segment, kind })) {
          members += page.members.length
          guests += page.guests.length
        }
        for (const cap of [1, 2, 1000]) {
          const label = `${segment.kind}/${kind}/cap=${cap}`
          expect(await repo.audienceCount({ cleanupId, segment, kind, cap }), label).toBe(
            Math.min(members, cap) + Math.min(guests, cap),
          )
        }
      }
    }
  })

  describe("account holders' category settings (GH#224)", () => {
    let event: string

    async function member(name: string): Promise<string> {
      const userId = await newUser(name)
      await h.sql`
        INSERT INTO cleanup_registrations (cleanup_id, user_id, status)
        VALUES (${event}, ${userId}, 'registered')`
      return userId
    }

    async function categoryOff(userId: string, category: string): Promise<void> {
      await h.sql`
        INSERT INTO notification_settings (user_id, category, enabled, push, email)
        VALUES (${userId}, ${category}, false, false, false)`
    }

    function page(kind: BroadcastKind) {
      return repo.audiencePage({
        cleanupId: event,
        segment: { kind: "all_registered" },
        kind,
        afterMember: null,
        afterGuest: null,
        limit: 1000,
      })
    }

    async function cancellationSetup(): Promise<{ e: string; g: string }> {
      const b = await member("B")
      const c = await member("C")
      const d = await member("D")
      const e = await member("E")
      await repo.recordUnsubscribe({
        scope: "event",
        cleanupId: event,
        subjectKind: "user",
        subjectId: b,
        reason: "one_click",
      })
      await repo.setEventMute(event, c, true)
      await categoryOff(d, "events")
      const [guest] = await h.sql<{ id: string }[]>`
        INSERT INTO cleanup_guests (cleanup_id, name, channel, email, manage_token_hash)
        VALUES (${event}, 'Guest', 'email', 'g@example.test', ${randomUUID()})
        RETURNING id`
      await repo.recordUnsubscribe({
        scope: "event",
        cleanupId: event,
        subjectKind: "guest",
        subjectId: guest!.id,
        reason: "one_click",
      })
      return { e, g: guest!.id }
    }

    beforeEach(async () => {
      event = await newCleanup(organizerId)
    })

    it("T28: a cancellation honours members' unsubscribes, mutes and Events Off, not a guest's unsubscribe", async () => {
      const { e, g } = await cancellationSetup()
      expect(await page("event_cancelled")).toEqual({ members: [e], guests: [g] })
    })

    it("T29: a host broadcast reads Announcements from hosts, not the old host_broadcasts boolean", async () => {
      const b = await member("B")
      const c = await member("C")
      await categoryOff(b, "hostAnnouncements")
      await h.sql`
        INSERT INTO notification_prefs (user_id, host_broadcasts) VALUES (${c}, false)
        ON CONFLICT (user_id) DO UPDATE SET host_broadcasts = false`
      expect((await page("host_broadcast")).members).toEqual([c])
    })

    it("T30: a reminder leaves out a member with Events Off", async () => {
      const b = await member("B")
      const c = await member("C")
      await categoryOff(b, "events")
      expect((await page("reminder")).members).toEqual([c])
    })

    it("T31: a confirmation reaches a member with every category Off", async () => {
      const b = await member("B")
      for (const category of NotificationCategorySchema.options) await categoryOff(b, category)
      expect((await page("confirmation")).members).toEqual([b])
    })

    it("T32: the count matches the T28 audience", async () => {
      await cancellationSetup()
      expect(
        await repo.audienceCount({
          cleanupId: event,
          segment: { kind: "all_registered" },
          kind: "event_cancelled",
          cap: 1000,
        }),
      ).toBe(2)
    })
  })

  it("suppresses an email hash and reads it back", async () => {
    const hash = "a".repeat(64)
    expect(await repo.isEmailSuppressed(hash)).toBe(false)
    await repo.suppressEmail(hash, "hard_bounce")
    await repo.suppressEmail(hash, "hard_bounce")
    expect(await repo.isEmailSuppressed(hash)).toBe(true)
    const [row] = await h.sql<{ hits: number }[]>`
      SELECT hits FROM email_suppressions WHERE email_hash = ${hash}`
    expect(row!.hits).toBe(2)
  })
})
