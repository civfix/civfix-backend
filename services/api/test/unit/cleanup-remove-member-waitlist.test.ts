import { describe, expect, it } from "vitest"
import type { Jobs } from "@civfix/shared/interfaces"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { WAITLIST_PROMOTE_JOB } from "../../src/services/host/registration-queues.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"

const CLEANUP = "aaaaaaaa-0000-4000-8000-000000000001"
const ORGANIZER = "11111111-1111-4111-8111-111111111111"
const MEMBER = "33333333-3333-4333-8333-333333333333"
const HELD_TYPE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const NOW = new Date("2026-09-01T12:00:00.000Z")

describe("removing an attendee bans them off the waitlist too", () => {
  it("cancels their waiting and offered entries in the removal transaction", async () => {
    const fake = makeFakeSql([
      { match: /FROM cleanups WHERE id = /, rows: [{ status: "upcoming", now: NOW }] },
      { match: /DELETE FROM cleanup_members/, rows: [{ user_id: MEMBER }] },
      {
        match: /UPDATE cleanup_waitlist/,
        rows: [
          { id: "w1", released_ticket_type_id: HELD_TYPE },
          { id: "w2", released_ticket_type_id: null },
        ],
      },
      { match: /AS count/, rows: [{ count: 3 }] },
    ])
    let beganAt = -1
    let endedAt = -1
    const begin = fake.sql.begin
    fake.sql.begin = async (cb) => {
      beganAt = fake.statements.length
      const result = await begin(cb)
      endedAt = fake.statements.length
      return result
    }

    const outcome = await makeDrizzleCleanupRepository(fake.sql as unknown as Sql).removeMember(
      CLEANUP,
      MEMBER,
      ORGANIZER,
    )

    expect(outcome).toEqual({
      kind: "removed",
      going: 3,
      releasedWaitlistTicketTypeIds: [HELD_TYPE],
    })
    const ban = fake.statements.findIndex((s) => /INSERT INTO cleanup_bans/.test(s.sql))
    const waitlist = fake.statements.findIndex((s) => /UPDATE cleanup_waitlist/.test(s.sql))
    expect(ban).toBeGreaterThanOrEqual(0)
    expect(waitlist).toBeGreaterThan(ban)
    expect(beganAt).toBe(0)
    expect(endedAt).toBe(fake.statements.length)
    const cancel = fake.statements[waitlist]!
    expect(cancel.sql.replace(/\s+/g, " ")).toContain("status IN ('waiting', 'offered')")
    expect(cancel.values).toEqual(expect.arrayContaining([CLEANUP, MEMBER]))
  })

  it("leaves the waitlist alone when the person was not an attendee", async () => {
    const fake = makeFakeSql([
      { match: /FROM cleanups WHERE id = /, rows: [{ status: "upcoming", now: NOW }] },
      { match: /AS count/, rows: [{ count: 1 }] },
    ])

    const outcome = await makeDrizzleCleanupRepository(fake.sql as unknown as Sql).removeMember(
      CLEANUP,
      MEMBER,
      ORGANIZER,
    )

    expect(outcome).toEqual({ kind: "not_member", going: 1 })
    expect(fake.statements.some((s) => /UPDATE cleanup_waitlist/.test(s.sql))).toBe(false)
  })

  it("offers the seats a removed attendee was holding to the next person", async () => {
    const repo = new InMemoryCleanupRepository()
    repo.seedCleanup({
      id: CLEANUP,
      organizerUserId: ORGANIZER,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000),
      withDefaultSlot: false,
    })
    repo.seedMember(CLEANUP, MEMBER, "member")
    const remove = repo.removeMember.bind(repo)
    repo.removeMember = async (...args) => {
      const outcome = await remove(...args)
      return outcome.kind === "removed"
        ? { ...outcome, releasedWaitlistTicketTypeIds: [HELD_TYPE] }
        : outcome
    }
    const enqueued: { name: string; payload: unknown }[] = []
    const jobs = {
      enqueue: (name: string, payload: unknown) => {
        enqueued.push({ name, payload })
        return Promise.resolve("job")
      },
    } as unknown as Jobs
    const service = makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo,
      counters: new InMemoryCounterStore(),
      jobs,
    })

    await service.removeMember(CLEANUP, ORGANIZER, MEMBER)

    expect(enqueued).toContainEqual({
      name: WAITLIST_PROMOTE_JOB,
      payload: { ticketTypeId: HELD_TYPE },
    })
  })
})
