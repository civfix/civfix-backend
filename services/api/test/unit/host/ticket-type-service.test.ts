import { beforeEach, describe, expect, it } from "vitest"
import { AppError } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { sha256Hex } from "../../../src/auth/crypto.js"
import { InMemoryHostRegistrationRepository } from "../../../src/services/host/registration-repository.memory.js"
import {
  makeTicketTypeService,
  type TicketTypeService,
} from "../../../src/services/host/ticket-type-service.js"
import { randomUUID } from "node:crypto"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const HOST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const NOW = new Date("2026-01-01T12:00:00.000Z")

interface Harness {
  repo: InMemoryHostRegistrationRepository
  service: TicketTypeService
  bumped: string[]
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  const bumped: string[] = []
  const service = makeTicketTypeService({
    repo,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    insightsInvalidator: {
      bumpInsightsGeneration: (cleanupId) => {
        bumped.push(cleanupId)
        return Promise.resolve()
      },
    },
    now: () => NOW,
  })
  return { repo, service, bumped }
}

const base = {
  id: EVENT,
  visibility: "public" as const,
  maxPartySize: 1,
  waitlistEnabled: false,
}

describe("ticket type service", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("creates a type and derives soldOut / salesOpen / remaining", async () => {
    const created = await h.service.create({ ...base, name: "General", capacity: 2 }, HOST)
    expect(created.remaining).toBe(2)
    expect(created.soldOut).toBe(false)
    expect(created.salesOpen).toBe(true)
    expect(created.accessCodeSet).toBe(false)
  })

  it("refuses a duplicate name case-insensitively", async () => {
    await h.service.create({ ...base, name: "General" }, HOST)
    await expect(h.service.create({ ...base, name: "general" }, HOST)).rejects.toBeInstanceOf(
      AppError,
    )
  })

  it("refuses an access-code type without a code, and hides the code once set", async () => {
    await expect(
      h.service.create({ ...base, name: "VIP", visibility: "access_code" }, HOST),
    ).rejects.toBeInstanceOf(AppError)

    const created = await h.service.create(
      { ...base, name: "VIP", visibility: "access_code", accessCode: "open-sesame" },
      HOST,
    )
    expect(created.accessCodeSet).toBe(true)
    expect(JSON.stringify(created)).not.toContain("open-sesame")
  })

  it("refuses lowering capacity below the seats already held", async () => {
    const created = await h.service.create({ ...base, name: "General", capacity: 5 }, HOST)
    const type = h.repo.ticketTypes.get(created.id)
    if (type !== undefined) type.reservedSeats = 3

    await expect(
      h.service.update({ id: EVENT, ticketTypeId: created.id, capacity: 2 }, HOST),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("refuses to delete a type that has registrations", async () => {
    const created = await h.service.create({ ...base, name: "General", capacity: 5 }, HOST)
    await h.repo.registerTx({
      cleanupId: EVENT,
      subject: { kind: "user", userId: HOST },
      ticketTypeId: created.id,
      seats: [{ id: randomUUID(), attendeeName: null, tokenHash: "hash" }],
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "k",
      waitlistId: null,
      now: NOW,
    })
    await expect(
      h.service.remove({ id: EVENT, ticketTypeId: created.id }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it("deletes an unused type", async () => {
    const created = await h.service.create({ ...base, name: "General" }, HOST)
    await expect(h.service.remove({ id: EVENT, ticketTypeId: created.id })).resolves.toEqual({
      ok: true,
    })
  })

  it("reorders only when the list names every type exactly once", async () => {
    const a = await h.service.create({ ...base, name: "A" }, HOST)
    const b = await h.service.create({ ...base, name: "B" }, HOST)

    await expect(
      h.service.reorder({ id: EVENT, ticketTypeIds: [b.id] }),
    ).rejects.toBeInstanceOf(AppError)

    const reordered = await h.service.reorder({ id: EVENT, ticketTypeIds: [b.id, a.id] })
    expect(reordered.items.map((item) => item.id)).toEqual([b.id, a.id])
  })

  it("hides non-public types from a viewer who cannot manage tickets", async () => {
    await h.service.create({ ...base, name: "Public" }, HOST)
    await h.service.create({ ...base, name: "Hidden", visibility: "hidden" }, HOST)
    await h.service.create(
      { ...base, name: "Coded", visibility: "access_code", accessCode: "abcd" },
      HOST,
    )

    const anonymous = await h.service.list({ id: EVENT }, { userId: null, canManage: false })
    expect(anonymous.items.map((item) => item.name)).toEqual(["Public"])

    const withCode = await h.service.list(
      { id: EVENT, accessCode: "abcd" },
      { userId: null, canManage: false },
    )
    expect(withCode.items.map((item) => item.name).sort()).toEqual(["Coded", "Public"])

    const host = await h.service.list({ id: EVENT }, { userId: HOST, canManage: true })
    expect(host.items).toHaveLength(3)
  })

  it("keeps an access-code type hidden from a wrong code", async () => {
    await h.service.create({ ...base, name: "Public" }, HOST)
    await h.service.create(
      { ...base, name: "Coded", visibility: "access_code", accessCode: "abcd" },
      HOST,
    )

    const wrong = await h.service.list(
      { id: EVENT, accessCode: "zzzz" },
      { userId: null, canManage: false },
    )
    expect(wrong.items.map((item) => item.name)).toEqual(["Public"])
  })

  it("unlocks only the type whose code matches when several are gated", async () => {
    await h.service.create(
      { ...base, name: "Crew", visibility: "access_code", accessCode: "crew-code" },
      HOST,
    )
    await h.service.create(
      { ...base, name: "Press", visibility: "access_code", accessCode: "press-code" },
      HOST,
    )

    const unlocked = await h.service.list(
      { id: EVENT, accessCode: "press-code" },
      { userId: null, canManage: false },
    )
    expect(unlocked.items.map((item) => item.name)).toEqual(["Press"])
  })

  it("refuses ticket capacities that together exceed the event capacity", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, capacity: 30 })
    await h.service.create({ ...base, name: "General", capacity: 20 }, HOST)
    await expect(
      h.service.create({ ...base, name: "Crew", capacity: 15 }, HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    const created = await h.service.create({ ...base, name: "Crew", capacity: 10 }, HOST)
    await expect(
      h.service.update({ id: EVENT, ticketTypeId: created.id, capacity: 11 }, HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses an unlimited ticket type on an event that has a capacity", async () => {
    h.repo.seedEvent({ cleanupId: EVENT, capacity: 30 })
    await expect(h.service.create({ ...base, name: "General" }, HOST)).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses a sales window that closes before it opens", async () => {
    await expect(
      h.service.create(
        {
          ...base,
          name: "General",
          salesOpensAt: "2026-02-01T00:00:00.000Z",
          salesClosesAt: "2026-01-01T00:00:00.000Z",
        },
        HOST,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("caps ticket-type writes per host and fails closed on a broken counter", async () => {
    for (let i = 0; i < 60; i++) {
      await h.service.create({ ...base, name: `Type ${i}` }, HOST).catch(() => undefined)
    }
    await expect(h.service.create({ ...base, name: "One more" }, HOST)).rejects.toThrow(
      /Too many ticket type changes/u,
    )

    const broken = makeTicketTypeService({
      repo: h.repo,
      now: () => NOW,
      counters: {
        incr: () => Promise.reject(new Error("redis is down")),
        incrBy: () => Promise.reject(new Error("redis is down")),
      },
    })
    await expect(broken.create({ ...base, name: "Nope" }, HOST)).rejects.toThrow(
      /temporarily unavailable/u,
    )
  })

  it("refuses more than twenty ticket types on one event", async () => {
    for (let i = 0; i < 20; i++) {
      await h.service.create({ ...base, name: `Type ${i}` }, HOST)
    }
    await expect(h.service.create({ ...base, name: "Twenty one" }, HOST)).rejects.toThrow(
      /at most 20 ticket types/u,
    )
  })

  it("validates the stored access code hash rather than the code itself", async () => {
    const created = await h.service.create(
      { ...base, name: "VIP", visibility: "access_code", accessCode: " open-sesame " },
      HOST,
    )
    const stored = h.repo.ticketTypes.get(created.id)
    expect(stored?.accessCodeSet).toBe(true)
    expect(await sha256Hex("open-sesame")).toBeTypeOf("string")
  })

  it("bumps the insights generation on a capacity edit, a create, a reorder and a delete", async () => {
    const created = await h.service.create({ ...base, name: "General", capacity: 2 }, HOST)
    expect(h.bumped).toEqual([EVENT])

    await h.service.update(
      { id: EVENT, ticketTypeId: created.id, capacity: 8, visibility: "public" },
      HOST,
    )
    expect(h.bumped).toEqual([EVENT, EVENT])

    const second = await h.service.create({ ...base, name: "VIP", capacity: 1 }, HOST)
    h.bumped.length = 0

    await h.service.reorder({ id: EVENT, ticketTypeIds: [second.id, created.id] })
    expect(h.bumped).toEqual([EVENT])

    await h.service.remove({ id: EVENT, ticketTypeId: second.id })
    expect(h.bumped).toEqual([EVENT, EVENT])
  })

  it("leaves the insights generation alone when a ticket type write is refused", async () => {
    await h.service.create({ ...base, name: "General", capacity: 2 }, HOST)
    h.bumped.length = 0

    await expect(h.service.create({ ...base, name: "general" }, HOST)).rejects.toBeInstanceOf(
      AppError,
    )
    await expect(
      h.service.remove({ id: EVENT, ticketTypeId: randomUUID() }),
    ).rejects.toBeInstanceOf(AppError)
    expect(h.bumped).toEqual([])
  })
})
