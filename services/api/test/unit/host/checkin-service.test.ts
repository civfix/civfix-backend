import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { sha256Hex } from "../../../src/auth/crypto.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makeCheckinService,
  type CheckinService,
} from "../../../src/services/host/checkin-service.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import type { SeatDraft } from "../../../src/services/host/registration-repository.types.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const ATTENDEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const GUEST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const GUEST_NAME = "Grace Hopper"
const NOW = new Date("2026-01-01T12:00:00.000Z")

const tokens = makeTicketTokenSigner("checkin-service-test-secret-long-enough")

interface GuestTokenRecord {
  id: string
  cleanupId: string
  cancelledAt: Date | null
}

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: CheckinService
  audits: string[]
  bumped: string[]
  /** Raw manage token -> the guest row it resolves to, mirroring cleanup_guests.manage_token_hash. */
  guestTokens: Map<string, GuestTokenRecord>
}

function seats(partySize: number, name: string | null = null): SeatDraft[] {
  return Array.from({ length: partySize }, () => {
    const id = randomUUID()
    return { id, attendeeName: name, tokenHash: tokens.hashFor(id) }
  })
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  repo.seedEvent({ cleanupId: EVENT })
  repo.seedEvent({ cleanupId: OTHER_EVENT })
  const audits: string[] = []
  const bumped: string[] = []
  const guestTokens = new Map<string, GuestTokenRecord>([
    ["guest-manage-token", { id: GUEST, cleanupId: EVENT, cancelledAt: null }],
  ])
  const service = makeCheckinService({
    repo,
    tokens,
    registrations: {
      eventChanged: (cleanupId: string) => {
        bumped.push(cleanupId)
        return Promise.resolve()
      },
    },
    guestByManageToken: async (hash) => {
      for (const [raw, record] of guestTokens) {
        if (hash === (await sha256Hex(raw))) return record
      }
      return null
    },
    audit: (input) => {
      audits.push(input.action)
      return Promise.resolve()
    },
    now: () => NOW,
  })
  return { repo, service, audits, bumped, guestTokens }
}

/** Seat a guest the way the guest RSVP bridge does: a cleanup_guests row plus a guest-subject registration. */
async function registerGuest(
  repo: InMemoryHostRegistrationRepository,
  partySize = 1,
  attendeeName: string | null = null,
): Promise<{ registrationId: string; seatIds: string[] }> {
  repo.guests.set(GUEST, { id: GUEST, cleanupId: EVENT, name: GUEST_NAME })
  const outcome = await repo.registerTx({
    cleanupId: EVENT,
    subject: { kind: "guest", guestId: GUEST },
    ticketTypeId: null,
    seats: seats(partySize, attendeeName),
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "self",
    idempotencyKey: `guest:${GUEST}`,
    waitlistId: null,
    now: NOW,
  })
  if (outcome.kind !== "registered") throw new Error(`expected registered, got ${outcome.kind}`)
  return {
    registrationId: outcome.registration.id,
    seatIds: outcome.registration.seats.map((seat) => seat.id),
  }
}

async function register(
  repo: InMemoryHostRegistrationRepository,
  cleanupId: string,
  partySize = 1,
): Promise<{ registrationId: string; seatIds: string[] }> {
  const drafts = seats(partySize, "Ada")
  const outcome = await repo.registerTx({
    cleanupId,
    subject: { kind: "user", userId: ATTENDEE },
    ticketTypeId: null,
    seats: drafts,
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "self",
    idempotencyKey: `k-${randomUUID()}`,
    waitlistId: null,
    now: NOW,
  })
  if (outcome.kind !== "registered") throw new Error(`expected registered, got ${outcome.kind}`)
  return {
    registrationId: outcome.registration.id,
    seatIds: outcome.registration.seats.map((seat) => seat.id),
  }
}

describe("check-in service", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("checks a scanned ticket in once and reports a replay as already", async () => {
    const { seatIds } = await register(h.repo, EVENT)
    const token = tokens.tokenFor(seatIds[0] as string)

    const first = await h.service.scan({ id: EVENT, token }, STAFF)
    expect(first.outcome).toBe("checked_in")
    expect(first.firstTime).toBe(true)
    expect(h.audits).toContain("event.attendee_checked_in")

    const replay = await h.service.scan({ id: EVENT, token }, STAFF)
    expect(replay.outcome).toBe("already")
    expect(replay.firstTime).toBe(false)
    expect(replay.checkedInAt).toBe(first.checkedInAt)
  })

  it("reports wrong_event for a ticket minted on another event", async () => {
    const { seatIds } = await register(h.repo, OTHER_EVENT)
    const result = await h.service.scan(
      { id: EVENT, token: tokens.tokenFor(seatIds[0] as string) },
      STAFF,
    )
    expect(result.outcome).toBe("wrong_event")
    expect(result.seat).toBeNull()
  })

  it("reports unknown_token for a token no seat ever held", async () => {
    const result = await h.service.scan({ id: EVENT, token: "AAAAAAAAAAAAAAAAAAAAAAAAAA" }, STAFF)
    expect(result.outcome).toBe("unknown_token")
  })

  it("reports cancelled for a seat whose registration was cancelled", async () => {
    const { registrationId, seatIds } = await register(h.repo, EVENT)
    await h.repo.cancelRegistration({ cleanupId: EVENT, registrationId, actorId: STAFF, now: NOW })
    const result = await h.service.scan(
      { id: EVENT, token: tokens.tokenFor(seatIds[0] as string) },
      STAFF,
    )
    expect(result.outcome).toBe("cancelled")
  })

  it("reports no_show for a seat already marked absent", async () => {
    const { seatIds } = await register(h.repo, EVENT)
    await h.service.markNoShows({ id: EVENT, all: true }, STAFF)
    const result = await h.service.scan(
      { id: EVENT, token: tokens.tokenFor(seatIds[0] as string) },
      STAFF,
    )
    expect(result.outcome).toBe("no_show")
  })

  it("checks a seat in manually and undoes it", async () => {
    const { seatIds } = await register(h.repo, EVENT)
    const seatId = seatIds[0] as string

    const done = await h.service.checkIn({ id: EVENT, seatId, method: "manual" }, STAFF)
    expect(done.outcome).toBe("checked_in")
    expect(done.seat?.checkinMethod).toBe("manual")

    const undone = await h.service.undo({ id: EVENT, seatId }, STAFF)
    expect(undone.seat?.checkedInAt).toBeNull()
    expect(h.audits).toContain("event.attendee_checkin_undone")
  })

  it("404s an unknown seat rather than silently succeeding", async () => {
    await expect(
      h.service.checkIn({ id: EVENT, seatId: randomUUID(), method: "manual" }, STAFF),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("refuses a no-show call that names neither seats nor all", async () => {
    await expect(
      h.service.markNoShows({ id: EVENT, all: false, seatIds: [] }, STAFF),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("never marks an already checked-in seat as a no-show", async () => {
    const { seatIds } = await register(h.repo, EVENT, 2)
    await h.service.checkIn({ id: EVENT, seatId: seatIds[0] as string, method: "manual" }, STAFF)
    const result = await h.service.markNoShows({ id: EVENT, all: true }, STAFF)
    expect(result.marked).toBe(1)
  })

  it("sweeps no-shows only once the event's end plus the live tail has passed", async () => {
    await register(h.repo, EVENT, 2)
    expect(await h.service.runNoShowSweep()).toBe(0)

    // Ended, but still inside the 2 h wrap-up tail: late check-ins are still possible.
    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: new Date(NOW.getTime() - 5 * 3_600_000),
      endsAt: new Date(NOW.getTime() - 60_000),
    })
    expect(await h.service.runNoShowSweep()).toBe(0)

    h.repo.seedEvent({
      cleanupId: EVENT,
      scheduledAt: new Date(NOW.getTime() - 8 * 3_600_000),
      endsAt: new Date(NOW.getTime() - 4 * 3_600_000),
    })
    expect(await h.service.runNoShowSweep()).toBe(2)
  })

  it("never sweeps a cancelled event", async () => {
    await register(h.repo, EVENT, 2)
    h.repo.seedEvent({
      cleanupId: EVENT,
      status: "cancelled",
      scheduledAt: new Date(NOW.getTime() - 8 * 3_600_000),
      endsAt: new Date(NOW.getTime() - 4 * 3_600_000),
    })
    expect(await h.service.runNoShowSweep()).toBe(0)
  })

  it("reports live counters for the host", async () => {
    const { seatIds } = await register(h.repo, EVENT, 3)
    await h.service.checkIn({ id: EVENT, seatId: seatIds[0] as string, method: "manual" }, STAFF)
    const counters = await h.service.counters({ id: EVENT })
    expect(counters.registered).toBe(3)
    expect(counters.checkedIn).toBe(1)
    expect(counters.asOf).toBe(NOW.toISOString())
  })

  it("hands the owner their own ticket with a recomputed token per seat", async () => {
    const { seatIds } = await register(h.repo, EVENT, 2)
    const ticket = await h.service.myTicket({ id: EVENT }, ATTENDEE)
    expect(ticket.seats.map((seat) => seat.ticketToken)).toEqual(
      seatIds.map((seatId) => tokens.tokenFor(seatId)),
    )
    expect(ticket.canCancel).toBe(true)
  })

  it("404s a ticket read for someone with no registration", async () => {
    await expect(h.service.myTicket({ id: EVENT }, STAFF)).rejects.toBeInstanceOf(AppError)
  })

  it("refuses a guest ticket read behind an unknown manage token", async () => {
    await expect(h.service.guestTicket({ token: "x".repeat(32) })).rejects.toBeInstanceOf(AppError)
  })

  it("names a guest on a scanned seat that carries no attendee name of its own", async () => {
    const { seatIds } = await registerGuest(h.repo)
    const result = await h.service.scan(
      { id: EVENT, token: tokens.tokenFor(seatIds[0] as string) },
      STAFF,
    )
    expect(result.outcome).toBe("checked_in")
    expect(result.attendeeName).toBe(GUEST_NAME)
  })

  it("names a guest on a MANUAL seat check-in too", async () => {
    const { seatIds } = await registerGuest(h.repo)
    const result = await h.service.checkIn(
      { id: EVENT, seatId: seatIds[0] as string, method: "manual" },
      STAFF,
    )
    expect(result.attendeeName).toBe(GUEST_NAME)
  })

  it("prefers a per-seat attendee name over the guest's own name", async () => {
    const { seatIds } = await registerGuest(h.repo, 1, "Plus One")
    const result = await h.service.scan(
      { id: EVENT, token: tokens.tokenFor(seatIds[0] as string) },
      STAFF,
    )
    expect(result.attendeeName).toBe("Plus One")
  })
})

/**
 * `getGuestEventTicket` is the guest's ONLY read of their own seat tokens: it is `auth: "public"` and
 * secured solely by the bearer manage token in the POST body. These tests pin that the token is the
 * whole authorisation - a cancelled RSVP, a rotated token and an unknown token are all refused with
 * the same 404, so the endpoint cannot be used to probe whether an address ever RSVP'd.
 */
describe("guest ticket", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("hands a guest their live seat tokens behind a valid manage token", async () => {
    const { registrationId, seatIds } = await registerGuest(h.repo, 2)

    const ticket = await h.service.guestTicket({ token: "guest-manage-token" })

    expect(ticket.cleanupId).toBe(EVENT)
    expect(ticket.registrationId).toBe(registrationId)
    expect(ticket.status).toBe("registered")
    expect(ticket.seats.map((seat) => seat.ticketToken)).toEqual(
      seatIds.map((seatId) => tokens.tokenFor(seatId)),
    )
    expect(ticket.canCancel).toBe(true)
  })

  it("hands back a token a host scan then accepts, closing the loop", async () => {
    await registerGuest(h.repo)
    const ticket = await h.service.guestTicket({ token: "guest-manage-token" })
    const token = ticket.seats[0]?.ticketToken as string

    expect((await h.service.scan({ id: EVENT, token }, STAFF)).outcome).toBe("checked_in")
  })

  it("refuses a guest whose RSVP was cancelled, even though the token still resolves", async () => {
    await registerGuest(h.repo)
    h.guestTokens.set("guest-manage-token", {
      id: GUEST,
      cleanupId: EVENT,
      cancelledAt: NOW,
    })

    await expect(h.service.guestTicket({ token: "guest-manage-token" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("kills the OLD token once re-verifying rotated the manage token", async () => {
    await registerGuest(h.repo)
    await expect(h.service.guestTicket({ token: "guest-manage-token" })).resolves.toBeDefined()

    h.guestTokens.delete("guest-manage-token")
    h.guestTokens.set("guest-manage-token-rotated", {
      id: GUEST,
      cleanupId: EVENT,
      cancelledAt: null,
    })

    await expect(h.service.guestTicket({ token: "guest-manage-token" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      h.service.guestTicket({ token: "guest-manage-token-rotated" }),
    ).resolves.toBeDefined()
  })

  it("refuses a guest row that never got a registration (the swallowed-bridge case)", async () => {
    await expect(h.service.guestTicket({ token: "guest-manage-token" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("refuses every failure mode with the SAME message, so it cannot enumerate RSVPs", async () => {
    const messages: string[] = []
    for (const token of ["guest-manage-token", "x".repeat(32)]) {
      await h.service.guestTicket({ token }).catch((err: unknown) => {
        messages.push((err as AppError).message)
      })
    }
    expect(new Set(messages).size).toBe(1)
  })

  it("bumps the insights generation on every attendance change", async () => {
    const { seatIds } = await register(h.repo, EVENT, 2)
    const seatId = seatIds[0] as string

    await h.service.checkIn({ id: EVENT, seatId, method: "manual" }, STAFF)
    expect(h.bumped).toEqual([EVENT])

    await h.service.undo({ id: EVENT, seatId }, STAFF)
    expect(h.bumped).toEqual([EVENT, EVENT])

    await h.service.scan({ id: EVENT, token: tokens.tokenFor(seatId) }, STAFF)
    expect(h.bumped).toEqual([EVENT, EVENT, EVENT])

    await h.service.markNoShows({ id: EVENT, all: true }, STAFF)
    expect(h.bumped).toEqual([EVENT, EVENT, EVENT, EVENT])
  })

  it("leaves the insights generation alone when nothing changed", async () => {
    await register(h.repo, EVENT)
    await h.service.scan({ id: EVENT, token: "AAAAAAAAAAAAAAAAAAAAAAAAAA" }, STAFF)
    await h.service.markNoShows({ id: EVENT, all: false, seatIds: [randomUUID()] }, STAFF)
    expect(h.bumped).toEqual([])
  })
})
