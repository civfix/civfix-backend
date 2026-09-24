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
const tokens = makeTicketTokenSigner("integration-capacity-race-secret-long-enough")
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

describe.skipIf(!pg)("registration capacity (integration)", () => {
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

  async function newCleanup(organizerId: string): Promise<string> {
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Capacity sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
    })
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer') ON CONFLICT DO NOTHING
    `
    return id
  }

  async function newTicketType(
    cleanupId: string,
    over: { capacity?: number | null; maxPartySize?: number } = {},
  ): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size)
      VALUES (
        ${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`},
        ${over.capacity === undefined ? null : over.capacity}, ${over.maxPartySize ?? 4}
      )
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

  it("lets EXACTLY capacity seats through under 50 concurrent registrations", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, { capacity: 10, maxPartySize: 1 })

    const userIds = await Promise.all(
      Array.from({ length: 50 }, (_unused, i) => newUser(`Racer ${i}`)),
    )
    const now = new Date()

    const outcomes = await Promise.all(
      userIds.map((userId) =>
        repo.registerTx({
          cleanupId,
          subject: { kind: "user", userId },
          ticketTypeId,
          seats: seats(1),
          accessCodeHash: null,
          answers: [],
          consent: null,
          slotId: null,
          source: "self",
          idempotencyKey: `race-${userId}`,
          waitlistId: null,
          now,
        }),
      ),
    )

    const registered = outcomes.filter((o) => o.kind === "registered")
    const full = outcomes.filter((o) => o.kind === "full")
    expect(registered).toHaveLength(10)
    expect(full).toHaveLength(40)
    expect(await reservedSeats(ticketTypeId)).toBe(10)

    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_registrations
       WHERE cleanup_id = ${cleanupId} AND status = 'registered'
    `
    expect((rows[0] as { n: number }).n).toBe(10)

    const seatRows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_registration_seats WHERE cleanup_id = ${cleanupId}
    `
    expect((seatRows[0] as { n: number }).n).toBe(10)
  })

  it("refuses a party whole rather than splitting it across the boundary", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, { capacity: 4, maxPartySize: 4 })
    const now = new Date()

    const first = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId: await newUser("Pair") },
      ticketTypeId,
      seats: seats(2),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `pair-${randomUUID()}`,
      waitlistId: null,
      now,
    })
    expect(first.kind).toBe("registered")

    const tooBig = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId: await newUser("Trio") },
      ticketTypeId,
      seats: seats(3),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `trio-${randomUUID()}`,
      waitlistId: null,
      now,
    })
    expect(tooBig.kind).toBe("full")
    expect(await reservedSeats(ticketTypeId)).toBe(2)
  })

  it("commits nothing at all when the capacity gate refuses", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, { capacity: 1, maxPartySize: 1 })
    const winner = await newUser("Winner")
    const loser = await newUser("Loser")
    const now = new Date()

    for (const userId of [winner, loser]) {
      await repo.registerTx({
        cleanupId,
        subject: { kind: "user", userId },
        ticketTypeId,
        seats: seats(1),
        accessCodeHash: null,
        answers: [],
        consent: null,
        slotId: null,
        source: "self",
        idempotencyKey: `one-${userId}`,
        waitlistId: null,
        now,
      })
    }

    const members = await h.sql<{ user_id: string }[]>`
      SELECT user_id FROM cleanup_members WHERE cleanup_id = ${cleanupId} AND user_id = ${loser}
    `
    expect(members).toHaveLength(0)

    const idempotency = await h.sql<{ user_or_anon: string }[]>`
      SELECT user_or_anon FROM idempotency_keys
       WHERE scope = 'event.register'
         AND user_or_anon IN (${`user:${winner}`}, ${`user:${loser}`})
    `
    expect(idempotency.map((row) => row.user_or_anon)).toEqual([`user:${winner}`])
  })

  it("replays the same idempotency key instead of taking a second seat", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, { capacity: 5, maxPartySize: 1 })
    const userId = await newUser("Repeater")
    const now = new Date()
    const args = {
      cleanupId,
      subject: { kind: "user" as const, userId },
      ticketTypeId,
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self" as const,
      idempotencyKey: "stable-key",
      waitlistId: null,
      now,
    }

    const first = await repo.registerTx({ ...args, seats: seats(1) })
    const second = await repo.registerTx({ ...args, seats: seats(1) })

    expect(first.kind).toBe("registered")
    expect(second.kind).toBe("replayed")
    expect(await reservedSeats(ticketTypeId)).toBe(1)
  })

  it("releases exactly the seats a cancel held, in one statement", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, { capacity: 4, maxPartySize: 4 })
    const userId = await newUser("Leaver")
    const now = new Date()

    const registered = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId },
      ticketTypeId,
      seats: seats(3),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `cancel-${randomUUID()}`,
      waitlistId: null,
      now,
    })
    if (registered.kind !== "registered") throw new Error("expected registered")
    expect(await reservedSeats(ticketTypeId)).toBe(3)

    const cancelled = await repo.cancelRegistration({
      cleanupId,
      registrationId: registered.registration.id,
      actorId: organizer,
      now,
    })
    expect(cancelled.kind).toBe("cancelled")
    expect(await reservedSeats(ticketTypeId)).toBe(0)

    const again = await repo.cancelRegistration({
      cleanupId,
      registrationId: registered.registration.id,
      actorId: organizer,
      now,
    })
    expect(again.kind).toBe("already_cancelled")
    expect(await reservedSeats(ticketTypeId)).toBe(0)

    const seatStates = await h.sql<{ status: string }[]>`
      SELECT status FROM cleanup_registration_seats WHERE registration_id = ${registered.registration.id}
    `
    expect(seatStates.every((row) => row.status === "cancelled")).toBe(true)
  })

  it("never trips the oversell backstop CHECK", async () => {
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_ticket_types
       WHERE reserved_seats < 0 OR (capacity IS NOT NULL AND reserved_seats > capacity)
    `
    expect((rows[0] as { n: number }).n).toBe(0)
  })
})
