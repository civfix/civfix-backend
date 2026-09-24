import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type {
  HostRegistrationRepository,
  SeatDraft,
} from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()
const tokens = makeTicketTokenSigner("integration-waitlist-secret-long-enough")
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const CLAIM_WINDOW_MS = 60 * 60 * 1000
const PAST = new Date(Date.now() - 30 * 86_400_000)
const STALE_APP_CLOCK = new Date(Date.now() - 60 * 86_400_000)

describe.skipIf(!pg)("waitlist promotion (integration)", () => {
  let h: PgHarness
  let repo: HostRegistrationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleHostRegistrationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return (u as { id: string }).id
  }

  async function newCleanup(organizerId: string, scheduledAt: Date = FUTURE): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Waitlist sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt,
    })
  }

  async function newTicketType(cleanupId: string, capacity: number): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size, waitlist_enabled)
      VALUES (${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`}, ${capacity}, 4, true)
      RETURNING id
    `
    return (row as { id: string }).id
  }

  function seats(partySize: number): SeatDraft[] {
    return Array.from({ length: partySize }, () => {
      const id = randomUUID()
      return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
    })
  }

  async function reservedSeats(ticketTypeId: string): Promise<number> {
    const rows = await h.sql<{ reserved_seats: number }[]>`
      SELECT reserved_seats FROM cleanup_ticket_types WHERE id = ${ticketTypeId}
    `
    return (rows[0] as { reserved_seats: number }).reserved_seats
  }

  it("refuses a waitlist join on an ended event using the DB clock, not the caller's", async () => {
    const organizer = await newUser("Stale Clock Organizer")
    const cleanupId = await newCleanup(organizer, PAST)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Stale Clock Joiner")

    const outcome = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now: STALE_APP_CLOCK,
    })

    expect(outcome).toEqual({ kind: "ended" })
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_waitlist WHERE ticket_type_id = ${ticketTypeId}
    `
    expect(rows[0]?.n).toBe(0)
  })

  it("offers two different people under two concurrent promoters", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 2)
    const now = new Date()

    for (const name of ["First", "Second", "Third"]) {
      await repo.joinWaitlist({
        cleanupId,
        ticketTypeId,
        subject: { kind: "user", userId: await newUser(name) },
        partySize: 1,
        accessCodeHash: null,
        now: new Date(now.getTime() + ["First", "Second", "Third"].indexOf(name) * 1000),
      })
    }

    const [a, b] = await Promise.all([
      repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS }),
      repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS }),
    ])

    const offered = [a, b].filter((offer) => offer !== null)
    expect(offered).toHaveLength(2)
    expect(new Set(offered.map((offer) => offer?.waitlistId)).size).toBe(2)
    expect(await reservedSeats(ticketTypeId)).toBe(2)

    expect(
      await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS }),
    ).toBeNull()
  })

  it("blocks the queue on a party that does not fit rather than skipping it", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 2)
    const now = new Date()

    await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId: await newUser("Quad") },
      partySize: 4,
      accessCodeHash: null,
      now,
    })
    await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId: await newUser("Single") },
      partySize: 1,
      accessCodeHash: null,
      now: new Date(now.getTime() + 1000),
    })

    expect(
      await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS }),
    ).toBeNull()
    expect(await reservedSeats(ticketTypeId)).toBe(0)
  })

  it("holds the seat through the claim window and does not double reserve on claim", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Promoted")
    const now = new Date()

    const joined = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    if (joined.kind !== "joined") throw new Error("expected joined")

    await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS })
    expect(await reservedSeats(ticketTypeId)).toBe(1)

    const walkin = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId: await newUser("Walk in") },
      ticketTypeId,
      seats: seats(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `walkin-${randomUUID()}`,
      waitlistId: null,
      now,
    })
    expect(walkin.kind).toBe("full")

    const claimed = await repo.claimWaitlistOffer({
      cleanupId,
      waitlistId: joined.entry.id,
      subject: { kind: "user", userId },
      seats: seats(1),
      now,
    })
    expect(claimed.kind).toBe("claimed")
    expect(await reservedSeats(ticketTypeId)).toBe(1)

    const entry = await repo.findWaitlistEntry(cleanupId, joined.entry.id)
    expect(entry?.status).toBe("claimed")
  })

  it("releases the held seats when the claim window expires", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Slow")
    const now = new Date()

    const joined = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    if (joined.kind !== "joined") throw new Error("expected joined")
    await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: 1 })

    const released = await repo.expireWaitlistOffers({
      now: new Date(now.getTime() + 60_000),
      limit: 100,
    })
    expect(released).toContain(ticketTypeId)
    expect(await reservedSeats(ticketTypeId)).toBe(0)
    expect((await repo.findWaitlistEntry(cleanupId, joined.entry.id))?.status).toBe("expired")

    const late = await repo.claimWaitlistOffer({
      cleanupId,
      waitlistId: joined.entry.id,
      subject: { kind: "user", userId },
      seats: seats(1),
      now: new Date(now.getTime() + 60_000),
    })
    expect(late.kind).toBe("expired")
  })

  it("lets exactly one of a concurrent claim and expiry win, with consistent reserved_seats", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Racer")
    const now = new Date()

    const joined = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    if (joined.kind !== "joined") throw new Error("expected joined")
    await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: 1 })
    expect(await reservedSeats(ticketTypeId)).toBe(1)

    const at = new Date(now.getTime() + 60_000)
    const [claim, expired] = await Promise.all([
      repo.claimWaitlistOffer({
        cleanupId,
        waitlistId: joined.entry.id,
        subject: { kind: "user", userId },
        seats: seats(1),
        now: at,
      }),
      repo.expireWaitlistOffers({ now: at, limit: 100 }),
    ])

    const entry = await repo.findWaitlistEntry(cleanupId, joined.entry.id)
    const registrations = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_registrations
       WHERE cleanup_id = ${cleanupId} AND status = 'registered'
    `
    const held = await reservedSeats(ticketTypeId)

    if (claim.kind === "claimed") {
      expect(entry?.status).toBe("claimed")
      expect((registrations[0] as { n: number }).n).toBe(1)
      expect(held).toBe(1)
    } else {
      expect(claim.kind).toBe("expired")
      expect(expired).toContain(ticketTypeId)
      expect(entry?.status).toBe("expired")
      expect((registrations[0] as { n: number }).n).toBe(0)
      expect(held).toBe(0)
    }
  })

  it("never registers a party the offer no longer holds seats for", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Left and claimed")
    const now = new Date()

    const joined = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    if (joined.kind !== "joined") throw new Error("expected joined")
    await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: CLAIM_WINDOW_MS })

    await repo.leaveWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      now,
    })

    const claimed = await repo.claimWaitlistOffer({
      cleanupId,
      waitlistId: joined.entry.id,
      subject: { kind: "user", userId },
      seats: seats(1),
      now,
    })

    expect(claimed.kind).toBe("not_offered")
    expect(await reservedSeats(ticketTypeId)).toBe(0)
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_registrations WHERE cleanup_id = ${cleanupId}
    `
    expect((rows[0] as { n: number }).n).toBe(0)
  })

  it("refuses a second live queue entry for the same person and ticket type", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const userId = await newUser("Eager")
    const now = new Date()

    const first = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    const second = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId },
      partySize: 1,
      accessCodeHash: null,
      now,
    })

    expect(first.kind).toBe("joined")
    expect(second.kind).toBe("already_waiting")

    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_waitlist
       WHERE ticket_type_id = ${ticketTypeId} AND status IN ('waiting', 'offered')
    `
    expect((rows[0] as { n: number }).n).toBe(1)
  })
})
