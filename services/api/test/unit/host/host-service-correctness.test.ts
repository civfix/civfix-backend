import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { Jobs } from "@civfix/shared/interfaces"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import { makeRegistrationService } from "../../../src/services/host/registration-service.js"
import { makeTicketTypeService } from "../../../src/services/host/ticket-type-service.js"
import { makeQuestionService } from "../../../src/services/host/question-service.js"
import { makeWaitlistService } from "../../../src/services/host/waitlist-service.js"
import { WAITLIST_PROMOTE_JOB } from "../../../src/services/host/registration-queues.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import type { SeatDraft } from "../../../src/services/host/registration-repository.types.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const WAITER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const HOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const NOW = new Date("2026-01-01T12:00:00.000Z")
const HOUR_MS = 60 * 60 * 1000

const tokens = makeTicketTokenSigner("host-service-correctness-secret-long-enough")

function seats(n: number): SeatDraft[] {
  return Array.from({ length: n }, () => {
    const id = randomUUID()
    return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
  })
}

function recordingJobs(): { jobs: Jobs; enqueued: { name: string; payload: unknown }[] } {
  const enqueued: { name: string; payload: unknown }[] = []
  const jobs: Jobs = {
    enqueue: (name, payload) => {
      enqueued.push({ name, payload })
      return Promise.resolve("job")
    },
    schedule: () => Promise.resolve(),
    work: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  }
  return { jobs, enqueued }
}

function seededRepo(): InMemoryHostRegistrationRepository {
  const repo = new InMemoryHostRegistrationRepository()
  repo.tokenHashResolver = (seatId) => tokens.hashFor(seatId)
  repo.seedEvent({
    cleanupId: EVENT,
    scheduledAt: new Date(NOW.getTime() + 24 * HOUR_MS),
    endsAt: new Date(NOW.getTime() + 28 * HOUR_MS),
  })
  repo.seedEvent({ cleanupId: OTHER_EVENT })
  return repo
}

describe("a transfer frees seats on the old ticket type", () => {
  it("wakes the old type's waitlist", async () => {
    const repo = seededRepo()
    const full = repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const roomy = repo.seedTicketType({ cleanupId: EVENT, name: "Roomy", capacity: null })
    const { jobs, enqueued } = recordingJobs()
    const service = makeRegistrationService({
      repo,
      tokens,
      jobs,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      now: () => NOW,
    })
    const registered = await repo.registerTx({
      cleanupId: EVENT,
      subject: { kind: "user", userId: USER },
      ticketTypeId: full.id,
      seats: seats(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "transfer-me",
      waitlistId: null,
      now: NOW,
    })
    if (registered.kind !== "registered") throw new Error(`setup: ${registered.kind}`)
    await repo.joinWaitlist({
      cleanupId: EVENT,
      ticketTypeId: full.id,
      subject: { kind: "user", userId: WAITER },
      partySize: 1,
      accessCodeHash: null,
      now: NOW,
    })

    await service.transfer(
      { id: EVENT, registrationId: registered.registration.id, ticketTypeId: roomy.id },
      HOST,
    )

    expect(enqueued).toEqual([{ name: WAITLIST_PROMOTE_JOB, payload: { ticketTypeId: full.id } }])
  })
})

describe("raising a ticket type's capacity", () => {
  function build() {
    const repo = seededRepo()
    const { jobs, enqueued } = recordingJobs()
    const service = makeTicketTypeService({
      repo,
      jobs,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      now: () => NOW,
    })
    return { repo, service, enqueued }
  }

  it("wakes the waitlist when the cap goes up or is lifted", async () => {
    for (const capacity of [5, null]) {
      const { repo, service, enqueued } = build()
      const type = repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })

      await service.update({ id: EVENT, ticketTypeId: type.id, capacity }, HOST)

      expect(enqueued).toEqual([{ name: WAITLIST_PROMOTE_JOB, payload: { ticketTypeId: type.id } }])
    }
  })

  it("leaves the waitlist alone when the edit frees no seat", async () => {
    const { repo, service, enqueued } = build()
    const type = repo.seedTicketType({ cleanupId: EVENT, capacity: 5, waitlistEnabled: true })

    await service.update({ id: EVENT, ticketTypeId: type.id, name: "Renamed" }, HOST)
    await service.update({ id: EVENT, ticketTypeId: type.id, capacity: 3 }, HOST)

    expect(enqueued).toEqual([])
  })
})

describe("saving questions", () => {
  it("refuses a ticket type from another event as a validation error", async () => {
    const repo = seededRepo()
    const foreign = repo.seedTicketType({ cleanupId: OTHER_EVENT })
    const service = makeQuestionService({ repo, now: () => NOW })

    await expect(
      service.save({
        id: EVENT,
        questions: [
          {
            kind: "short_text",
            prompt: "T-shirt size?",
            required: false,
            ticketTypeId: foreign.id,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { ticketTypeId: "not a ticket type on this event" },
    })
  })

  it("accepts this event's own ticket type", async () => {
    const repo = seededRepo()
    const own = repo.seedTicketType({ cleanupId: EVENT })
    const service = makeQuestionService({ repo, now: () => NOW })

    const saved = await service.save({
      id: EVENT,
      questions: [
        { kind: "short_text", prompt: "T-shirt size?", required: false, ticketTypeId: own.id },
      ],
    })

    expect(saved.items.map((q) => q.ticketTypeId)).toEqual([own.id])
  })
})

describe("a walk-up checked in on arrival", () => {
  it("is checked in by the registration write, not seat by seat afterwards", async () => {
    const repo = seededRepo()
    let seatCheckIns = 0
    const checkInSeat = repo.checkInSeat.bind(repo)
    repo.checkInSeat = (args) => {
      seatCheckIns += 1
      return checkInSeat(args)
    }
    const service = makeRegistrationService({
      repo,
      tokens,
      counters: new InMemoryCounterStore(() => NOW.getTime()),
      now: () => NOW,
    })

    const result = await service.walkup(
      { id: EVENT, name: "Pat Walker", partySize: 2, checkInNow: true },
      HOST,
    )

    expect(seatCheckIns).toBe(0)
    expect(result.registration?.seats.map((seat) => seat.checkedInAt)).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ])
  })
})

describe("waitlist promotion on an event that can no longer happen", () => {
  async function waitingOn(event: { status?: "cancelled"; endsAt?: Date; scheduledAt?: Date }) {
    const repo = seededRepo()
    const type = repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    await repo.joinWaitlist({
      cleanupId: EVENT,
      ticketTypeId: type.id,
      subject: { kind: "user", userId: WAITER },
      partySize: 1,
      accessCodeHash: null,
      now: NOW,
    })
    repo.seedEvent({ ...repo.events.get(EVENT)!, ...event, cleanupId: EVENT })
    const notified: string[] = []
    const service = makeWaitlistService({
      repo,
      registrations: { buildSeatDrafts: seats, eventChanged: () => Promise.resolve() },
      notifier: {
        createNotification: (userId) => {
          notified.push(userId)
          return Promise.resolve()
        },
      },
      now: () => NOW,
    })
    return { repo, service, type, notified }
  }

  it("offers nobody a place on a cancelled event", async () => {
    const { repo, service, type, notified } = await waitingOn({ status: "cancelled" })

    await expect(service.runPromote({ ticketTypeId: type.id })).resolves.toBe(0)
    expect(notified).toEqual([])
    expect(repo.ticketTypes.get(type.id)?.reservedSeats).toBe(0)
  })

  it("offers nobody a place on an event that has already ended", async () => {
    const { service, type, notified } = await waitingOn({
      scheduledAt: new Date(NOW.getTime() - 6 * HOUR_MS),
      endsAt: new Date(NOW.getTime() - HOUR_MS),
    })

    await expect(service.runPromote({ ticketTypeId: type.id })).resolves.toBe(0)
    expect(notified).toEqual([])
  })
})
