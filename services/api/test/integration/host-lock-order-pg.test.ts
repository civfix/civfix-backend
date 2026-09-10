
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import type {
  HostRegistrationRepository,
  SeatDraft,
} from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()
const tokens = makeTicketTokenSigner("integration-lock-order-secret-long-enough")
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const DEADLOCK = "40P01"

describe.skipIf(!pg)("host lock order (integration)", () => {
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
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${id}, ${organizerId}, 'site', 'Lock order sweep',
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), ${FUTURE}, 'upcoming'
      )
    `
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer') ON CONFLICT DO NOTHING
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

  function namedSeats(partySize: number): SeatDraft[] {
    return Array.from({ length: partySize }, (_unused, i) => {
      const id = randomUUID()
      return { id, attendeeName: `Attendee ${i} ${id.slice(0, 8)}`, tokenHash: tokens.hashFor(id) }
    })
  }

  function deadlocks(errors: unknown[]): unknown[] {
    return errors.filter(
      (err) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === DEADLOCK,
    )
  }

  it("raises zero deadlocks when register, cancel, promote and check-in all run at once", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const typeA = await newTicketType(cleanupId, 20)
    const typeB = await newTicketType(cleanupId, 20)
    const now = new Date()

    const userIds = await Promise.all(
      Array.from({ length: 24 }, (_unused, i) => newUser(`Racer ${i}`)),
    )

    const errors: unknown[] = []
    const registrationIds: string[] = []

    await Promise.all(
      userIds.map(async (userId, index) => {
        const ticketTypeId = index % 2 === 0 ? typeA : typeB
        try {
          const outcome = await repo.registerTx({
            cleanupId,
            subject: { kind: "user", userId },
            ticketTypeId,
            seats: seats(1),
            accessCodeHash: null,
            answers: [],
            consent: null,
            slotId: null,
            source: "self",
            idempotencyKey: `lock-${userId}`,
            waitlistId: null,
            now,
          })
          if (outcome.kind === "registered") registrationIds.push(outcome.registration.id)
        } catch (err) {
          errors.push(err)
        }
      }),
    )

    await Promise.all([
      ...registrationIds.slice(0, 8).map(async (registrationId) => {
        try {
          await repo.cancelRegistration({ cleanupId, registrationId, actorId: organizer, now })
        } catch (err) {
          errors.push(err)
        }
      }),
      ...[typeA, typeB].map(async (ticketTypeId) => {
        try {
          await repo.offerNextWaitlistEntry({ ticketTypeId, now, claimWindowMs: 60_000 })
        } catch (err) {
          errors.push(err)
        }
      }),
      ...registrationIds.slice(8, 16).map(async (registrationId) => {
        try {
          const record = await repo.findRegistration(cleanupId, registrationId)
          const seatId = record?.seats[0]?.id
          if (seatId !== undefined) {
            await repo.checkInSeat({ cleanupId, seatId, actorId: organizer, method: "manual", now })
          }
        } catch (err) {
          errors.push(err)
        }
      }),
      ...registrationIds.slice(16).map(async (registrationId) => {
        try {
          await repo.transferRegistration({
            cleanupId,
            registrationId,
            ticketTypeId: typeA,
            now,
          })
        } catch (err) {
          errors.push(err)
        }
      }),
    ])

    expect(deadlocks(errors)).toHaveLength(0)

    const invariants = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_ticket_types
       WHERE cleanup_id = ${cleanupId}
         AND (reserved_seats < 0 OR (capacity IS NOT NULL AND reserved_seats > capacity))
    `
    expect((invariants[0] as { n: number }).n).toBe(0)
  })

  it("raises zero deadlocks when two ticket types are reconciled while registrations land", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, null)
    const now = new Date()
    const errors: unknown[] = []

    const userIds = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) => newUser(`Mixed ${i}`)),
    )

    await Promise.all([
      ...userIds.map(async (userId) => {
        try {
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
            idempotencyKey: `mixed-${userId}`,
            waitlistId: null,
            now,
          })
        } catch (err) {
          errors.push(err)
        }
      }),
      ...Array.from({ length: 4 }, async (_unused, i) => {
        try {
          await repo.reconcileQuestions(
            cleanupId,
            [
              {
                id: null,
                ticketTypeId: null,
                kind: "short_text",
                prompt: `Question ${i}`,
                helpText: null,
                required: false,
                options: [],
                maxSelections: null,
                consentText: null,
                showIf: null,
                sortOrder: i,
              },
            ],
            now,
          )
        } catch (err) {
          errors.push(err)
        }
      }),
    ])

    expect(deadlocks(errors)).toHaveLength(0)
  })

  it("raises zero deadlocks when a transfer and a cancel race for the same registrations", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const typeA = await newTicketType(cleanupId, null)
    const typeB = await newTicketType(cleanupId, null)
    const now = new Date()
    const errors: unknown[] = []
    const registrationIds: string[] = []

    const userIds = await Promise.all(
      Array.from({ length: 16 }, (_unused, i) => newUser(`Transfer ${i}`)),
    )
    for (const userId of userIds) {
      const outcome = await repo.registerTx({
        cleanupId,
        subject: { kind: "user", userId },
        ticketTypeId: typeA,
        seats: seats(1),
        accessCodeHash: null,
        answers: [],
        consent: null,
        slotId: null,
        source: "self",
        idempotencyKey: `transfer-${userId}`,
        waitlistId: null,
        now,
      })
      if (outcome.kind === "registered") registrationIds.push(outcome.registration.id)
    }

    await Promise.all(
      registrationIds.flatMap((registrationId) => [
        (async () => {
          try {
            await repo.transferRegistration({ cleanupId, registrationId, ticketTypeId: typeB, now })
          } catch (err) {
            errors.push(err)
          }
        })(),
        (async () => {
          try {
            await repo.cancelRegistration({ cleanupId, registrationId, actorId: organizer, now })
          } catch (err) {
            errors.push(err)
          }
        })(),
      ]),
    )

    expect(deadlocks(errors)).toHaveLength(0)
    const invariants = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_ticket_types
       WHERE cleanup_id = ${cleanupId} AND reserved_seats < 0
    `
    expect((invariants[0] as { n: number }).n).toBe(0)
  })

  it("raises zero deadlocks when a cancel and a waitlist claim race on one ticket type", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 8)
    const now = new Date()
    const errors: unknown[] = []
    const registrationIds: string[] = []

    const holders = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) => newUser(`Holder ${i}`)),
    )
    for (const userId of holders) {
      const outcome = await repo.registerTx({
        cleanupId,
        subject: { kind: "user", userId },
        ticketTypeId,
        seats: seats(1),
        accessCodeHash: null,
        answers: [],
        consent: null,
        slotId: null,
        source: "self",
        idempotencyKey: `holder-${userId}`,
        waitlistId: null,
        now,
      })
      if (outcome.kind === "registered") registrationIds.push(outcome.registration.id)
    }

    const waiters = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) => newUser(`Waiter ${i}`)),
    )
    const waitlistIds: string[] = []
    for (const userId of waiters) {
      const joined = await repo.joinWaitlist({
        cleanupId,
        ticketTypeId,
        subject: { kind: "user", userId },
        partySize: 1,
        accessCodeHash: null,
        now,
      })
      if (joined.kind === "joined") waitlistIds.push(joined.entry.id)
    }

    await Promise.all(
      registrationIds.map(async (registrationId) => {
        try {
          await repo.cancelRegistration({ cleanupId, registrationId, actorId: organizer, now })
        } catch (err) {
          errors.push(err)
        }
      }),
    )
    const offers: string[] = []
    for (const waitlistId of waitlistIds) {
      const offer = await repo.offerWaitlistEntry({
        cleanupId,
        waitlistId,
        now,
        claimWindowMs: 600_000,
      })
      if (offer !== null) offers.push(waitlistId)
    }

    await Promise.all(
      offers.map(async (waitlistId, index) => {
        try {
          await repo.claimWaitlistOffer({
            cleanupId,
            waitlistId,
            subject: null,
            seats: seats(1),
            now,
          })
        } catch (err) {
          errors.push(err)
        }
        const registrationId = registrationIds[index]
        if (registrationId === undefined) return
        try {
          await repo.cancelRegistration({ cleanupId, registrationId, actorId: organizer, now })
        } catch (err) {
          errors.push(err)
        }
      }),
    )

    expect(deadlocks(errors)).toHaveLength(0)
    const invariants = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_ticket_types
       WHERE cleanup_id = ${cleanupId}
         AND (reserved_seats < 0 OR (capacity IS NOT NULL AND reserved_seats > capacity))
    `
    expect((invariants[0] as { n: number }).n).toBe(0)
  })

  it("returns the existing registration when the same subject claims an offer twice", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, 1)
    const now = new Date()

    const holder = await newUser("Holder")
    const first = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId: holder },
      ticketTypeId,
      seats: seats(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `double-holder`,
      waitlistId: null,
      now,
    })
    expect(first.kind).toBe("registered")

    const waiter = await newUser("Waiter")
    const joined = await repo.joinWaitlist({
      cleanupId,
      ticketTypeId,
      subject: { kind: "user", userId: waiter },
      partySize: 1,
      accessCodeHash: null,
      now,
    })
    expect(joined.kind).toBe("joined")
    const waitlistId = joined.kind === "joined" ? joined.entry.id : ""

    if (first.kind === "registered") {
      await repo.cancelRegistration({
        cleanupId,
        registrationId: first.registration.id,
        actorId: organizer,
        now,
      })
    }
    const offer = await repo.offerWaitlistEntry({ cleanupId, waitlistId, now, claimWindowMs: 600_000 })
    expect(offer).not.toBeNull()

    const claimed = await repo.claimWaitlistOffer({
      cleanupId,
      waitlistId,
      subject: { kind: "user", userId: waiter },
      seats: seats(1),
      now,
    })
    expect(claimed.kind).toBe("claimed")

    const replay = await repo.claimWaitlistOffer({
      cleanupId,
      waitlistId,
      subject: { kind: "user", userId: waiter },
      seats: seats(1),
      now,
    })
    expect(replay.kind).toBe("claimed")
    if (claimed.kind === "claimed" && replay.kind === "claimed") {
      expect(replay.registration.id).toBe(claimed.registration.id)
    }
  })

  it("raises zero deadlocks when the erasure attendee scrub races the cancel CTE", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const ticketTypeId = await newTicketType(cleanupId, null)
    const otherTypeId = await newTicketType(cleanupId, null)
    const now = new Date()
    const errors: unknown[] = []
    const users = new PgUserStore(h.db)

    const attendees = await Promise.all(
      Array.from({ length: 16 }, (_unused, i) => newUser(`Erasing ${i}`)),
    )
    const registrationIds = new Map<string, string>()
    const waitlistIds = new Map<string, string>()
    for (const [index, userId] of attendees.entries()) {
      const joined = await repo.joinWaitlist({
        cleanupId,
        ticketTypeId: otherTypeId,
        subject: { kind: "user", userId },
        partySize: 1,
        accessCodeHash: null,
        now,
      })
      if (joined.kind === "joined") waitlistIds.set(userId, joined.entry.id)
      const outcome = await repo.registerTx({
        cleanupId,
        subject: { kind: "user", userId },
        ticketTypeId,
        seats: namedSeats(2),
        accessCodeHash: null,
        answers: [],
        consent: null,
        slotId: null,
        source: "self",
        idempotencyKey: `erasure-${userId}`,
        waitlistId: null,
        now,
      })
      if (outcome.kind !== "registered") continue
      registrationIds.set(userId, outcome.registration.id)
      await repo.setHostNote(cleanupId, outcome.registration.id, `Host note ${index}`)
    }
    expect(registrationIds.size).toBe(attendees.length)
    expect(waitlistIds.size).toBe(attendees.length)

    await Promise.all(
      attendees.flatMap((userId) => {
        const registrationId = registrationIds.get(userId)
        if (registrationId === undefined) return []
        return [
          (async () => {
            try {
              await users.softDeleteAndAnonymize(userId)
            } catch (err) {
              errors.push(err)
            }
          })(),
          (async () => {
            try {
              await repo.cancelRegistration({ cleanupId, registrationId, actorId: organizer, now })
            } catch (err) {
              errors.push(err)
            }
          })(),
        ]
      }),
    )

    expect(deadlocks(errors)).toHaveLength(0)
    expect(errors).toHaveLength(0)

    const leftovers = await h.sql<{ notes: number; names: number; waiting: number }[]>`
      SELECT
        count(*) FILTER (WHERE r.host_note IS NOT NULL)::int AS notes,
        count(*) FILTER (WHERE s.attendee_name IS NOT NULL)::int AS names,
        (SELECT count(*)::int FROM cleanup_waitlist w
          WHERE w.cleanup_id = ${cleanupId} AND w.status IN ('waiting', 'offered')) AS waiting
      FROM cleanup_registrations r
      LEFT JOIN cleanup_registration_seats s ON s.registration_id = r.id
      WHERE r.cleanup_id = ${cleanupId}
    `
    const row = leftovers[0] as { notes: number; names: number; waiting: number }
    expect(row.notes).toBe(0)
    expect(row.names).toBe(0)
    expect(row.waiting).toBe(0)

    const invariants = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_ticket_types
       WHERE cleanup_id = ${cleanupId} AND reserved_seats < 0
    `
    expect((invariants[0] as { n: number }).n).toBe(0)
  })
})
