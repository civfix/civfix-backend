import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CleanupStatus } from "@civfix/shared"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { parseTimeCursor, type TimeCursor } from "../../src/db/cursor-helpers.js"
import { makeDrizzleGuestRsvpRepository } from "../../src/services/guest-rsvp-repository.drizzle.js"
import { makeDrizzleSocialRepository } from "../../src/services/social-repository.drizzle.js"
import type { GuestRsvpRepository } from "../../src/services/guest-rsvp-service.js"

const pg = await withPg()

describe.skipIf(!pg)("guest rsvp storage (integration)", () => {
  let h: PgHarness
  let repo: GuestRsvpRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleGuestRsvpRepository(h.sql)
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

  async function newCleanup(
    over: { status?: CleanupStatus; scheduledAt?: Date } = {},
  ): Promise<string> {
    const organizerId = await newUser("Host")
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Guest sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: over.scheduledAt ?? new Date(Date.now() + 7 * 86_400_000),
      status: over.status,
    })
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer')
    `
    return id
  }

  async function verifyGuest(
    cleanupId: string,
    email: string,
    tokenHash: string,
    name = "Ada",
  ): Promise<string> {
    const { id } = await repo.upsertVerifiedGuest({
      cleanupId,
      name,
      channel: "email",
      contactKey: email,
      email,
      phone: null,
      manageTokenHash: tokenHash,
      now: new Date(),
    })
    return id
  }

  async function guestRowCount(cleanupId: string): Promise<number> {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_guests WHERE cleanup_id = ${cleanupId}
    `
    return rows[0]!.n
  }

  it("finds the event with its coordinates, and returns null for an unknown id", async () => {
    const cleanupId = await newCleanup()

    const event = await repo.findEvent(cleanupId)
    expect(event?.title).toBe("Guest sweep")
    expect(event?.status).toBe("upcoming")
    expect(event?.lat).toBeCloseTo(34.05, 5)
    expect(event?.lng).toBeCloseTo(-118.25, 5)

    await expect(repo.findEvent(randomUUID())).resolves.toBeNull()
  })

  it("re-verifying the SAME contact rotates the token on ONE row (partial unique index)", async () => {
    const cleanupId = await newCleanup()
    const first = await verifyGuest(cleanupId, "ada@example.org", "hash-1")
    const second = await verifyGuest(cleanupId, "ada@example.org", "hash-2", "Ada L")

    expect(second).toBe(first)
    await expect(guestRowCount(cleanupId)).resolves.toBe(1)
    await expect(repo.findGuestByManageTokenHash("hash-1")).resolves.toBeNull()
    await expect(repo.findGuestByManageTokenHash("hash-2")).resolves.toMatchObject({ id: first })

    const rows = await h.sql<{ name: string }[]>`
      SELECT name FROM cleanup_guests WHERE id = ${first}
    `
    expect(rows[0]?.name).toBe("Ada L")
  })

  it("verifying AFTER a cancel inserts a fresh row rather than reviving the cancelled one", async () => {
    const cleanupId = await newCleanup()
    const first = await verifyGuest(cleanupId, "ada@example.org", "hash-a")
    await repo.cancelGuest(first, new Date())

    const second = await verifyGuest(cleanupId, "ada@example.org", "hash-b")

    expect(second).not.toBe(first)
    await expect(guestRowCount(cleanupId)).resolves.toBe(2)
    await expect(repo.countActiveGuests(cleanupId)).resolves.toBe(1)
  })

  it("keeps two different contacts on the same event as two separate guests", async () => {
    const cleanupId = await newCleanup()
    await verifyGuest(cleanupId, "ada@example.org", "h1")
    await verifyGuest(cleanupId, "grace@example.org", "h2")

    await expect(repo.countActiveGuests(cleanupId)).resolves.toBe(2)
  })

  it("cancel NULLs the contact in the same statement, and is a no-op on replay", async () => {
    const cleanupId = await newCleanup()
    const guestId = await verifyGuest(cleanupId, "ada@example.org", "h-cancel")
    const at = new Date()

    await repo.cancelGuest(guestId, at)
    const [row] = await h.sql<
      {
        email: string | null
        phone: string | null
        contact_key: string | null
        cancelled_at: Date | null
        contact_scrubbed_at: Date | null
      }[]
    >`
      SELECT email, phone, contact_key, cancelled_at, contact_scrubbed_at
      FROM cleanup_guests WHERE id = ${guestId}
    `
    expect(row?.email).toBeNull()
    expect(row?.phone).toBeNull()
    expect(row?.contact_key).toBeNull()
    expect(row?.cancelled_at).not.toBeNull()
    expect(row?.contact_scrubbed_at).not.toBeNull()

    const firstCancelledAt = row!.cancelled_at
    await repo.cancelGuest(guestId, new Date(Date.now() + 60_000))
    const [again] = await h.sql<{ cancelled_at: Date }[]>`
      SELECT cancelled_at FROM cleanup_guests WHERE id = ${guestId}
    `
    expect(again?.cancelled_at.getTime()).toBe(firstCancelledAt!.getTime())
  })

  it("computes going as members plus non-cancelled guests", async () => {
    const cleanupId = await newCleanup()
    await expect(repo.goingCount(cleanupId)).resolves.toBe(1)

    const guestId = await verifyGuest(cleanupId, "ada@example.org", "h-going")
    await verifyGuest(cleanupId, "grace@example.org", "h-going-2")
    await expect(repo.goingCount(cleanupId)).resolves.toBe(3)

    await repo.cancelGuest(guestId, new Date())
    await expect(repo.goingCount(cleanupId)).resolves.toBe(2)
    await expect(repo.countActiveGuests(cleanupId)).resolves.toBe(1)
  })

  it("profile event strips report the same going count as the event surfaces", async () => {
    const scheduledAt = new Date(Date.now() + 7 * 86_400_000)
    const cleanupId = await newCleanup({ scheduledAt })
    const [host] = await h.sql<{ organizer_user_id: string }[]>`
      SELECT organizer_user_id FROM cleanups WHERE id = ${cleanupId}
    `
    const hostId = host!.organizer_user_id

    const guestId = await verifyGuest(cleanupId, "profile-ada@example.org", "h-profile-1")
    await verifyGuest(cleanupId, "profile-grace@example.org", "h-profile-2")

    const social = makeDrizzleSocialRepository(h.sql)
    const upcoming = await social.upcomingEventsFor(hostId, { limit: 10, includeAttending: true })
    const strip = upcoming.find((r) => r.id === cleanupId)
    expect(strip).toBeDefined()
    expect(strip!.going).toBe(await repo.goingCount(cleanupId))
    expect(strip!.going).toBe(3)

    await repo.cancelGuest(guestId, new Date())
    const afterCancel = await social.upcomingEventsFor(hostId, {
      limit: 10,
      includeAttending: true,
    })
    expect(afterCancel.find((r) => r.id === cleanupId)!.going).toBe(2)

    await h.sql`UPDATE cleanups SET scheduled_at = now() - interval '2 days' WHERE id = ${cleanupId}`
    const past = await social.pastEventsPageFor(hostId, { limit: 10, cursor: null })
    expect(past.items.find((r) => r.id === cleanupId)!.going).toBe(2)
  })

  it("pages the roster newest-first with a keyset cursor, visiting every row once", async () => {
    const cleanupId = await newCleanup()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await verifyGuest(cleanupId, `guest${i}@example.org`, `page-h${i}`, `Guest ${i}`))
    }
    const base = Date.now() - 5 * 60_000
    for (const [i, id] of ids.entries()) {
      await h.sql`
        UPDATE cleanup_guests SET created_at = ${new Date(base + i * 1_000)} WHERE id = ${id}::uuid
      `
    }

    const seen: string[] = []
    let cursor: TimeCursor | null = null
    for (let page = 0; page < 5; page++) {
      const result: { rows: { id: string }[]; nextCursor: string | null } = await repo.listGuests({
        cleanupId,
        cursor,
        limit: 2,
      })
      seen.push(...result.rows.map((r) => r.id))
      cursor = parseTimeCursor(result.nextCursor, { direction: "desc" })
      if (cursor === null) break
    }

    expect(cursor).toBeNull()
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(seen[0]).toBe(ids[4])
    expect(seen[4]).toBe(ids[0])
  })

  it("lists contactable guests, skipping cancelled, scrubbed and opted-out ones", async () => {
    const cleanupId = await newCleanup()
    await verifyGuest(cleanupId, "keep@example.org", "c-keep")
    const cancelled = await verifyGuest(cleanupId, "gone@example.org", "c-gone")
    await repo.cancelGuest(cancelled, new Date())

    const { id: texted } = await repo.upsertVerifiedGuest({
      cleanupId,
      name: "Texter",
      channel: "sms",
      contactKey: "+15558887777",
      email: null,
      phone: "+15558887777",
      manageTokenHash: "c-sms",
      now: new Date(),
    })
    expect(texted).toBeTruthy()

    await expect(repo.listContactableGuests(cleanupId, 50)).resolves.toHaveLength(2)

    await repo.recordPhoneOptOut("+15558887777")
    await expect(repo.isPhoneOptedOut("+15558887777")).resolves.toBe(true)
    await repo.recordPhoneOptOut("+15558887777")

    const contactable = await repo.listContactableGuests(cleanupId, 50)
    expect(contactable).toHaveLength(1)
    expect(contactable[0]?.email).toBe("keep@example.org")
  })

  it("scrubs contact only for finished or cancelled events, in bounded batches", async () => {
    const past = await newCleanup({ scheduledAt: new Date(Date.now() - 90 * 86_400_000) })
    const upcoming = await newCleanup()
    await verifyGuest(past, "old1@example.org", "s1")
    await verifyGuest(past, "old2@example.org", "s2")
    await verifyGuest(upcoming, "fresh@example.org", "s3")

    const cutoff = new Date(Date.now() - 30 * 86_400_000)
    const firstBatch = await repo.scrubExpiredGuestContacts({
      cutoff,
      now: new Date(),
      batchSize: 1,
    })
    expect(firstBatch).toBe(1)

    const rest = await repo.scrubExpiredGuestContacts({ cutoff, now: new Date(), batchSize: 50 })
    expect(rest).toBe(1)

    await expect(
      repo.scrubExpiredGuestContacts({ cutoff, now: new Date(), batchSize: 50 }),
    ).resolves.toBe(0)

    const [fresh] = await h.sql<{ email: string | null }[]>`
      SELECT email FROM cleanup_guests WHERE manage_token_hash = 's3'
    `
    expect(fresh?.email).toBe("fresh@example.org")

    const scrubbed = await h.sql<{ email: string | null; contact_scrubbed_at: Date | null }[]>`
      SELECT email, contact_scrubbed_at FROM cleanup_guests WHERE cleanup_id = ${past}
    `
    expect(scrubbed.every((r) => r.email === null && r.contact_scrubbed_at !== null)).toBe(true)
  })

  it("runs the OTP lifecycle: latest-active wins, attempts increment, consume is single-use", async () => {
    const cleanupId = await newCleanup()
    const now = new Date()
    const later = new Date(now.getTime() + 5 * 60_000)

    await repo.insertOtp({
      cleanupId,
      channel: "email",
      contact: "ada@example.org",
      name: "Ada",
      codeHash: "stale-hash",
      expiresAt: later,
    })
    await repo.invalidateActiveOtps(cleanupId, "ada@example.org", now)
    await expect(repo.findLatestActiveOtp(cleanupId, "ada@example.org", now)).resolves.toBeNull()

    await repo.insertOtp({
      cleanupId,
      channel: "email",
      contact: "ada@example.org",
      name: "Ada",
      codeHash: "live-hash",
      expiresAt: later,
    })
    const record = await repo.findLatestActiveOtp(cleanupId, "ada@example.org", now)
    expect(record?.codeHash).toBe("live-hash")
    expect(record?.name).toBe("Ada")

    await expect(repo.incrementOtpAttempts(record!.id)).resolves.toBe(1)
    await expect(repo.incrementOtpAttempts(record!.id)).resolves.toBe(2)
    await expect(repo.markOtpConsumed(record!.id, now)).resolves.toBe(true)
    await expect(repo.markOtpConsumed(record!.id, now)).resolves.toBe(false)

    const expired = new Date(now.getTime() + 10 * 60_000)
    await repo.insertOtp({
      cleanupId,
      channel: "email",
      contact: "grace@example.org",
      name: "Grace",
      codeHash: "expired-hash",
      expiresAt: now,
    })
    await expect(
      repo.findLatestActiveOtp(cleanupId, "grace@example.org", expired),
    ).resolves.toBeNull()
  })

  it("reaps guest OTPs older than the cutoff, in bounded batches", async () => {
    const cleanupId = await newCleanup()
    for (let i = 0; i < 3; i++) {
      await repo.insertOtp({
        cleanupId,
        channel: "email",
        contact: `reap${i}@example.org`,
        name: "Reaper",
        codeHash: `reap-${i}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    }
    await h.sql`
      UPDATE guest_otps SET created_at = now() - interval '48 hours'
      WHERE cleanup_id = ${cleanupId}
    `

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await expect(repo.deleteStaleOtps({ cutoff, batchSize: 2 })).resolves.toBe(2)
    await expect(repo.deleteStaleOtps({ cutoff, batchSize: 50 })).resolves.toBe(1)
    await expect(repo.deleteStaleOtps({ cutoff, batchSize: 50 })).resolves.toBe(0)
  })

  it("cascades guests and OTPs when the event itself is deleted", async () => {
    const cleanupId = await newCleanup()
    await verifyGuest(cleanupId, "ada@example.org", "cascade-h")
    await repo.insertOtp({
      cleanupId,
      channel: "email",
      contact: "ada@example.org",
      name: "Ada",
      codeHash: "cascade-otp",
      expiresAt: new Date(Date.now() + 60_000),
    })

    await h.sql`DELETE FROM cleanup_members WHERE cleanup_id = ${cleanupId}`
    await h.sql`DELETE FROM cleanups WHERE id = ${cleanupId}`

    await expect(guestRowCount(cleanupId)).resolves.toBe(0)
    const otps = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM guest_otps WHERE cleanup_id = ${cleanupId}
    `
    expect(otps[0]!.n).toBe(0)
  })
})
