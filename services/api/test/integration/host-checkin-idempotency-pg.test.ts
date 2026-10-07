import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CleanupStatus } from "@civfix/shared"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"
import type {
  HostRegistrationRepository,
  SeatDraft,
} from "../../src/services/host/registration-repository.js"

const pg = await withPg()
const tokens = makeTicketTokenSigner("integration-checkin-secret-long-enough")
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const PAST = new Date(Date.now() - 3 * 86_400_000)

describe.skipIf(!pg)("check-in idempotency (integration)", () => {
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
    scheduledAt = FUTURE,
    status: CleanupStatus = "upcoming",
  ): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Check-in sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt,
      status,
    })
  }

  function seats(partySize: number): SeatDraft[] {
    return Array.from({ length: partySize }, () => {
      const id = randomUUID()
      return { id, attendeeName: "Ada", tokenHash: tokens.hashFor(id) }
    })
  }

  async function register(cleanupId: string, userId: string, partySize = 1): Promise<string[]> {
    const outcome = await repo.registerTx({
      cleanupId,
      subject: { kind: "user", userId },
      ticketTypeId: null,
      seats: seats(partySize),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: `checkin-${randomUUID()}`,
      waitlistId: null,
      now: new Date(),
    })
    if (outcome.kind !== "registered") throw new Error(`expected registered, got ${outcome.kind}`)
    return outcome.registration.seats.map((seat) => seat.id)
  }

  it("checks in exactly once under 20 concurrent scans of the same token", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const seatId = (await register(cleanupId, await newUser("Attendee")))[0] as string
    const token = tokens.tokenFor(seatId)
    const now = new Date()

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.checkInByToken({
          cleanupId,
          tokenHash: tokens.hashOf(token),
          actorId: organizer,
          method: "scan",
          now,
        }),
      ),
    )

    expect(results.filter((r) => r.firstTime)).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "checked_in")).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "already")).toHaveLength(19)

    const rows = await h.sql<{ checked_in_at: Date | null; checkin_method: string | null }[]>`
      SELECT checked_in_at, checkin_method FROM cleanup_registration_seats WHERE id = ${seatId}
    `
    expect(rows[0]?.checked_in_at).not.toBeNull()
    expect(rows[0]?.checkin_method).toBe("scan")
  })

  it("answers wrong_event for a token minted on another event and checks nobody in", async () => {
    const organizer = await newUser("Organizer")
    const here = await newCleanup(organizer)
    const there = await newCleanup(organizer)
    const foreignSeat = (await register(there, await newUser("Elsewhere")))[0] as string

    const result = await repo.checkInByToken({
      cleanupId: here,
      tokenHash: tokens.hashFor(foreignSeat),
      actorId: organizer,
      method: "scan",
      now: new Date(),
    })
    expect(result.outcome).toBe("wrong_event")

    const rows = await h.sql<{ checked_in_at: Date | null }[]>`
      SELECT checked_in_at FROM cleanup_registration_seats WHERE id = ${foreignSeat}
    `
    expect(rows[0]?.checked_in_at).toBeNull()
  })

  it("answers unknown_token for a hash no seat holds", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const result = await repo.checkInByToken({
      cleanupId,
      tokenHash: "0".repeat(64),
      actorId: organizer,
      method: "scan",
      now: new Date(),
    })
    expect(result.outcome).toBe("unknown_token")
  })

  it("refuses to mint the same token hash for two seats", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const seatId = (await register(cleanupId, await newUser("Holder")))[0] as string
    const hash = tokens.hashFor(seatId)

    const duplicate = async (): Promise<void> => {
      await h.sql`
        INSERT INTO cleanup_registration_seats (cleanup_id, registration_id, seat_index, ticket_token_hash)
        SELECT ${cleanupId}, registration_id, 9, ${hash}
          FROM cleanup_registration_seats WHERE id = ${seatId}
      `
    }
    await expect(duplicate()).rejects.toMatchObject({ code: "23505" })
  })

  it("clears the whole check-in trio on undo so the pairing CHECK still holds", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const seatId = (await register(cleanupId, await newUser("Attendee")))[0] as string

    await repo.checkInSeat({
      cleanupId,
      seatId,
      actorId: organizer,
      method: "manual",
      now: new Date(),
    })
    const undone = await repo.undoCheckIn({ cleanupId, seatId })
    expect(undone?.checkedInAt).toBeNull()

    const rows = await h.sql<
      { checked_in_at: Date | null; checked_in_by: string | null; checkin_method: string | null }[]
    >`
      SELECT checked_in_at, checked_in_by, checkin_method
        FROM cleanup_registration_seats WHERE id = ${seatId}
    `
    expect(rows[0]).toMatchObject({
      checked_in_at: null,
      checked_in_by: null,
      checkin_method: null,
    })
  })

  it("never lets a seat be both checked in and a no-show", async () => {
    const organizer = await newUser("Organizer")
    const cleanupId = await newCleanup(organizer)
    const seatId = (await register(cleanupId, await newUser("Attendee")))[0] as string
    const now = new Date()

    await repo.checkInSeat({ cleanupId, seatId, actorId: organizer, method: "manual", now })
    expect(await repo.markNoShows({ cleanupId, seatIds: null, now })).toBe(0)

    const forceNoShow = async (): Promise<void> => {
      await h.sql`
        UPDATE cleanup_registration_seats SET no_show_at = ${now} WHERE id = ${seatId}
      `
    }
    await expect(forceNoShow()).rejects.toMatchObject({ code: "23514" })
  })

  it("sweeps no-shows only on finished events, two hours past the end", async () => {
    const organizer = await newUser("Organizer")
    const upcoming = await newCleanup(organizer)
    await register(upcoming, await newUser("Future"))
    expect(await repo.sweepNoShows({ now: new Date(), limit: 100 })).toBe(0)

    const done = await newCleanup(organizer, PAST)
    await register(done, await newUser("Past"))
    await h.sql`UPDATE cleanups SET status = 'done' WHERE id = ${done}`
    expect(await repo.sweepNoShows({ now: new Date(), limit: 100 })).toBe(1)
  })
})
