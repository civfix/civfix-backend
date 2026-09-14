import type { BroadcastKind } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
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

  it("honours host_broadcasts=false for HOST-COMPOSED kinds only", async () => {
    const userId = await newUser("OptedOut")
    await register(userId)
    await h.sql`
      INSERT INTO notification_prefs (user_id, host_broadcasts) VALUES (${userId}, false)
      ON CONFLICT (user_id) DO UPDATE SET host_broadcasts = false`

    async function membersFor(kind: BroadcastKind): Promise<string[]> {
      const page = await repo.audiencePage({
        cleanupId,
        segment: { kind: "all_registered" },
        kind,
        afterMember: null,
        afterGuest: null,
        limit: 1000,
      })
      return page.members
    }

    for (const kind of ["host_broadcast", "thank_you"] as const) {
      expect(await membersFor(kind), kind).not.toContain(userId)
    }
    for (const kind of [
      "reminder",
      "confirmation",
      "waitlist_promoted",
      "event_updated",
      "event_cancelled",
    ] as const) {
      expect(await membersFor(kind), kind).toContain(userId)
    }
  })

  it("honours an event unsubscribe and a per-event mute for bulk only", async () => {
    const unsubscribed = await newUser("Unsub")
    const muted = await newUser("Muted")
    await register(unsubscribed)
    await register(muted)
    await repo.recordUnsubscribe({
      scope: "event",
      cleanupId,
      subjectKind: "user",
      subjectId: unsubscribed,
      reason: "one_click",
    })
    await repo.setEventMute(cleanupId, muted, true)
    const bulk = await audience(false)
    expect(bulk.members).not.toContain(unsubscribed)
    expect(bulk.members).not.toContain(muted)
    const critical = await audience(true)
    expect(critical.members).toContain(unsubscribed)
    expect(critical.members).toContain(muted)
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
