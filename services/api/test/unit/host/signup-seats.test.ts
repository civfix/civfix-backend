/**
 * DECISIONS §44: a sign-up on a NON-ticketed event is a free registration.
 *
 * Before this, a slot-based event's host saw an empty "Attendees" list and zero check-in counters:
 * joining wrote `cleanup_members` (+ a slot claim) and nothing on the registration side, while the
 * roster, the counters, the scanner, the no-show sweep and the attendee's own ticket are ALL keyed on
 * `cleanup_registration_seats`. Joining or claiming a slot on an event with no ticket types now mints
 * a free one-seat registration; leaving or being removed cancels it; releasing a slot does not,
 * because releasing keeps membership (DECISIONS §43).
 *
 * The in-memory CleanupRepository writes through to the in-memory HostRegistrationRepository exactly
 * where the Drizzle repository calls `ensureSignupRegistrationIn` / `cancelSignupRegistrationIn`, so
 * these tests can assert the roster, the counters and the ticket the host and attendee actually see.
 * The real SQL (the partial-unique arbiter and the seat write) is exercised in
 * test/integration/signup-seats-pg.test.ts.
 */

import { TEST_TICKET_SIGNER } from "../../helpers/ticket-signer.js"
import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { makeCleanupService, type CleanupService } from "../../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../../helpers/cleanups.js"
import { InMemoryHostRegistrationRepository } from "../../helpers/host/registration-repository.memory.js"
import type { TicketTypeRecord } from "../../../src/services/host/registration-repository.js"
import {
  makeCheckinService,
  type CheckinService,
} from "../../../src/services/host/checkin-service.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const MEMBER = "33333333-3333-3333-3333-333333333333"
const OTHER = "44444444-4444-4444-4444-444444444444"

const CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000001"
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

let repo: InMemoryCleanupRepository
let registrations: InMemoryHostRegistrationRepository
let service: CleanupService
let checkin: CheckinService

function seedEvent(over: { capacity?: number | null } = {}): string {
  repo.seedCleanup({
    id: CLEANUP_ID,
    organizerUserId: ORG,
    scheduledAt: FUTURE,
    withDefaultSlot: false,
    ...(over.capacity !== undefined ? { capacity: over.capacity } : {}),
  })
  registrations.seedEvent({ cleanupId: CLEANUP_ID, organizerUserId: ORG, ...over })
  return CLEANUP_ID
}

function seedTicketType(cleanupId: string): TicketTypeRecord {
  const record = registrations.seedTicketType({ cleanupId, name: "General admission" })
  repo.seedTicketType({ cleanupId, id: record.id, name: record.name })
  return record
}

function activeRegistrationsOf(cleanupId: string, userId: string) {
  return [...registrations.registrations.values()].filter(
    (r) => r.cleanupId === cleanupId && r.userId === userId && r.status === "registered",
  )
}

async function rosterUserIds(cleanupId: string): Promise<(string | null)[]> {
  const page = await registrations.listRoster({
    cleanupId,
    filter: "registered",
    ticketTypeId: null,
    slotId: null,
    sort: "registered_at_desc",
    q: null,
    cursor: null,
    limit: 50,
    withTotal: false,
  })
  return page.rows.map((row) => row.userId)
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  registrations = new InMemoryHostRegistrationRepository()
  registrations.tokenHashResolver = (seatId) => TEST_TICKET_SIGNER.hashFor(seatId)
  repo.registrationSink = registrations
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel" })
  repo.seedUser({ id: OTHER, displayName: "Ollie Other", handle: "ollie" })
  service = makeCleanupService({
    repo,
    tickets: TEST_TICKET_SIGNER,
    counters: new InMemoryCounterStore(() => 0),
  })
  checkin = makeCheckinService({
    repo: registrations,
    tokens: TEST_TICKET_SIGNER,
    registrations: { eventChanged: () => Promise.resolve() },
  })
})

describe("signing up for a non-ticketed event", () => {
  it("creates exactly one active registration with one active seat", async () => {
    const id = seedEvent()

    await service.joinCleanup(id, MEMBER)

    const mine = activeRegistrationsOf(id, MEMBER)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.partySize).toBe(1)
    expect(mine[0]?.source).toBe("self")
    expect(mine[0]?.ticketTypeId).toBeNull()
    expect(mine[0]?.seats.map((s) => [s.seatIndex, s.status, s.attendeeName])).toEqual([
      [0, "active", null],
    ])
  })

  it("joining twice is a no-op", async () => {
    const id = seedEvent()

    await service.joinCleanup(id, MEMBER)
    await service.joinCleanup(id, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(1)
  })

  it("claiming a slot after joining does not create a second registration", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    await service.joinCleanup(id, MEMBER)
    await service.claimEventSlot(id, MEMBER, slot.id)

    const mine = activeRegistrationsOf(id, MEMBER)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.seats).toHaveLength(1)
  })

  it("claiming a slot without joining first mints the registration", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    await service.claimEventSlot(id, MEMBER, slot.id)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(1)
  })

  it("is allowed on an event that carries a legacy cleanups.capacity", async () => {
    const id = seedEvent({ capacity: 1 })

    await service.joinCleanup(id, MEMBER)
    await service.joinCleanup(id, OTHER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(1)
    expect(activeRegistrationsOf(id, OTHER)).toHaveLength(1)
  })

  it("puts the member on the host roster and into the check-in counters", async () => {
    const id = seedEvent()

    await service.joinCleanup(id, MEMBER)

    expect(await rosterUserIds(id)).toEqual([MEMBER])
    const counters = await registrations.checkinCounters(id)
    expect(counters.registered).toBe(1)
    expect(counters.checkedIn).toBe(0)
  })

  it("gives the member a scannable ticket the host can check in", async () => {
    const id = seedEvent()

    await service.joinCleanup(id, MEMBER)

    const ticket = await checkin.myTicket({ id }, MEMBER)
    expect(ticket.seats).toHaveLength(1)
    const seat = ticket.seats[0]
    if (seat === undefined) throw new Error("expected a seat on the ticket")

    const result = await checkin.checkIn({ id, seatId: seat.id, method: "manual" }, ORG)
    expect(result.outcome).toBe("checked_in")
    expect((await registrations.checkinCounters(id)).checkedIn).toBe(1)
  })
})

describe("a ticketed event", () => {
  it("gets no auto-registration; registerIn owns that path", async () => {
    const id = seedEvent()
    seedTicketType(id)
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })

    await service.joinCleanup(id, MEMBER)
    await service.claimEventSlot(id, MEMBER, slot.id)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    expect(await rosterUserIds(id)).toEqual([])
  })

  it("a plain leave does not cancel a ticketed registration", async () => {
    const id = seedEvent()
    const type = seedTicketType(id)
    const registered = await registrations.registerTx({
      cleanupId: id,
      subject: { kind: "user", userId: MEMBER },
      ticketTypeId: type.id,
      seats: [{ id: randomUUID(), attendeeName: null, tokenHash: randomUUID() }],
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "ticketed-leave",
      waitlistId: null,
      now: new Date(),
    })
    expect(registered.kind).toBe("registered")

    await service.joinCleanup(id, MEMBER)
    await service.leaveCleanup(id, MEMBER)

    const mine = activeRegistrationsOf(id, MEMBER)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.ticketTypeId).toBe(type.id)
    expect(mine[0]?.seats.map((seat) => seat.status)).toEqual(["active"])
  })
})

describe("a host removing an attendee who holds a ticket", () => {
  it("cancels the ticketed registration, releases its seats and kills the ticket", async () => {
    const id = seedEvent()
    const type = seedTicketType(id)
    const seatId = randomUUID()
    const registered = await registrations.registerTx({
      cleanupId: id,
      subject: { kind: "user", userId: MEMBER },
      ticketTypeId: type.id,
      seats: [{ id: seatId, attendeeName: null, tokenHash: TEST_TICKET_SIGNER.hashFor(seatId) }],
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "ticketed-ban",
      waitlistId: null,
      now: new Date(),
    })
    expect(registered.kind).toBe("registered")
    repo.seedMember(id, MEMBER, "member")

    await service.removeMember(id, ORG, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    expect(registrations.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
    expect(await rosterUserIds(id)).toEqual([])
    const scanned = await checkin.scan({ id, token: TEST_TICKET_SIGNER.tokenFor(seatId) }, ORG)
    expect(scanned.outcome).toBe("cancelled")
  })
})

describe("a ticket type added after plain sign-ups already exist", () => {
  it("still lets leaving cancel the seat and kills the token", async () => {
    const id = seedEvent()
    await service.joinCleanup(id, MEMBER)
    const ticket = await checkin.myTicket({ id }, MEMBER)
    const token = ticket.seats[0]?.ticketToken
    if (token === undefined) throw new Error("expected a ticket token")
    seedTicketType(id)

    await service.leaveCleanup(id, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    const rows = [...registrations.registrations.values()].filter(
      (r) => r.cleanupId === id && r.userId === MEMBER,
    )
    expect(rows.map((r) => r.status)).toEqual(["cancelled"])
    expect(rows[0]?.seats.map((seat) => seat.status)).toEqual(["cancelled"])
    expect((await checkin.scan({ id, token }, ORG)).outcome).toBe("cancelled")
  })

  it("still lets a host removal cancel the seat of the banned attendee", async () => {
    const id = seedEvent()
    await service.joinCleanup(id, MEMBER)
    const ticket = await checkin.myTicket({ id }, MEMBER)
    const token = ticket.seats[0]?.ticketToken
    if (token === undefined) throw new Error("expected a ticket token")
    seedTicketType(id)

    await service.removeMember(id, ORG, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    expect((await registrations.checkinCounters(id)).registered).toBe(0)
    expect((await checkin.scan({ id, token }, ORG)).outcome).toBe("cancelled")
  })
})

describe("leaving a non-ticketed event", () => {
  it("cancels the registration and its seat", async () => {
    const id = seedEvent()
    await service.joinCleanup(id, MEMBER)

    await service.leaveCleanup(id, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    const cancelled = [...registrations.registrations.values()].filter(
      (r) => r.cleanupId === id && r.userId === MEMBER,
    )
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.status).toBe("cancelled")
    expect(cancelled[0]?.seats.map((s) => s.status)).toEqual(["cancelled"])
    expect(await rosterUserIds(id)).toEqual([])
  })

  it("a host removing the attendee cancels it too", async () => {
    const id = seedEvent()
    await service.joinCleanup(id, MEMBER)

    await service.removeMember(id, ORG, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(0)
    expect((await registrations.checkinCounters(id)).registered).toBe(0)
  })

  it("releasing a slot keeps the seat, because releasing keeps membership", async () => {
    const id = seedEvent()
    const slot = repo.seedSlot({ cleanupId: id, title: "Grill" })
    await service.claimEventSlot(id, MEMBER, slot.id)

    await service.claimEventSlot(id, MEMBER, null)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(1)
    expect(await rosterUserIds(id)).toEqual([MEMBER])
  })

  it("re-joining after leaving mints a fresh registration", async () => {
    const id = seedEvent()
    await service.joinCleanup(id, MEMBER)
    await service.leaveCleanup(id, MEMBER)

    await service.joinCleanup(id, MEMBER)

    expect(activeRegistrationsOf(id, MEMBER)).toHaveLength(1)
    expect(
      [...registrations.registrations.values()].filter(
        (r) => r.cleanupId === id && r.userId === MEMBER,
      ),
    ).toHaveLength(2)
  })
})
