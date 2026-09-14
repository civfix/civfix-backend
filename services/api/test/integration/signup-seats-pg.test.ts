/**
 * Signup seats against real Postgres (Docker-gated; DECISIONS §44).
 *
 * The unit suite proves the service/repository contract against fakes. Only a live database can prove
 * the three things that are pure SQL: that the free registration's `ON CONFLICT (cleanup_id, user_id)
 * WHERE status = 'registered' AND user_id IS NOT NULL DO NOTHING` actually resolves the partial unique
 * index (a mis-specified arbiter raises 42P10 at plan time, not at review time), that the seat row
 * satisfies every CHECK on `cleanup_registration_seats`, and that the host's roster query and the
 * scanner's token lookup then find the seat the sign-up minted. It also pins the two discriminators
 * the cancel path rests on: a ticket type created AFTER a plain sign-up must not strand an active
 * seat on a departed attendee, and a genuinely ticketed registration must survive a plain leave.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type { CleanupRepository, SignupSeat } from "../../src/services/cleanup-repository.types.js"
import type { HostRegistrationRepository } from "../../src/services/host/registration-repository.types.js"

const pg = await withPg()

describe.skipIf(!pg)("signup seats (integration)", () => {
  let h: PgHarness
  let repo: CleanupRepository
  let host: HostRegistrationRepository

  const tokens = makeTicketTokenSigner("signup-seats-pg-secret-long-enough-here")
  const FUTURE = new Date(Date.now() + 7 * 86_400_000)

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleCleanupRepository(h.sql)
    host = makeDrizzleHostRegistrationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  function seat(): SignupSeat {
    const seatId = randomUUID()
    return { seatId, tokenHash: tokens.hashFor(seatId) }
  }

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newCleanup(
    organizerId: string,
    over: { capacity?: number | null } = {},
  ): Promise<string> {
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Seat sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
      ...(over.capacity !== undefined ? { capacity: over.capacity } : {}),
    })
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${id}, ${organizerId}, 'organizer')
      ON CONFLICT DO NOTHING
    `
    return id
  }

  async function newSlot(cleanupId: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_slots (cleanup_id, title, description, capacity, sort_order)
      VALUES (${cleanupId}, ${"Grill"}, NULL, NULL, 0)
      RETURNING id
    `
    return row!.id
  }

  async function seatRows(
    cleanupId: string,
    userId: string,
  ): Promise<{ seat_id: string; seat_status: string; registration_status: string }[]> {
    return h.sql<{ seat_id: string; seat_status: string; registration_status: string }[]>`
      SELECT s.id AS seat_id, s.status AS seat_status, r.status AS registration_status
      FROM cleanup_registrations r
      LEFT JOIN cleanup_registration_seats s ON s.registration_id = r.id
      WHERE r.cleanup_id = ${cleanupId} AND r.user_id = ${userId}
      ORDER BY r.registered_at, s.seat_index
    `
  }

  async function rosterUserIds(cleanupId: string): Promise<(string | null)[]> {
    const page = await host.listRoster({
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

  it("a join mints one free registration + one seat the roster and the scanner can see", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)

    const minted = seat()
    expect(await repo.joinCleanupTx(cleanupId, volunteer, minted)).toBe("joined")

    const rows = await seatRows(cleanupId, volunteer)
    expect(rows).toEqual([
      { seat_id: minted.seatId, seat_status: "active", registration_status: "registered" },
    ])
    expect(await rosterUserIds(cleanupId)).toContain(volunteer)

    const counters = await host.checkinCounters(cleanupId)
    expect(counters.registered).toBe(1)

    const scanned = await host.checkInByToken({
      cleanupId,
      tokenHash: minted.tokenHash,
      actorId: organizer,
      method: "scan",
      now: new Date(),
    })
    expect(scanned.outcome).toBe("checked_in")
    expect((await host.checkinCounters(cleanupId)).checkedIn).toBe(1)
  })

  it("a second join is a no-op — the partial unique arbiter is resolved, not a 42P10", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)

    await repo.joinCleanupTx(cleanupId, volunteer, seat())
    await repo.joinCleanupTx(cleanupId, volunteer, seat())

    expect(await seatRows(cleanupId, volunteer)).toHaveLength(1)
  })

  it("claiming a slot after joining does not mint a second seat", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)
    const slotId = await newSlot(cleanupId)

    await repo.joinCleanupTx(cleanupId, volunteer, seat())
    expect(await repo.claimSlot(cleanupId, volunteer, slotId, seat())).toEqual({
      kind: "claimed",
      slotId,
    })

    expect(await seatRows(cleanupId, volunteer)).toHaveLength(1)
  })

  it("claiming a slot with no prior join mints the seat", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)
    const slotId = await newSlot(cleanupId)

    await repo.claimSlot(cleanupId, volunteer, slotId, seat())

    expect(await seatRows(cleanupId, volunteer)).toHaveLength(1)
  })

  it("a legacy cleanups.capacity does not gate the sign-up — the slot is the binding gate", async () => {
    const organizer = await newUser("Olive Organizer")
    const first = await newUser("First Volunteer")
    const second = await newUser("Second Volunteer")
    const cleanupId = await newCleanup(organizer, { capacity: 1 })

    expect(await repo.joinCleanupTx(cleanupId, first, seat())).toBe("joined")
    expect(await repo.joinCleanupTx(cleanupId, second, seat())).toBe("joined")

    expect(await seatRows(cleanupId, first)).toHaveLength(1)
    expect(await seatRows(cleanupId, second)).toHaveLength(1)
  })

  it("a ticketed event mints nothing — registerIn owns that path", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)
    await h.sql`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, sort_order)
      VALUES (${cleanupId}, ${"General admission"}, 0)
    `

    await repo.joinCleanupTx(cleanupId, volunteer, seat())

    expect(await seatRows(cleanupId, volunteer)).toEqual([])
  })

  it("leaving cancels the registration and its seat; re-joining mints a fresh one", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)

    await repo.joinCleanupTx(cleanupId, volunteer, seat())
    expect(await repo.leaveCleanup(cleanupId, volunteer)).toBe("left")

    expect(await seatRows(cleanupId, volunteer)).toEqual([
      {
        seat_id: expect.any(String) as unknown as string,
        seat_status: "cancelled",
        registration_status: "cancelled",
      },
    ])
    expect(await rosterUserIds(cleanupId)).not.toContain(volunteer)

    await repo.joinCleanupTx(cleanupId, volunteer, seat())
    expect(await seatRows(cleanupId, volunteer)).toHaveLength(2)
    expect(await rosterUserIds(cleanupId)).toContain(volunteer)
  })

  it("a ticket type added after the sign-up still lets leaving cancel the seat", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)

    const minted = seat()
    await repo.joinCleanupTx(cleanupId, volunteer, minted)
    await h.sql`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, sort_order)
      VALUES (${cleanupId}, ${"General admission"}, 0)
    `

    expect(await repo.leaveCleanup(cleanupId, volunteer)).toBe("left")

    expect(await seatRows(cleanupId, volunteer)).toEqual([
      { seat_id: minted.seatId, seat_status: "cancelled", registration_status: "cancelled" },
    ])
    const scanned = await host.checkInByToken({
      cleanupId,
      tokenHash: minted.tokenHash,
      actorId: organizer,
      method: "scan",
      now: new Date(),
    })
    expect(scanned.outcome).toBe("cancelled")
  })

  it("a plain leave never cancels a ticketed registration", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)
    const [type] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, sort_order)
      VALUES (${cleanupId}, ${"General admission"}, 0)
      RETURNING id
    `
    const [registration] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_registrations (cleanup_id, ticket_type_id, user_id, party_size, status, source)
      VALUES (${cleanupId}, ${type!.id}, ${volunteer}, 1, 'registered', 'self')
      RETURNING id
    `
    const ticketed = seat()
    await h.sql`
      INSERT INTO cleanup_registration_seats (
        id, cleanup_id, registration_id, seat_index, ticket_token_hash, status
      ) VALUES (
        ${ticketed.seatId}, ${cleanupId}, ${registration!.id}, 0, ${ticketed.tokenHash}, 'active'
      )
    `
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role)
      VALUES (${cleanupId}, ${volunteer}, 'member')
      ON CONFLICT DO NOTHING
    `

    expect(await repo.leaveCleanup(cleanupId, volunteer)).toBe("left")

    expect(await seatRows(cleanupId, volunteer)).toEqual([
      { seat_id: ticketed.seatId, seat_status: "active", registration_status: "registered" },
    ])
  })

  it("a host removing an attendee cancels the registration too", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)

    await repo.joinCleanupTx(cleanupId, volunteer, seat())
    expect((await repo.removeMember(cleanupId, volunteer, organizer)).kind).toBe("removed")

    expect((await host.checkinCounters(cleanupId)).registered).toBe(0)
  })

  it("releasing a slot keeps the seat — releasing keeps membership", async () => {
    const organizer = await newUser("Olive Organizer")
    const volunteer = await newUser("Vic Volunteer")
    const cleanupId = await newCleanup(organizer)
    const slotId = await newSlot(cleanupId)

    await repo.claimSlot(cleanupId, volunteer, slotId, seat())
    expect(await repo.releaseSlot(cleanupId, volunteer)).toEqual({ kind: "released" })

    expect(await rosterUserIds(cleanupId)).toContain(volunteer)
  })
})
