import { beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { RegisterForEventRequest } from "@civfix/shared"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryHostRegistrationRepository } from "../../helpers/host/registration-repository.memory.js"
import { makeDrizzleHostRegistrationRepository } from "../../../src/services/host/registration-repository.drizzle.js"
import type {
  QuestionRecord,
  RegisterTxArgs,
  SeatDraft,
} from "../../../src/services/host/registration-repository.js"
import {
  makeRegistrationService,
  type RegistrationService,
} from "../../../src/services/host/registration-service.js"
import { makeQuestionService } from "../../../src/services/host/question-service.js"
import {
  makeWaitlistService,
  WAITLIST_CLAIM_WINDOW_MS,
  type WaitlistService,
} from "../../../src/services/host/waitlist-service.js"
import { makeTicketTokenSigner } from "../../../src/services/host/ticket-token.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const BANNED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const HOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const HIDDEN_TYPE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const REGISTRATION = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const NOW = new Date("2026-01-01T12:00:00.000Z")

const tokens = makeTicketTokenSigner("registration-security-test-secret-long-enough")

interface Harness {
  repo: InMemoryHostRegistrationRepository
  registrations: RegistrationService
  waitlist: WaitlistService
  enqueued: string[]
}

function seatsFor(partySize: number): SeatDraft[] {
  return Array.from({ length: partySize }, () => {
    const id = randomUUID()
    return { id, attendeeName: null, tokenHash: tokens.hashFor(id) }
  })
}

function build(): Harness {
  const repo = new InMemoryHostRegistrationRepository()
  repo.seedEvent({ cleanupId: EVENT })
  const enqueued: string[] = []
  const jobs = {
    enqueue: (_name: string, payload: unknown) => {
      enqueued.push((payload as { ticketTypeId: string }).ticketTypeId)
      return Promise.resolve("job")
    },
    schedule: () => Promise.resolve(),
    work: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  }
  const registrations = makeRegistrationService({
    repo,
    tokens,
    jobs,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    now: () => NOW,
  })
  const waitlist = makeWaitlistService({
    repo,
    registrations: {
      buildSeatDrafts: seatsFor,
      eventChanged: () => Promise.resolve(),
    },
    jobs,
    now: () => NOW,
  })
  return { repo, registrations, waitlist, enqueued }
}

function request(over: Partial<RegisterForEventRequest> = {}): RegisterForEventRequest {
  return {
    id: EVENT,
    idempotencyKey: `key-${randomUUID()}`,
    partySize: 1,
    joinWaitlistIfFull: false,
    ...over,
  }
}

function question(over: Partial<QuestionRecord>): QuestionRecord {
  return {
    id: randomUUID(),
    cleanupId: EVENT,
    ticketTypeId: null,
    kind: "short_text",
    prompt: "Any access needs?",
    helpText: null,
    required: false,
    options: [],
    maxSelections: null,
    consentText: null,
    showIf: null,
    sortOrder: 0,
    archivedAt: null,
    ...over,
  }
}

describe("hidden ticket types are host-assigned only", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("refuses a self registration that names a hidden type", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, name: "General" })
    const hidden = h.repo.seedTicketType({ cleanupId: EVENT, name: "Staff", visibility: "hidden" })

    const res = await h.registrations.register(request({ ticketTypeId: hidden.id }), {
      kind: "user",
      userId: USER,
    })

    expect(res.outcome).toBe("ticket_type_not_found")
    expect(h.repo.ticketTypes.get(hidden.id)?.reservedSeats).toBe(0)
  })

  it("never auto-selects a sole hidden type for a self registration", async () => {
    const hidden = h.repo.seedTicketType({ cleanupId: EVENT, name: "Staff", visibility: "hidden" })

    const res = await h.registrations.register(request(), { kind: "user", userId: USER })

    expect(res.outcome).toBe("ticket_type_not_found")
    expect(h.repo.ticketTypes.get(hidden.id)?.reservedSeats).toBe(0)
  })

  it("keeps refusing an unnamed type when a public type sits beside hidden ones", async () => {
    h.repo.seedTicketType({ cleanupId: EVENT, name: "General" })
    h.repo.seedTicketType({ cleanupId: EVENT, name: "Staff", visibility: "hidden" })

    const res = await h.registrations.register(request(), { kind: "user", userId: USER })

    expect(res.outcome).toBe("ticket_type_not_found")
  })

  it("still lets a host seat a walk-up on a hidden type", async () => {
    const hidden = h.repo.seedTicketType({ cleanupId: EVENT, name: "Staff", visibility: "hidden" })

    const res = await h.registrations.walkup(
      { id: EVENT, name: "Walk In", partySize: 1, ticketTypeId: hidden.id, checkInNow: false },
      HOST,
    )

    expect(res.outcome).toBe("registered")
  })

  it("refuses a waitlist join on a hidden type as if the type did not exist", async () => {
    const hidden = h.repo.seedTicketType({
      cleanupId: EVENT,
      name: "Staff",
      visibility: "hidden",
      capacity: 1,
      waitlistEnabled: true,
    })

    await expect(
      h.waitlist.join(
        { id: EVENT, ticketTypeId: hidden.id, partySize: 1 },
        { kind: "user", userId: USER },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Ticket type not found" })
    expect([...h.repo.waitlist.values()]).toHaveLength(0)
  })

  it("lists a hidden type's questions only to someone who can manage tickets", async () => {
    const hidden = h.repo.seedTicketType({ cleanupId: EVENT, name: "Staff", visibility: "hidden" })
    const general = h.repo.seedTicketType({ cleanupId: EVENT, name: "General" })
    const everyone = question({ prompt: "Everyone", sortOrder: 0 })
    const publicScoped = question({ prompt: "General", ticketTypeId: general.id, sortOrder: 1 })
    const hiddenScoped = question({ prompt: "Staff only", ticketTypeId: hidden.id, sortOrder: 2 })
    for (const q of [everyone, publicScoped, hiddenScoped]) h.repo.questions.set(q.id, q)
    const questions = makeQuestionService({ repo: h.repo })

    const asPublic = await questions.list({ id: EVENT }, { canManage: false })
    const asPublicScoped = await questions.list(
      { id: EVENT, ticketTypeId: hidden.id },
      { canManage: false },
    )
    const asHost = await questions.list({ id: EVENT }, { canManage: true })

    expect(asPublic.items.map((q) => q.prompt)).toEqual(["Everyone", "General"])
    expect(asPublicScoped.items.map((q) => q.prompt)).toEqual(["Everyone"])
    expect(asHost.items.map((q) => q.prompt)).toEqual(["Everyone", "General", "Staff only"])
  })
})

describe("bans reach the waitlist", () => {
  let h: Harness

  beforeEach(() => {
    h = build()
  })

  it("refuses a banned user's waitlist join", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    h.repo.bans.add(`${EVENT}:${BANNED}`)

    await expect(
      h.waitlist.join(
        { id: EVENT, ticketTypeId: type.id, partySize: 1 },
        { kind: "user", userId: BANNED },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "A host removed you from this event." })
    expect([...h.repo.waitlist.values()]).toHaveLength(0)
  })

  it("never offers a place to a banned user who is still waiting", async () => {
    const type = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const banned = await h.repo.joinWaitlist({
      cleanupId: EVENT,
      ticketTypeId: type.id,
      subject: { kind: "user", userId: BANNED },
      partySize: 1,
      accessCodeHash: null,
      now: NOW,
    })
    const next = await h.repo.joinWaitlist({
      cleanupId: EVENT,
      ticketTypeId: type.id,
      subject: { kind: "user", userId: USER },
      partySize: 1,
      accessCodeHash: null,
      now: new Date(NOW.getTime() + 1),
    })
    h.repo.bans.add(`${EVENT}:${BANNED}`)

    const offer = await h.repo.offerNextWaitlistEntry({
      ticketTypeId: type.id,
      now: NOW,
      claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
    })
    const manual = await h.repo.offerWaitlistEntry({
      cleanupId: EVENT,
      waitlistId: banned.kind === "joined" ? banned.entry.id : "",
      now: NOW,
      claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
    })

    expect(offer?.waitlistId).toBe(next.kind === "joined" ? next.entry.id : "")
    expect(manual).toBeNull()
  })

  it("cancels the banned user's waiting and offered entries, releases the held seats and promotes the next person", async () => {
    const main = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 5 })
    const vip = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 3, waitlistEnabled: true })
    const extra = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 3, waitlistEnabled: true })
    for (const type of [vip, extra]) {
      await h.repo.joinWaitlist({
        cleanupId: EVENT,
        ticketTypeId: type.id,
        subject: { kind: "user", userId: BANNED },
        partySize: 3,
        accessCodeHash: null,
        now: NOW,
      })
    }
    await h.repo.offerNextWaitlistEntry({
      ticketTypeId: vip.id,
      now: NOW,
      claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
    })
    expect(h.repo.ticketTypes.get(vip.id)?.reservedSeats).toBe(3)
    const registered = await h.registrations.register(request({ ticketTypeId: main.id }), {
      kind: "user",
      userId: BANNED,
    })
    h.enqueued.length = 0

    await h.registrations.remove(
      { id: EVENT, registrationId: registered.registration?.id ?? "", ban: true },
      HOST,
    )

    const entries = [...h.repo.waitlist.values()].filter((w) => w.userId === BANNED)
    expect(entries.map((w) => w.status)).toEqual(["cancelled", "cancelled"])
    expect(h.repo.ticketTypes.get(vip.id)?.reservedSeats).toBe(0)
    expect(h.repo.ticketTypes.get(extra.id)?.reservedSeats).toBe(0)
    expect(h.enqueued.sort()).toEqual([main.id, vip.id].sort())
  })

  it("leaves waitlist entries alone when the host removes without banning", async () => {
    const main = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 5 })
    const vip = h.repo.seedTicketType({ cleanupId: EVENT, capacity: 3, waitlistEnabled: true })
    await h.repo.joinWaitlist({
      cleanupId: EVENT,
      ticketTypeId: vip.id,
      subject: { kind: "user", userId: USER },
      partySize: 1,
      accessCodeHash: null,
      now: NOW,
    })
    const registered = await h.registrations.register(request({ ticketTypeId: main.id }), {
      kind: "user",
      userId: USER,
    })

    await h.registrations.remove(
      { id: EVENT, registrationId: registered.registration?.id ?? "", ban: false },
      HOST,
    )

    expect([...h.repo.waitlist.values()].map((w) => w.status)).toEqual(["waiting"])
  })
})

describe("registration SQL guards", () => {
  function typeRow(visibility: string) {
    return {
      id: HIDDEN_TYPE,
      capacity: null,
      reserved_seats: 0,
      sales_opens_at: null,
      sales_closes_at: null,
      visibility,
      access_code_hash: null,
      max_party_size: 4,
      waitlist_enabled: true,
    }
  }

  function eventHandlers(visibility: string): SqlHandler[] {
    return [
      {
        match: /FROM cleanups\s+WHERE id = \?/,
        rows: [
          {
            status: "upcoming",
            registration_opens_at: null,
            registration_closes_at: null,
            capacity: null,
            scheduled_at: new Date(NOW.getTime() + 86_400_000),
            ends_at: null,
            now: NOW,
          },
        ],
      },
      { match: /FROM cleanup_ticket_types/, rows: [typeRow(visibility)] },
    ]
  }

  function registerArgs(over: Partial<RegisterTxArgs>): RegisterTxArgs {
    return {
      cleanupId: EVENT,
      subject: { kind: "user", userId: USER },
      ticketTypeId: null,
      seats: seatsFor(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "k1",
      waitlistId: null,
      now: NOW,
      ...over,
    }
  }

  function repoOver(fake: FakeSqlControl) {
    return makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)
  }

  it("refuses a self registration on a sole hidden type, named or not", async () => {
    for (const ticketTypeId of [null, HIDDEN_TYPE]) {
      const fake = makeFakeSql(eventHandlers("hidden"))
      const outcome = await repoOver(fake).registerTx(registerArgs({ ticketTypeId }))
      expect(outcome).toEqual({ kind: "ticket_type_not_found" })
      expect(fake.statements.some((s) => /UPDATE cleanup_ticket_types/.test(s.sql))).toBe(false)
    }
  })

  it("refuses a waitlist join on a hidden type, and a banned user's join", async () => {
    const hidden = makeFakeSql(eventHandlers("hidden"))
    await expect(
      repoOver(hidden).joinWaitlist({
        cleanupId: EVENT,
        ticketTypeId: HIDDEN_TYPE,
        subject: { kind: "user", userId: USER },
        partySize: 1,
        accessCodeHash: null,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "ticket_type_not_found" })

    const banned = makeFakeSql([
      ...eventHandlers("public"),
      { match: /FROM cleanup_bans/, rows: [{ one: 1 }] },
    ])
    await expect(
      repoOver(banned).joinWaitlist({
        cleanupId: EVENT,
        ticketTypeId: HIDDEN_TYPE,
        subject: { kind: "user", userId: BANNED },
        partySize: 1,
        accessCodeHash: null,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "banned" })
    expect(banned.statements.some((s) => /INSERT INTO cleanup_waitlist/.test(s.sql))).toBe(false)
  })

  it("skips banned users when choosing whom to offer a place", async () => {
    for (const offer of [
      (fake: FakeSqlControl) =>
        repoOver(fake).offerNextWaitlistEntry({
          ticketTypeId: HIDDEN_TYPE,
          now: NOW,
          claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
        }),
      (fake: FakeSqlControl) =>
        repoOver(fake).offerWaitlistEntry({
          cleanupId: EVENT,
          waitlistId: REGISTRATION,
          now: NOW,
          claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
        }),
    ]) {
      const fake = makeFakeSql()
      await offer(fake)
      const select = fake.statements[0]!.sql.replace(/\s+/g, " ")
      expect(select).toMatch(/FROM cleanup_waitlist w/)
      expect(select).toContain(
        "NOT EXISTS ( SELECT 1 FROM cleanup_bans b WHERE b.cleanup_id = w.cleanup_id AND b.user_id = w.user_id )",
      )
    }
  })

  it("bans, cancels the waitlist entries and cancels the registration in one transaction", async () => {
    const fake = makeFakeSql([
      { match: /SELECT user_id FROM cleanup_registrations/, rows: [{ user_id: BANNED }] },
      {
        match: /UPDATE cleanup_waitlist/,
        rows: [{ id: "w1", released_ticket_type_id: HIDDEN_TYPE }],
      },
      { match: /WITH cancelled AS/, rows: [] },
    ])
    let began = -1
    let ended = -1
    const begin = fake.sql.begin
    fake.sql.begin = async (cb) => {
      began = fake.statements.length
      const result = await begin(cb)
      ended = fake.statements.length
      return result
    }

    const outcome = await repoOver(fake).removeRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      actorId: HOST,
      ban: true,
      now: NOW,
    })

    expect(began).toBe(0)
    expect(ended).toBe(fake.statements.length)
    const order = [
      /INSERT INTO cleanup_bans/,
      /DELETE FROM cleanup_members/,
      /UPDATE cleanup_waitlist/,
      /WITH cancelled AS/,
    ].map((pattern) => fake.statements.findIndex((s) => pattern.test(s.sql)))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(outcome.releasedWaitlistTicketTypeIds).toEqual([HIDDEN_TYPE])
  })
})

describe("guest self-registration on a private event", () => {
  const GUEST = "12121212-1212-4212-8212-121212121212"
  const WAITLIST_ENTRY = "34343434-3434-4434-8434-343434343434"

  function privateEvent(): SqlHandler[] {
    return [
      {
        match: /FROM cleanups\s+WHERE id = \?/,
        rows: [
          {
            status: "upcoming",
            visibility: "private",
            registration_opens_at: null,
            registration_closes_at: null,
            capacity: null,
          },
        ],
      },
    ]
  }

  function guestArgs(over: Partial<RegisterTxArgs>): RegisterTxArgs {
    return {
      cleanupId: EVENT,
      subject: { kind: "guest", guestId: GUEST },
      ticketTypeId: null,
      seats: seatsFor(1),
      accessCodeHash: null,
      answers: [],
      consent: null,
      slotId: null,
      source: "self",
      idempotencyKey: "guest-key",
      waitlistId: null,
      now: NOW,
      ...over,
    }
  }

  const seatsWritten = (fake: FakeSqlControl) =>
    fake.statements.some((s) => /INSERT INTO cleanup_registrations/.test(s.sql))

  it("answers not found and writes nothing", async () => {
    const fake = makeFakeSql(privateEvent())

    const outcome = await makeDrizzleHostRegistrationRepository(
      fake.sql as unknown as Sql,
    ).registerTx(guestArgs({}))

    expect(outcome).toEqual({ kind: "not_found" })
    expect(seatsWritten(fake)).toBe(false)
  })

  it("still seats a guest the host adds at the door, and a guest already on the waitlist", async () => {
    for (const over of [
      { source: "walkup" as const },
      { source: "waitlist" as const, waitlistId: WAITLIST_ENTRY },
    ]) {
      const fake = makeFakeSql(privateEvent())

      await makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)
        .registerTx(guestArgs(over))
        .catch(() => undefined)

      expect(seatsWritten(fake), over.source).toBe(true)
    }
  })

  it("is refused the same way by the in-memory twin", async () => {
    const repo = new InMemoryHostRegistrationRepository()
    repo.seedEvent({ cleanupId: EVENT, visibility: "private" })

    await expect(repo.registerTx(guestArgs({}))).resolves.toEqual({ kind: "not_found" })
    await expect(repo.registerTx(guestArgs({ source: "walkup" }))).resolves.toMatchObject({
      kind: "registered",
    })
  })
})

describe("roster search", () => {
  it("matches the host's text literally, wildcards included", async () => {
    const fake = makeFakeSql()

    await makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).listRoster({
      cleanupId: EVENT,
      filter: "all",
      ticketTypeId: null,
      slotId: null,
      sort: "registered_at_desc",
      q: "50%_off\\",
      cursor: null,
      limit: 20,
      withTotal: false,
    })

    const roster = fake.statements.find((s) => /FROM cleanup_registrations r/.test(s.sql))!
    const patterns = roster.values.filter((v) => typeof v === "string" && v.includes("50"))
    expect(patterns).toEqual(Array(4).fill("%50\\%\\_off\\\\%"))
    expect(roster.sql.match(/ILIKE \? ESCAPE '\\'/g)).toHaveLength(4)
  })
})

describe("ticket transfer lock order", () => {
  const OTHER_TYPE = "99999999-9999-4999-8999-999999999999"

  function transferHandlers(): SqlHandler[] {
    return [
      { match: /FROM cleanups\s+WHERE id = \?/, rows: [{ id: EVENT }] },
      {
        match: /FROM cleanup_registrations\s+WHERE id = \?/,
        rows: [
          { id: REGISTRATION, ticket_type_id: HIDDEN_TYPE, party_size: 1, status: "registered" },
        ],
      },
      {
        match: /FROM cleanup_ticket_types\s+WHERE cleanup_id/,
        rows: [
          { id: HIDDEN_TYPE, max_party_size: 4, capacity: null, reserved_seats: 1 },
          { id: OTHER_TYPE, max_party_size: 4, capacity: null, reserved_seats: 0 },
        ],
      },
      {
        match: /UPDATE cleanup_ticket_types\s+SET reserved_seats = reserved_seats \+/,
        rows: [{ id: OTHER_TYPE }],
      },
    ]
  }

  it("locks the event row before the registration and its ticket types, as a ban does", async () => {
    const fake = makeFakeSql(transferHandlers())
    const repo = makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)

    await repo.transferRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      ticketTypeId: OTHER_TYPE,
      now: NOW,
    })

    const eventLock = fake.statements.findIndex((s) =>
      /FROM cleanups\s+WHERE id = \?\s+LIMIT 1 FOR NO KEY UPDATE/.test(s.sql),
    )
    const registrationLock = fake.statements.findIndex((s) =>
      /FROM cleanup_registrations[\s\S]*FOR UPDATE/.test(s.sql),
    )
    const typeLock = fake.statements.findIndex((s) =>
      /FROM cleanup_ticket_types[\s\S]*FOR UPDATE/.test(s.sql),
    )
    expect(eventLock).toBe(0)
    expect(fake.statements[eventLock]!.values).toEqual([EVENT])
    expect(registrationLock).toBeGreaterThan(eventLock)
    expect(typeLock).toBeGreaterThan(registrationLock)
  })

  it("answers not found without touching the registration when the event is gone", async () => {
    const fake = makeFakeSql(transferHandlers().slice(1))
    const repo = makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)

    const outcome = await repo.transferRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      ticketTypeId: OTHER_TYPE,
      now: NOW,
    })

    expect(outcome).toEqual({ kind: "not_found" })
    expect(fake.statements.some((s) => /cleanup_registrations/.test(s.sql))).toBe(false)
  })
})
