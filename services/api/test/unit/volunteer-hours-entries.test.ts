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
  visibility: "public",
  jurisdictionGeoid: GEOID_A,
  title,
  scheduledAt: new Date("2026-07-04T08:00:00.000Z"),
  endsAt: new Date("2026-07-04T12:00:00.000Z"),
  completedAt: new Date("2026-07-05T07:00:00.000Z"),
  timezone: null,
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
      if (view !== null && view.organizerUserId === userId)
        return Promise.resolve("organizer" as const)
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
  })
}

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
    expect(first.totalHours).toBe(10)

    const second = await service.getMyHoursEntries(BOB, {
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(second.items.map((e) => e.eventTitle)).toEqual(["Event 2", "Event 1"])
    expect(second.nextCursor).toBeNull()
    expect(second.totalHours).toBe(10)

    const ids = [...first.items, ...second.items].map((e) => e.id)
    expect(new Set(ids).size).toBe(4)
  })

  it("breaks an exact created_at tie on the id, and pages across it without repeating a row", async () => {
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
    expect([...ids]).toEqual([...ids].sort().reverse())
  })

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
    repo.seedLegacyReportEntry(BOB, REPORT_ONE, GEOID_A)
    await creditEvent(repo, EVENT_IDS[0], BOB, 3, { title: "Kept" })
    await creditEvent(repo, EVENT_IDS[1], BOB, 4, { title: "Voided" })
    const service = makeService(repo)

    const all = await service.getMyHoursEntries(BOB, {})
    expect(all.items.map((e) => e.source).sort()).toEqual(["event", "event"])

    const voided = all.items.find((e) => e.eventTitle === "Voided")!
    repo.voidEntry(voided.id)
    const after = await service.getMyHoursEntries(BOB, {})
    expect(after.items.map((e) => e.source)).toEqual(["event"])
    expect(after.items.map((e) => e.eventTitle)).toEqual(["Kept"])
  })

  it("carries the joined event + jurisdiction + creditedBy identity", async () => {
    const repo = makeRepo()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null })
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
    expect(entry.occurredAt).toBe("2026-05-20T17:00:00.000Z")
    expect(entry.creditedAt).not.toBe(entry.occurredAt)
    expect(entry.creditedBy).toEqual({
      id: HOST,
      name: "Ann Host",
      handle: "ann",
      organization: null,
    })
  })

  it("badges the creditor with their organization in ONE batched lookup (0.43.0)", async () => {
    const org = {
      id: "99999999-9999-4999-8999-999999999999",
      slug: "ballona-creek-trust",
      name: "Ballona Creek Trust",
      logoUrl: null,
      verified: false,
      verifiedKind: null,
    }
    const repo = makeRepo()
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null })
    await creditEvent(repo, EVENT_IDS[0], BOB, 2, { title: "One" })
    await creditEvent(repo, EVENT_IDS[1], BOB, 1, { title: "Two" })
    const batches: string[][] = []
    const service = makeVolunteerHoursService({
      repo,
      cleanups: makeCleanups(null, []),
      affiliations: (ids) => {
        batches.push([...ids])
        return Promise.resolve(new Map(ids.map((id) => [id, org])))
      },
    })

    const page = await service.getMyHoursEntries(BOB, {})
    expect(batches).toHaveLength(1)
    expect(page.items.every((e) => e.creditedBy?.organization?.id === org.id)).toBe(true)
  })

  it("leaves the creditor unbadged when no loader is wired", async () => {
    const repo = makeRepo()
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null })
    await creditEvent(repo, EVENT_IDS[0], BOB, 2, { title: "One" })
    const page = await makeService(repo).getMyHoursEntries(BOB, {})
    expect(page.items[0]!.creditedBy?.organization).toBeNull()
  })
})

describe("hours ledger: the public projection (C18's two gates)", () => {
  async function seedBob(repo: InMemoryVolunteerHoursRepository): Promise<void> {
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann Host", handle: "ann", avatarUrl: null })
    await creditEvent(repo, EVENT_IDS[0], BOB, 2, { title: "Ocean Beach sweep" })
    await creditEvent(repo, EVENT_IDS[1], BOB, 1, { title: "Dolores clean-up" })
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
      showVolunteerHours: true,
    })
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)

    expect(res.visible).toBe(true)
    expect(res.totalHours).toBe(3.2)
    expect(res.byJurisdiction).toEqual([{ geoid: GEOID_A, name: "San Francisco", hours: 3.2 }])
    expect(res.items.map((e) => e.source)).toEqual(["event", "event"])
    expect(res.items.map((e) => e.eventTitle)).toEqual(["Dolores clean-up", "Ocean Beach sweep"])
    expect(res.reportHours).toBe(0)
    expect(res.items[0]?.creditedBy?.handle).toBe("ann")
  })

  it("NULL (never chosen): visible with an EMPTY items list and a truthful nextCursor", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null })
    const res = await makeService(repo).getPublicHours({ id: BOB }, CAROL)

    expect(res.visible).toBe(true)
    expect(res.totalHours).toBe(3.2)
    expect(res.reportHours).toBe(0)
    expect(res.items).toEqual([])
    expect(res.nextCursor).toBeNull()
  })

  it("FALSE (explicit opt-out): the public body is byte-identical to an empty user's (CVX-022)", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      showVolunteerHours: false,
    })
    repo.seedUser(DAVE, {
      name: "Dave",
      handle: "dave",
      avatarUrl: null,
      showVolunteerHours: true,
    })

    const hidden = await makeService(repo).getPublicHours({ id: BOB }, CAROL)
    const empty = await makeService(repo).getPublicHours({ id: DAVE }, CAROL)

    expect(hidden).toEqual(empty)
    expect(hidden).toEqual({
      visible: true,
      totalHours: 0,
      byJurisdiction: [],
      byOrganization: [],
      items: [],
      reportHours: 0,
      nextCursor: null,
    })
  })

  it("a soft-deleted account is byte-identical to an empty user too", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      showVolunteerHours: true,
      deleted: true,
    })
    repo.seedUser(DAVE, {
      name: "Dave",
      handle: "dave",
      avatarUrl: null,
      showVolunteerHours: true,
    })

    const deleted = await makeService(repo).getPublicHours({ id: BOB }, CAROL)
    const empty = await makeService(repo).getPublicHours({ id: DAVE }, CAROL)
    expect(deleted).toEqual(empty)
  })

  it("a viewer blocked either way sees the same empty body a hidden profile returns (CVX-023)", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
      showVolunteerHours: true,
    })
    repo.seedUser(DAVE, {
      name: "Dave",
      handle: "dave",
      avatarUrl: null,
      showVolunteerHours: true,
    })

    const gatedService = makeVolunteerHoursService({
      repo,
      cleanups: makeCleanups(null, []),
      isBlockedEitherWay: (a, b) =>
        Promise.resolve((a === CAROL && b === BOB) || (a === BOB && b === CAROL)),
    })

    const blocked = await gatedService.getPublicHours({ id: BOB }, CAROL)
    const empty = await makeService(repo).getPublicHours({ id: DAVE }, CAROL)
    expect(blocked).toEqual(empty)
    expect(blocked.items).toEqual([])

    const ownStillVisible = await gatedService.getPublicHours({ id: BOB }, BOB)
    expect(ownStillVisible.visible).toBe(true)
    expect(ownStillVisible.items.map((e) => e.source)).toEqual(["event", "event"])
  })

  it("isSelf bypasses both gates even when the owner has opted OUT", async () => {
    const repo = makeRepo()
    await seedBob(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: "bob",
      avatarUrl: null,
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
    expect(res.entries).toEqual([{ userId: CAROL, hours: 1.5, loggedAt: res.entries[0]!.loggedAt }])
    expect(res.anyLogged).toBe(true)
  })

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
