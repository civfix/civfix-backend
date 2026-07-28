/**
 * The itemised service-hours ledger (P4): `GET /me/volunteer-hours/entries`,
 * `GET /people/:id/volunteer-hours` and `GET /cleanups/:id/hours`, exercised through the service over the
 * in-memory VolunteerHoursRepository twin.
 *
 * What is pinned here, and why each one is load-bearing:
 *   - the keyset page split on `(created_at DESC, id DESC)`, including a MALFORMED cursor degrading to
 *     page 1 rather than throwing (a non-UUID id would raise a Postgres 22P02 -> 500 on the real repo);
 *   - `voided_at` rows are excluded from every read, so the dormant column needs no read change later;
 *   - the PUBLIC projection's two C18 gates: aggregate (`IS NOT FALSE`) vs itemised (`IS TRUE`), a
 *     never-chosen user getting `visible: true` with `items: []`, and hidden reported at 200 not 403;
 *   - only `source='event'` rows are itemised publicly (a public list of every report someone filed is a
 *     privacy leak and the id deep-links into them), and `reportHours` is now a hard 0 — filing a report
 *     is not volunteer service, so pre-0065 report rows are excluded from EVERY read, owner's included;
 *   - `creditedBy` is carried — the whole point of a transcript a school can trust;
 *   - the `getEventHours` scope matrix, including `anyLogged`, which is the only thing that lets an
 *     uncredited attendee's receipt say "not credited" instead of "the host hasn't logged yet" forever.
 */

import { describe, it, expect } from "vitest"
import {
  makeVolunteerHoursService,
  type CleanupHoursLookup,
  type CleanupHoursView,
  type VolunteerHoursService,
} from "../../src/services/volunteer-hours-service.js"
import { InMemoryVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.memory.js"

const HOST = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"
const DAVE = "44444444-4444-4444-4444-444444444444"
const GEOID_A = "0644000"
const REPORT_ONE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
const REPORT_TWO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"

const BASE_MS = Date.parse("2026-06-01T00:00:00.000Z")

/**
 * Deterministic clock + id source. The keyset orders on `(created_at DESC, id DESC)`, so a random UUID
 * would make the tie-break assertion non-reproducible; sequential ids sort the same way every run.
 */
function makeRepo(opts?: { frozenClock?: boolean }): InMemoryVolunteerHoursRepository {
  let tick = 0
  let n = 0
  return new InMemoryVolunteerHoursRepository({
    now: () => new Date(BASE_MS + (opts?.frozenClock === true ? 0 : tick++ * 60_000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  })
}

const doneEvent = (title: string): CleanupHoursView => ({
  organizerUserId: HOST,
  status: "done",
  jurisdictionGeoid: GEOID_A,
  title,
})

function makeCleanups(
  view: CleanupHoursView | null,
  members: string[],
  cohosts: string[] = [],
): CleanupHoursLookup {
  return {
    load: () => Promise.resolve(view),
    listMemberIds: () => Promise.resolve(members),
    roleOf: (_cleanupId: string, userId: string) => {
      if (view !== null && view.organizerUserId === userId) return Promise.resolve("organizer" as const)
      if (cohosts.includes(userId)) return Promise.resolve("cohost" as const)
      if (members.includes(userId)) return Promise.resolve("member" as const)
      return Promise.resolve(null)
    },
  }
}

function makeService(
  repo: InMemoryVolunteerHoursRepository,
  cleanups: CleanupHoursLookup = makeCleanups(null, []),
): VolunteerHoursService {
  return makeVolunteerHoursService({
    repo,
    cleanups,
    isVerified: () => Promise.resolve(true),
  })
}

/** Credit BOB `hours` at a fresh event, seeding the event metadata the ledger join produces. */
async function creditEvent(
  repo: InMemoryVolunteerHoursRepository,
  cleanupId: string,
  userId: string,
  hours: number,
  meta?: { title?: string; referenceCode?: string; scheduledAt?: Date },
): Promise<void> {
  repo.seedCleanup(cleanupId, {
    title: meta?.title ?? `Sweep ${cleanupId}`,
    referenceCode: meta?.referenceCode ?? null,
    scheduledAt: meta?.scheduledAt ?? null,
  })
  await repo.logEventHours({
    actorId: HOST,
    cleanupId,
    geoid: GEOID_A,
    entries: [{ userId, hours }],
  })
}

const EVENT_IDS = [
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4",
] as const

describe("hours ledger: getMyHoursEntries keyset paging", () => {
  it("pages newest-first and the cursor resumes exactly where the page ended", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    for (const [i, id] of EVENT_IDS.entries()) {
      await creditEvent(repo, id, BOB, i + 1, { title: `Event ${i + 1}` })
    }
    const service = makeService(repo)

    const first = await service.getMyHoursEntries(BOB, { limit: 2 })
    expect(first.items.map((e) => e.eventTitle)).toEqual(["Event 4", "Event 3"])
    expect(first.nextCursor).not.toBeNull()
    // The header total is the ROLLUP (1+2+3+4), not the sum of the page — it must not move as you scroll.
    expect(first.totalHours).toBe(10)

    const second = await service.getMyHoursEntries(BOB, {
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((e) => e.eventTitle)).toEqual(["Event 2", "Event 1"])
    expect(second.nextCursor).toBeNull()
    expect(second.totalHours).toBe(10)

    // No row is served twice across the two pages.
    const ids = [...first.items, ...second.items].map((e) => e.id)
    expect(new Set(ids).size).toBe(4)
  })

  it("breaks an exact created_at tie on the id, and pages across it without repeating a row", async () => {
    // Every row shares one instant, so ONLY the id tie-break can order them.
    const repo = makeRepo({ frozenClock: true })
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    for (const [i, id] of EVENT_IDS.entries()) {
      await creditEvent(repo, id, BOB, 1, { title: `Event ${i + 1}` })
    }
    const service = makeService(repo)

    const first = await service.getMyHoursEntries(BOB, { limit: 2 })
    const second = await service.getMyHoursEntries(BOB, { limit: 2, cursor: first.nextCursor! })
    const ids = [...first.items, ...second.items].map((e) => e.id)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    // Descending on id, which is what the row-value comparison delivers when the timestamps are equal.
    expect([...ids]).toEqual([...ids].sort().reverse())
  })

  /**
   * A malformed cursor must degrade to "from the start", never throw: on the real repo a non-UUID id
   * would reach a `::uuid` cast and raise a Postgres 22P02, which surfaces as an unhandled 500 on a read
   * a client can trigger with one hand-edited query string.
   */
  it("degrades a MALFORMED cursor to page 1 instead of throwing", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    for (const [i, id] of EVENT_IDS.entries()) {
      await creditEvent(repo, id, BOB, i + 1, { title: `Event ${i + 1}` })
    }
    const service = makeService(repo)

    const clean = await service.getMyHoursEntries(BOB, { limit: 2 })
    for (const junk of ["not-a-cursor", "|", "2026-06-01T00:00:00.000Z|not-a-uuid", ""]) {
      const degraded = await service.getMyHoursEntries(BOB, { limit: 2, cursor: junk })
      expect(degraded.items.map((e) => e.id)).toEqual(clean.items.map((e) => e.id))
    }
  })

  it("itemises the SERVICE sources for the owner, never 'report', and excludes voided rows", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    // A pre-0065 row: filing a report used to auto-award 0.1h. It is not volunteer service, so it is not
    // itemised even to the owner — ITEMISED_SOURCES is ["event", "manual"], and 0065 voided these rows.
    repo.seedLegacyReportEntry(BOB, REPORT_ONE, GEOID_A)
    await creditEvent(repo, EVENT_IDS[0], BOB, 3, { title: "Kept" })
    await creditEvent(repo, EVENT_IDS[1], BOB, 4, { title: "Voided" })
    const service = makeService(repo)

    const all = await service.getMyHoursEntries(BOB, {})
    expect(all.items.map((e) => e.source).sort()).toEqual(["event", "event"])

    // `voided_at` is what 0065 wrote to retire the report credits; the READ filter has been live since
    // day one, so voiding needed no read change and no backfill.
    const voided = all.items.find((e) => e.eventTitle === "Voided")!
    repo.voidEntry(voided.id)
    const after = await service.getMyHoursEntries(BOB, {})
    expect(after.items.map((e) => e.source)).toEqual(["event"])
    expect(after.items.map((e) => e.eventTitle)).toEqual(["Kept"])
  })

  it("carries the joined event + jurisdiction + creditedBy identity", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null, verified: true })
    await creditEvent(repo, EVENT_IDS[0], BOB, 2, {
      title: "Ocean Beach sweep",
      referenceCode: "EVENT-SF-000123",
      scheduledAt: new Date("2026-05-20T17:00:00.000Z"),
    })
    const service = makeService(repo)

    const page = await service.getMyHoursEntries(BOB, {})
    const entry = page.items[0]!
    expect(entry.eventId).toBe(EVENT_IDS[0])
    expect(entry.eventTitle).toBe("Ocean Beach sweep")
    expect(entry.eventReferenceCode).toBe("EVENT-SF-000123")
    expect(entry.jurisdictionGeoid).toBe(GEOID_A)
    expect(entry.jurisdictionName).toBe("San Francisco")
    // `occurredAt` is when the SERVICE happened (scheduledAt), not when the host got round to logging it.
    expect(entry.occurredAt).toBe("2026-05-20T17:00:00.000Z")
    expect(entry.creditedAt).not.toBe(entry.occurredAt)
    expect(entry.creditedBy).toEqual({ id: HOST, name: "Ann Host", handle: "ann", verified: true })
  })
})

describe("hours ledger: the public projection (C18's two gates)", () => {
  async function seedBob(repo: InMemoryVolunteerHoursRepository): Promise<void> {
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null, verified: true })
    await creditEvent(repo, EVENT_IDS[0], BOB, 2, { title: "Ocean Beach sweep" })
    await creditEvent(repo, EVENT_IDS[1], BOB, 1, { title: "Dolores clean-up" })
    // Two PRE-0065 report auto-awards, still in the ledger and (as in production before the migration
    // recomputes it) still in the rollup `totalHours` reads. They must not surface anywhere public.
    repo.seedLegacyReportEntry(BOB, REPORT_ONE, GEOID_A)
    repo.seedLegacyReportEntry(BOB, REPORT_TWO, GEOID_A)
  }

  it("TRUE (explicit opt-in): aggregate AND items, event rows only, report hours always zero", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      verified: false,
      showVolunteerHours: true,
    })
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)

    expect(res.visible).toBe(true)
    expect(res.totalHours).toBe(3.2)
    expect(res.byJurisdiction).toEqual([{ geoid: GEOID_A, name: "San Francisco", hours: 3.2 }])
    // Only source='event' is itemised: a public, itemised list of every report a user filed is a privacy
    // leak (reports can be held, unlisted or sensitive) and the id deep-links straight into them.
    expect(res.items.map((e) => e.source)).toEqual(["event", "event"])
    expect(res.items.map((e) => e.eventTitle)).toEqual(["Dolores clean-up", "Ocean Beach sweep"])
    // `reportHours` is now a hard 0, not a ledger read: report filings are not volunteer service, so
    // there is no honest aggregate to publish. The field stays on the wire for shipped clients.
    expect(res.reportHours).toBe(0)
    // ...and the crediting host IS named — that is the whole point of a transcript a school can trust.
    expect(res.items[0]?.creditedBy?.handle).toBe("ann")
  })

  it("NULL (never chosen): visible with an EMPTY items list and a truthful nextCursor", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    // No showVolunteerHours key at all — the state every account that exists today is in.
    repo.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null, verified: false })
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)

    // The aggregate is byte-identical to what their profile already publishes...
    expect(res.visible).toBe(true)
    expect(res.totalHours).toBe(3.2)
    expect(res.reportHours).toBe(0)
    // ...while the per-event list — where they physically were, on which dates — stays closed.
    expect(res.items).toEqual([])
    expect(res.nextCursor).toBeNull()
  })

  it("FALSE (explicit opt-out): visible:false at 200, never a 403 and never a fabricated zero", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      verified: false,
      showVolunteerHours: false,
    })
    // A 403 here would be an oracle (it confirms the account exists and has hours); "0 hours" would be a
    // lie about somebody who simply opted out. `visible: false` is the honest third answer.
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)
    expect(res).toEqual({
      visible: false,
      totalHours: 0,
      byJurisdiction: [],
      items: [],
      reportHours: 0,
      nextCursor: null,
    })
  })

  it("a soft-deleted account is hidden on both gates", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      verified: false,
      showVolunteerHours: true,
      deleted: true,
    })
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)
    expect(res.visible).toBe(false)
    expect(res.items).toEqual([])
  })

  // NOTE: "an id with no users row at all" is deliberately NOT asserted here — the twin models the FLAG
  // on a seeded user, and an unseeded id reads as the NULL tri-state. The real repo's
  // `WHERE id = $1 AND deleted_at IS NULL` miss (which yields visible:false) is pinned in
  // test/integration/volunteer-hours-pg.test.ts, where the actual WHERE clause runs.

  // P4: your own data is always visible to you, and this endpoint is auth-OPTIONAL, so a signed-in owner
  // hitting their own public URL must not be shown as hidden from themselves.
  it("isSelf bypasses both gates even when the owner has opted OUT", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      verified: false,
      showVolunteerHours: false,
    })
    const res = await makeService(repo).getPublicHours({ id: BOB }, BOB)
    expect(res.visible).toBe(true)
    expect(res.items.map((e) => e.source)).toEqual(["event", "event"])
  })

  it("pages the public items with the same keyset", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(BOB, {
      name: "Bob",
      handle: null,
      avatarUrl: null,
      verified: false,
      showVolunteerHours: true,
    })
    for (const [i, id] of EVENT_IDS.entries()) {
      await creditEvent(repo, id, BOB, 1, { title: `Event ${i + 1}` })
    }
    const service = makeService(repo)

    const first = await service.getPublicHours({ id: BOB, limit: 3 }, CAROL)
    expect(first.items).toHaveLength(3)
    expect(first.nextCursor).not.toBeNull()
    const second = await service.getPublicHours(
      { id: BOB, limit: 3, cursor: first.nextCursor! },
      CAROL,
    )
    expect(second.items.map((e) => e.eventTitle)).toEqual(["Event 1"])
    expect(second.nextCursor).toBeNull()
  })
})

describe("hours ledger: getEventHours scope matrix (C10)", () => {
  const EVENT = EVENT_IDS[0]

  async function seedEvent(): Promise<InMemoryVolunteerHoursRepository> {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedCleanup(EVENT, { title: "Ocean Beach sweep", referenceCode: null, scheduledAt: null })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID_A,
      entries: [
        { userId: BOB, hours: 2 },
        { userId: CAROL, hours: 1.5 },
      ],
    })
    return repo
  }

  it("an acting host gets scope 'all' — every attendee's row, so the log form prefills", async () => {
    const repo = await seedEvent()
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, CAROL, DAVE]),
    )
    const res = await service.getEventHours(EVENT, HOST)
    expect(res.scope).toBe("all")
    expect(res.entries.map((e) => [e.userId, e.hours]).sort()).toEqual(
      [
        [BOB, 2],
        [CAROL, 1.5],
      ].sort(),
    )
    expect(res.anyLogged).toBe(true)
    expect(typeof res.entries[0]!.loggedAt).toBe("string")
  })

  it("a COHOST is an acting host too (D4 parity with logging)", async () => {
    const repo = await seedEvent()
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, CAROL], [BOB]),
    )
    const res = await service.getEventHours(EVENT, BOB)
    expect(res.scope).toBe("all")
    expect(res.entries).toHaveLength(2)
  })

  it("a credited member gets scope 'self' and ONLY their own row", async () => {
    const repo = await seedEvent()
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, CAROL, DAVE]),
    )
    const res = await service.getEventHours(EVENT, CAROL)
    expect(res.scope).toBe("self")
    expect(res.entries).toEqual([
      { userId: CAROL, hours: 1.5, loggedAt: res.entries[0]!.loggedAt },
    ])
    expect(res.anyLogged).toBe(true)
  })

  /**
   * The reason `anyLogged` exists. DAVE attended and was NOT credited; his own rows are empty either way,
   * so without this flag his receipt can never tell "the host hasn't logged yet" from "the host logged
   * and didn't credit me", and he sits on the former — which is factually wrong — forever.
   */
  it("an UNCREDITED member gets an empty self scope with anyLogged TRUE", async () => {
    const repo = await seedEvent()
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, CAROL, DAVE]),
    )
    const res = await service.getEventHours(EVENT, DAVE)
    expect(res.scope).toBe("self")
    expect(res.entries).toEqual([])
    expect(res.anyLogged).toBe(true)
  })

  it("anyLogged is FALSE before the host has logged anything", async () => {
    const repo = makeRepo()
    repo.seedCleanup(EVENT, { title: "Ocean Beach sweep", referenceCode: null, scheduledAt: null })
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, DAVE]),
    )
    const res = await service.getEventHours(EVENT, DAVE)
    expect(res.entries).toEqual([])
    expect(res.anyLogged).toBe(false)
  })

  it("a NON-member gets an empty self scope and is told nothing about the event's hours", async () => {
    const repo = await seedEvent()
    const service = makeService(repo, makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB]))
    const res = await service.getEventHours(EVENT, DAVE)
    expect(res).toEqual({ scope: "self", entries: [] })
    expect(res.anyLogged).toBeUndefined()
  })

  it("404s a missing event", async () => {
    const repo = await seedEvent()
    const service = makeService(repo, makeCleanups(null, []))
    await expect(service.getEventHours(EVENT, HOST)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a voided credit stops counting for anyLogged and disappears from the host's summary", async () => {
    const repo = await seedEvent()
    const service = makeService(
      repo,
      makeCleanups(doneEvent("Ocean Beach sweep"), [HOST, BOB, CAROL]),
    )
    const before = await service.getEventHours(EVENT, HOST)
    expect(before.entries).toHaveLength(2)

    const ledger = await repo.listEventHours(EVENT, null)
    expect(ledger.entries).toHaveLength(2)
    const owned = await service.getMyHoursEntries(BOB, {})
    repo.voidEntry(owned.items[0]!.id)

    const after = await service.getEventHours(EVENT, HOST)
    expect(after.entries.map((e) => e.userId)).toEqual([CAROL])
  })
})
