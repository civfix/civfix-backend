import { describe, expect, it } from "vitest"
import type { Sql } from "../../../src/db/client.js"
import { makeDrizzleCleanupRepository } from "../../../src/services/cleanup-repository.drizzle.js"
import { makeDrizzleHostRegistrationRepository } from "../../../src/services/host/registration-repository.drizzle.js"
import { InMemoryHostRegistrationRepository } from "../../helpers/host/registration-repository.memory.js"
import { makeFakeSql, type RecordedStatement } from "../../helpers/fake-sql.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const HOST = "11111111-1111-4111-8111-111111111111"
const BANNED = "33333333-3333-4333-8333-333333333333"
const NEXT = "44444444-4444-4444-8444-444444444444"
const REGISTRATION = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const TICKETED_TYPE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const NOW = new Date("2026-09-01T12:00:00.000Z")

const EVENT_LOCK = /FROM cleanups WHERE id = \? LIMIT 1 FOR NO KEY UPDATE/
const BAN = /INSERT INTO cleanup_bans/
const WAITLIST = /UPDATE cleanup_waitlist/
const REGISTRATIONS = /UPDATE cleanup_registrations/
const SLOT_CLAIMS = /DELETE FROM cleanup_slot_claims/

function indexOf(statements: RecordedStatement[], pattern: RegExp): number {
  return statements.findIndex((s) => pattern.test(s.sql))
}

function flat(statement: RecordedStatement | undefined): string {
  return (statement?.sql ?? "").replace(/\s+/g, " ")
}

describe("banning an attendee by removing them from the event", () => {
  it("cancels every active registration, ticketed ones included, and releases their seats", async () => {
    const fake = makeFakeSql([
      { match: /FROM cleanups WHERE id = /, rows: [{ status: "upcoming", now: NOW }] },
      { match: /DELETE FROM cleanup_members/, rows: [{ user_id: BANNED }] },
      { match: REGISTRATIONS, rows: [{ id: REGISTRATION, ticket_type_id: TICKETED_TYPE }] },
      { match: /AS count/, rows: [{ count: 1 }] },
    ])

    const outcome = await makeDrizzleCleanupRepository(fake.sql as unknown as Sql).removeMember(
      EVENT,
      BANNED,
      HOST,
    )

    expect(outcome).toEqual({
      kind: "removed",
      going: 1,
      releasedWaitlistTicketTypeIds: [TICKETED_TYPE],
    })
    const cancel = fake.statements[indexOf(fake.statements, REGISTRATIONS)]
    expect(flat(cancel)).not.toContain("ticket_type_id IS NULL")
    expect(flat(cancel)).toContain("status = 'registered'")
    expect(flat(cancel)).toContain("UPDATE cleanup_registration_seats")
    expect(flat(cancel)).toContain("reserved_seats = GREATEST(t.reserved_seats -")
    expect(cancel?.values).toEqual(expect.arrayContaining([EVENT, BANNED]))
    expect(indexOf(fake.statements, SLOT_CLAIMS)).toBeGreaterThan(0)
  })
})

describe("banning an attendee from the host roster", () => {
  function banFake() {
    return makeFakeSql([
      { match: /SELECT user_id FROM cleanup_registrations/, rows: [{ user_id: BANNED }] },
      { match: REGISTRATIONS, rows: [] },
    ])
  }

  it("locks the event row before the ban, so a concurrent registration cannot slip past it", async () => {
    const fake = banFake()

    await makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).removeRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      actorId: HOST,
      ban: true,
      now: NOW,
    })

    const lock = indexOf(fake.statements, EVENT_LOCK)
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(indexOf(fake.statements, BAN)).toBeGreaterThan(lock)
    expect(indexOf(fake.statements, WAITLIST)).toBeGreaterThan(lock)
    expect(indexOf(fake.statements, REGISTRATIONS)).toBeGreaterThan(lock)
  })

  it("drops the banned user's slot claim and cancels all of their registrations", async () => {
    const fake = banFake()

    await makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).removeRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      actorId: HOST,
      ban: true,
      now: NOW,
    })

    const claims = fake.statements[indexOf(fake.statements, SLOT_CLAIMS)]
    expect(claims?.values).toEqual(expect.arrayContaining([EVENT, BANNED]))
    const byUser = fake.statements.find(
      (s) => REGISTRATIONS.test(s.sql) && flat(s).includes("AND user_id = ?"),
    )
    expect(byUser?.values).toEqual(expect.arrayContaining([EVENT, BANNED]))
  })

  it("takes no event lock and touches no ban state when the host removes without banning", async () => {
    const fake = banFake()

    await makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql).removeRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      actorId: HOST,
      ban: false,
      now: NOW,
    })

    for (const pattern of [EVENT_LOCK, BAN, WAITLIST, SLOT_CLAIMS]) {
      expect(indexOf(fake.statements, pattern)).toBe(-1)
    }
  })
})

describe("a waiting row left behind by a ban from before bans cancelled the waitlist", () => {
  async function queueWithBannedHead() {
    const repo = new InMemoryHostRegistrationRepository()
    repo.seedEvent({ cleanupId: EVENT })
    const type = repo.seedTicketType({ cleanupId: EVENT, capacity: 1, waitlistEnabled: true })
    const joins = []
    for (const [userId, at] of [
      [BANNED, NOW],
      [NEXT, new Date(NOW.getTime() + 1)],
    ] as const) {
      joins.push(
        await repo.joinWaitlist({
          cleanupId: EVENT,
          ticketTypeId: type.id,
          subject: { kind: "user", userId },
          partySize: 2,
          accessCodeHash: null,
          now: at,
        }),
      )
    }
    repo.bans.add(`${EVENT}:${BANNED}`)
    const next = joins[1]
    if (next?.kind !== "joined") throw new Error("expected the second person to join")
    return { repo, type, nextId: next.entry.id }
  }

  it("no longer counts toward the queue position of the people behind it", async () => {
    const { repo, nextId } = await queueWithBannedHead()

    expect((await repo.findWaitlistEntry(EVENT, nextId))?.position).toBe(1)
  })

  it("is left out of the host's waitlist and the waitlist counts", async () => {
    const { repo, type, nextId } = await queueWithBannedHead()

    const listed = await repo.listWaitlist({
      cleanupId: EVENT,
      ticketTypeId: null,
      status: null,
      cursor: null,
      limit: 10,
    })
    expect(listed.rows.map((row) => [row.id, row.position])).toEqual([[nextId, 1]])
    const counters = await repo.checkinCounters(EVENT)
    expect(counters.waitlisted).toBe(2)
    expect(counters.byTicketType.find((t) => t.ticketTypeId === type.id)?.waitlisted).toBe(2)
    expect((await repo.hostedEventCounts([EVENT])).get(EVENT)?.waitlistCount).toBe(2)
  })

  it("is excluded by the SQL behind the position, the host list and the counts", async () => {
    const BANNED_SKIPPED =
      /NOT EXISTS \( SELECT 1 FROM cleanup_bans b WHERE b\.cleanup_id = w\.cleanup_id AND b\.user_id = w\.user_id \)/
    const fake = makeFakeSql()
    const repo = makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)

    await repo.findWaitlistEntry(EVENT, REGISTRATION)
    await repo.listWaitlist({
      cleanupId: EVENT,
      ticketTypeId: null,
      status: null,
      cursor: null,
      limit: 10,
    })
    await repo.checkinCounters(EVENT)
    await repo.hostedEventCounts([EVENT])

    const [entry, list, totals, byType, , hosted] = fake.statements.map(flat)
    expect(entry).toContain(
      "NOT EXISTS ( SELECT 1 FROM cleanup_bans b WHERE b.cleanup_id = w2.cleanup_id AND b.user_id = w2.user_id )",
    )
    expect(list).toMatch(BANNED_SKIPPED)
    for (const counted of [totals, byType, hosted]) {
      expect(counted).toMatch(BANNED_SKIPPED)
    }
  })
})
