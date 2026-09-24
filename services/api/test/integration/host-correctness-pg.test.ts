import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { hostedRegistrationTotals } from "../../src/services/host/host-portfolio-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type {
  HostRegistrationRepository,
  RegisterTxArgs,
  SeatDraft,
} from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()
const tokens = makeTicketTokenSigner("integration-host-correctness-secret-long")
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const CLAIM_WINDOW_MS = HOUR_MS
const SLOT_RACE_ROUNDS = 10

describe.skipIf(!pg)("host registration correctness (integration)", () => {
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

  async function newCleanup(
    organizerId: string,
    over: { scheduledAt?: Date; endsAt?: Date } = {},
  ): Promise<string> {
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Correctness sweep",
      scheduledAt: over.scheduledAt ?? new Date(Date.now() + 7 * DAY_MS),
      ...(over.endsAt !== undefined ? { endsAt: over.endsAt } : {}),
    })
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer')
      ON CONFLICT DO NOTHING
    `
    return id
  }

  async function newTicketType(cleanupId: string, capacity: number | null): Promise<string> {
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

  function registerArgs(
    cleanupId: string,
    userId: string,
    over: Partial<RegisterTxArgs> = {},
  ): RegisterTxArgs {
    return {
      cleanupId,
      subject: { kind: "user", userId },
      ticketTypeId: null,
      seats: seats(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: randomUUID(),
      waitlistId: null,
      now: new Date(),
      ...over,
    }
  }

  it("never lets two registrations on different ticket types overfill one slot", async () => {
    for (let round = 0; round < SLOT_RACE_ROUNDS; round++) {
      const organizer = await newUser("Slot Organizer")
      const cleanupId = await newCleanup(organizer)
      const typeA = await newTicketType(cleanupId, null)
      const typeB = await newTicketType(cleanupId, null)
      const [slot] = await h.sql<{ id: string }[]>`
        INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order)
        VALUES (${cleanupId}, ${"Grill"}, NULL, 1, 0)
        RETURNING id
      `
      const slotId = (slot as { id: string }).id
      const [first, second] = [await newUser("First"), await newUser("Second")]

      const settled = await Promise.allSettled([
        repo.registerTx(registerArgs(cleanupId, first, { ticketTypeId: typeA, slotId })),
        repo.registerTx(registerArgs(cleanupId, second, { ticketTypeId: typeB, slotId })),
      ])

      const claims = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM cleanup_slot_claims WHERE slot_id = ${slotId}
      `
      expect(claims[0]?.n).toBe(1)
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1)
      const registered = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM cleanup_registrations
         WHERE cleanup_id = ${cleanupId} AND status = 'registered'
      `
      expect(registered[0]?.n).toBe(1)
    }
  })

  it("offers no waitlist place on a cancelled or ended event and reserves nothing", async () => {
    for (const shape of ["cancelled", "ended"] as const) {
      const organizer = await newUser("Dead Event Organizer")
      const cleanupId =
        shape === "ended"
          ? await newCleanup(organizer, {
              scheduledAt: new Date(Date.now() - 6 * HOUR_MS),
              endsAt: new Date(Date.now() - HOUR_MS),
            })
          : await newCleanup(organizer)
      const ticketTypeId = await newTicketType(cleanupId, 1)
      const [waiting] = await h.sql<{ id: string }[]>`
        INSERT INTO cleanup_waitlist (cleanup_id, ticket_type_id, user_id, party_size, status)
        VALUES (${cleanupId}, ${ticketTypeId}, ${await newUser("Waiter")}, 1, 'waiting')
        RETURNING id
      `
      if (shape === "cancelled") {
        await h.sql`UPDATE cleanups SET status = 'cancelled' WHERE id = ${cleanupId}`
      }

      const next = await repo.offerNextWaitlistEntry({
        ticketTypeId,
        now: new Date(),
        claimWindowMs: CLAIM_WINDOW_MS,
      })
      const direct = await repo.offerWaitlistEntry({
        cleanupId,
        waitlistId: (waiting as { id: string }).id,
        now: new Date(),
        claimWindowMs: CLAIM_WINDOW_MS,
      })

      expect(next).toBeNull()
      expect(direct).toBeNull()
      const [type] = await h.sql<{ reserved_seats: number }[]>`
        SELECT reserved_seats FROM cleanup_ticket_types WHERE id = ${ticketTypeId}
      `
      expect(type?.reserved_seats).toBe(0)
    }
  })

  it("totals registrations and check-ins across every hosted event, not one page", async () => {
    const host = await newUser("Portfolio Host")
    const events = [await newCleanup(host), await newCleanup(host), await newCleanup(host)]
    for (const cleanupId of events) {
      const outcome = await repo.registerTx(
        registerArgs(cleanupId, await newUser("Attendee"), { seats: seats(2) }),
      )
      if (outcome.kind !== "registered") throw new Error(`setup: ${outcome.kind}`)
      const seat = outcome.registration.seats[0]
      if (seat === undefined) throw new Error("setup: no seat")
      await repo.checkInSeat({
        cleanupId,
        seatId: seat.id,
        actorId: host,
        method: "manual",
        now: new Date(),
      })
    }

    const totals = await hostedRegistrationTotals(h.sql, { userId: host, organizationId: null })

    expect(totals).toEqual({ totalRegistrations: 6, totalCheckedIn: 3 })
  })
})
