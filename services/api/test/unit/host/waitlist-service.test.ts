import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { sha256Hex } from "../../../src/auth/crypto.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makeWaitlistService,
  WAITLIST_CLAIM_WINDOW_MS,
  type WaitlistService,
} from "../../../src/services/host/waitlist-service.js"
import type { SeatDraft } from "../../../src/services/host/registration-repository.types.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ALICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const BOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const HOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

const tokens = makeTicketTokenSigner("waitlist-service-test-secret-long-enough")

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: WaitlistService
  now(): Date
  advance(ms: number): void
  enqueued: string[]
  notified: string[]
  bumped: string[]
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  const state = { base: new Date("2026-01-01T12:00:00.000Z").getTime(), tick: 0 }
  const clock = (): Date => new Date(state.base + state.tick++)
  const enqueued: string[] = []
  const notified: string[] = []
  const bumped: string[] = []
  const seats = (partySize: number): SeatDraft[] =>
    Array.from({ length: partySize }, () => {
      const id = randomUUID()
      return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
    })

  const service = makeWaitlistService({
    repo,
    registrations: {
      buildSeatDrafts: seats,
      eventChanged: (cleanupId: string) => {
        bumped.push(cleanupId)
        return Promise.resolve()
      },
    },
    jobs: {
      enqueue: (name) => {
        enqueued.push(name)
        return Promise.resolve("job")
      },
      schedule: () => Promise.resolve(),
      work: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      fail: () => Promise.resolve(),
    },
    notifier: {
      createNotification: (userId) => {
        notified.push(userId)
        return Promise.resolve(null)
      },
    },
    now: clock,
  })
  return {
    repo,
    service,
    now: clock,
    advance: (ms: number) => {
      state.base += ms
    },
    enqueued,
    notified,
    bumped,
  }
}

describe("waitlist service", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("refuses to join a ticket type with no waitlist", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1 })
    await expect(
      h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: ALICE }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("joins, reports the FIFO position and is idempotent", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const first = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    const second = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: BOB },
    )
    const again = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )

    expect(first.entry.position).toBe(1)
    expect(second.entry.position).toBe(2)
    expect(again.entry.id).toBe(first.entry.id)
  })

  it("promotes strictly FIFO, holds the seat and notifies the offered member", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: ALICE })
    await h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: BOB })

    const offered = await h.service.runPromote({ ticketTypeId: type.id })
    expect(offered).toBe(1)
    expect(h.notified).toEqual([ALICE])
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(1)

    expect(await h.service.runPromote({ ticketTypeId: type.id })).toBe(0)
  })

  it("blocks at the head of the queue rather than skipping a party that does not fit", async () => {
    const type = h.repo.seedTicketType({
      cleanupId: EVENT,
      capacity: 2,
      maxPartySize: 4,
      waitlistEnabled: true,
    })
    await h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 4 }, { kind: "user", userId: ALICE })
    await h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: BOB })

    expect(await h.service.runPromote({ ticketTypeId: type.id })).toBe(0)
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
    expect(h.notified).toEqual([])
  })

  it("claims an offer into a real registration without double-reserving", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 2, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 2 },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })

    const claimed = await h.service.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      { kind: "user", userId: ALICE },
    )
    expect(claimed.outcome).toBe("claimed")
    expect(claimed.registrationId).not.toBeNull()
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(2)
  })

  it("refuses a claim from someone else's offer", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })

    const claimed = await h.service.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      { kind: "user", userId: BOB },
    )
    expect(claimed.outcome).toBe("not_found")
  })

  it("reports not_offered for an entry still waiting", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    const claimed = await h.service.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      { kind: "user", userId: ALICE },
    )
    expect(claimed.outcome).toBe("not_offered")
  })

  it("expires a stale offer, releases the held seats and re-enqueues the promoter", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(1)

    h.advance(WAITLIST_CLAIM_WINDOW_MS + 1000)
    const expired = await h.service.runExpireSweep()

    expect(expired).toBe(1)
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
    expect(h.repo.waitlist.get(joined.entry.id)?.status).toBe("expired")
    expect(h.enqueued).toContain("waitlist.promote")
  })

  it("releases the held seats when an offered member leaves the queue", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: ALICE })
    await h.service.runPromote({ ticketTypeId: type.id })

    await h.service.leave({ id: EVENT, ticketTypeId: type.id }, { kind: "user", userId: ALICE })
    expect(h.repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
  })

  it("refuses a host promote of an entry that is no longer waiting", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })
    await expect(
      h.service.promote({ id: EVENT, waitlistId: joined.entry.id }, HOST),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("promotes the entry the host addressed, not the head of the queue", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 2, waitlistEnabled: true })
    const first = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    const second = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: BOB },
    )

    const promoted = await h.service.promote({ id: EVENT, waitlistId: second.entry.id }, HOST)

    expect(promoted.entry.id).toBe(second.entry.id)
    expect(promoted.entry.status).toBe("offered")
    expect(h.notified).toEqual([BOB])
    expect(h.repo.waitlist.get(first.entry.id)?.status).toBe("waiting")
  })

  it("requires the access code to join a gated ticket type and never asks again at claim", async () => {
    const type = h.repo.seedTicketType({
      cleanupId: EVENT,
      capacity: 1,
      waitlistEnabled: true,
      visibility: "access_code",
      accessCodeSet: true,
    })
    const codeHash = await sha256Hex("open-sesame")
    h.repo.setAccessCode(type.id, codeHash)

    await expect(
      h.service.join(
        { id: EVENT, ticketTypeId: type.id, partySize: 1 },
        { kind: "user", userId: ALICE },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      h.service.join(
        { id: EVENT, ticketTypeId: type.id, partySize: 1, accessCode: "wrong" },
        { kind: "user", userId: ALICE },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1, accessCode: "open-sesame" },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })

    const claimed = await h.service.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      { kind: "user", userId: ALICE },
    )
    expect(claimed.outcome).toBe("claimed")
  })

  it("re-enqueues the promoter when an offered member leaves the queue", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    await h.service.runPromote({ ticketTypeId: type.id })
    h.enqueued.length = 0

    await h.service.leave({ id: EVENT, ticketTypeId: type.id }, { kind: "user", userId: ALICE })
    expect(h.enqueued).toEqual(["waitlist.promote"])
  })

  it("refuses to join when already registered", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 5, waitlistEnabled: true })
    await h.repo.registerTx({
      cleanupId: EVENT,
      subject: { kind: "user", userId: ALICE },
      ticketTypeId: type.id,
      seats: [{ id: randomUUID(), attendeeName: null, tokenHash: "hash" }],
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "k",
      waitlistId: null,
      now: h.now(),
    })
    await expect(
      h.service.join({ id: EVENT, ticketTypeId: type.id, partySize: 1 }, { kind: "user", userId: ALICE }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("bumps the insights generation on join, promote, claim and leave", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 2, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    expect(h.bumped).toEqual([EVENT])

    await h.service.runPromote({ ticketTypeId: type.id })
    expect(h.bumped).toEqual([EVENT, EVENT])

    await h.service.claim(
      { id: EVENT, waitlistId: joined.entry.id },
      { kind: "user", userId: ALICE },
    )
    expect(h.bumped).toEqual([EVENT, EVENT, EVENT])

    await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: BOB },
    )
    h.bumped.length = 0
    await h.service.leave({ id: EVENT, ticketTypeId: type.id }, { kind: "user", userId: BOB })
    expect(h.bumped).toEqual([EVENT])
  })

  it("bumps the insights generation when the host promotes an entry", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joined = await h.service.join(
      { id: EVENT, ticketTypeId: type.id, partySize: 1 },
      { kind: "user", userId: ALICE },
    )
    h.bumped.length = 0

    await h.service.promote({ id: EVENT, waitlistId: joined.entry.id }, HOST)
    expect(h.bumped).toEqual([EVENT])
  })

  it("leaves the insights generation alone when a waitlist mutation changes nothing", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await h.service.leave({ id: EVENT, ticketTypeId: type.id }, { kind: "user", userId: ALICE })
    expect(h.bumped).toEqual([])

    await expect(
      h.service.promote({ id: EVENT, waitlistId: randomUUID() }, HOST),
    ).rejects.toBeInstanceOf(AppError)
    expect(h.bumped).toEqual([])
  })
})
