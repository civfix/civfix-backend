import { describe, it, expect } from "vitest"
import { REPORT_VOLUNTEER_HOURS } from "@civfix/shared"
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
const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const CLEANUP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const GEOID_A = "0644000"
const GEOID_B = "0667000"

function makeCleanups(
  view: CleanupHoursView | null,
  members: string[],
  cohosts: string[] = [],
): CleanupHoursLookup {
  return {
    load: () => Promise.resolve(view),
    listMemberIds: () => Promise.resolve(members),
    // Role derivation for tests: the view's organizer is 'organizer', listed cohosts are 'cohost',
    // any other listed member is 'member', everyone else null (not attending).
    roleOf: (_cleanupId: string, userId: string) => {
      if (view !== null && view.organizerUserId === userId) return Promise.resolve("organizer" as const)
      if (cohosts.includes(userId)) return Promise.resolve("cohost" as const)
      if (members.includes(userId)) return Promise.resolve("member" as const)
      return Promise.resolve(null)
    },
  }
}

function makeService(opts: {
  repo: InMemoryVolunteerHoursRepository
  view: CleanupHoursView | null
  members?: string[]
  cohosts?: string[]
  // Per-user verification map; a plain boolean applies to every caller (default: verified).
  verified?: boolean | Record<string, boolean>
}): VolunteerHoursService {
  const verified = opts.verified ?? true
  return makeVolunteerHoursService({
    repo: opts.repo,
    cleanups: makeCleanups(opts.view, opts.members ?? [], opts.cohosts ?? []),
    isVerified: (userId: string) =>
      Promise.resolve(typeof verified === "boolean" ? verified : (verified[userId] ?? false)),
  })
}

/** Shorthand: entries crediting the same `hours` to each listed user (the old bulk behavior). */
function flat(userIds: string[], hours: number): { userId: string; hours: number }[] {
  return userIds.map((userId) => ({ userId, hours }))
}

describe("volunteer hours: awardReportHours (once per report)", () => {
  it("credits a report's hours exactly once no matter how many times it is awarded", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")

    await repo.awardReportHours(HOST, REPORT, GEOID_A)
    await repo.awardReportHours(HOST, REPORT, GEOID_A)
    await repo.awardReportHours(HOST, REPORT, GEOID_A)

    const totals = await repo.totalsFor(HOST)
    expect(totals.totalHours).toBe(REPORT_VOLUNTEER_HOURS)
    expect(totals.byJurisdiction).toEqual([
      { geoid: GEOID_A, name: "San Francisco", hours: REPORT_VOLUNTEER_HOURS },
    ])
  })

  it("does not touch the rollup when the report has no jurisdiction", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    await repo.awardReportHours(HOST, REPORT, null)
    const totals = await repo.totalsFor(HOST)
    expect(totals.totalHours).toBe(0)
    expect(totals.byJurisdiction).toEqual([])
  })
})

describe("volunteer hours: logEventHours (service gating + crediting)", () => {
  const doneEvent: CleanupHoursView = {
    organizerUserId: HOST,
    status: "done",
    jurisdictionGeoid: GEOID_A,
  }

  it("credits each listed attendee their OWN hours and reports the row count", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB, CAROL] })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: HOST, hours: 2 },
        { userId: BOB, hours: 4.5 },
        { userId: CAROL, hours: 1 },
      ],
    })
    expect(result.credited).toBe(3)

    expect((await repo.totalsFor(HOST)).totalHours).toBe(2)
    expect((await repo.totalsFor(BOB)).totalHours).toBe(4.5)
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(1)
  })

  it("credits a SUBSET of attendees without touching the rest", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB, CAROL] })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [{ userId: BOB, hours: 3 }],
    })
    expect(result.credited).toBe(1)
    expect((await repo.totalsFor(BOB)).totalHours).toBe(3)
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(0)
  })

  it("re-logging overwrites per row via the rollup delta (no double-count)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([HOST, BOB], 2) })
    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: [{ userId: BOB, hours: 3 }] })

    expect((await repo.totalsFor(BOB)).totalHours).toBe(3)
    expect((await repo.totalsFor(HOST)).totalHours).toBe(2)
  })

  it("a VERIFIED cohost can log hours (D4: actor gate is organizer|cohost)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB, CAROL],
      cohosts: [BOB],
      verified: { [BOB]: true },
    })
    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: BOB,
      entries: [{ userId: CAROL, hours: 2 }],
    })
    expect(result.credited).toBe(1)
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(2)
  })

  it("rejects a plain-member caller (403)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: BOB, entries: flat([BOB], 1) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("rejects an unverified ACTOR even when the organizer is verified (D4 rule change)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    // The organizer (HOST) is verified, but the acting cohost (BOB) is not: 403.
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB],
      cohosts: [BOB],
      verified: { [HOST]: true },
    })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: BOB, entries: flat([HOST], 1) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("rejects an unverified organizer (403)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST], verified: false })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([HOST], 1) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("422s an entry whose userId is not a current member", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })
    await expect(
      service.logEventHours({
        cleanupId: CLEANUP,
        actorId: HOST,
        entries: [
          { userId: BOB, hours: 2 },
          { userId: CAROL, hours: 2 }, // never joined
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    // Nothing partial was written.
    expect((await repo.totalsFor(BOB)).totalHours).toBe(0)
  })

  it("422s out-of-range hours and duplicate userIds", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 25) }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 0) }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(
      service.logEventHours({
        cleanupId: CLEANUP,
        actorId: HOST,
        entries: [
          { userId: BOB, hours: 1 },
          { userId: BOB, hours: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("rejects an event that is not done yet (409)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: { organizerUserId: HOST, status: "upcoming", jurisdictionGeoid: GEOID_A },
      members: [HOST],
    })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([HOST], 1) }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("404s a missing event", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: null })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([HOST], 1) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("volunteer hours: leaderboard", () => {
  it("ranks users by hours desc with correct rank numbers", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: "ann", avatarUrl: null, verified: true })
    repo.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null, verified: false })
    repo.seedUser(CAROL, { name: "Carol", handle: null, avatarUrl: null, verified: false })

    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: flat([HOST, BOB, CAROL], 1),
    })
    await repo.awardReportHours(BOB, REPORT, GEOID_A)
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      geoid: GEOID_A,
      entries: flat([CAROL], 5),
    })

    const service = makeService({ repo, view: null })
    const page = await service.leaderboard(GEOID_A, {})

    expect(page.geoid).toBe(GEOID_A)
    expect(page.jurisdictionName).toBe("San Francisco")
    expect(page.nextOffset).toBeNull()
    expect(page.entries.map((e) => [e.rank, e.userId, e.hours])).toEqual([
      [1, CAROL, 6],
      [2, BOB, 1.1],
      [3, HOST, 1],
    ])
    expect(page.entries[1]?.handle).toBe("bob")
    expect(page.entries[1]?.verified).toBe(false)
    expect(page.entries[0]?.verified).toBe(false)
  })

  it("paginates via limit/offset and reports the next offset", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: null, avatarUrl: null, verified: false })
    repo.seedUser(BOB, { name: "Bob", handle: null, avatarUrl: null, verified: false })
    repo.seedUser(CAROL, { name: "Carol", handle: null, avatarUrl: null, verified: false })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: flat([HOST, BOB, CAROL], 3),
    })

    const service = makeService({ repo, view: null })
    const first = await service.leaderboard(GEOID_A, { limit: 2, offset: 0 })
    expect(first.entries).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    expect(first.entries.map((e) => e.rank)).toEqual([1, 2])

    const second = await service.leaderboard(GEOID_A, { limit: 2, offset: 2 })
    expect(second.entries).toHaveLength(1)
    expect(second.nextOffset).toBeNull()
    expect(second.entries[0]?.rank).toBe(3)
  })
})

describe("volunteer hours: totalsFor aggregates per jurisdiction", () => {
  it("sums the rollup across jurisdictions, newest-heaviest first", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedJurisdiction(GEOID_B, "Oakland")

    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: flat([HOST], 2),
    })
    await repo.awardReportHours(HOST, REPORT, GEOID_B)

    const totals = await repo.totalsFor(HOST)
    expect(totals.totalHours).toBe(2.1)
    expect(totals.byJurisdiction).toEqual([
      { geoid: GEOID_A, name: "San Francisco", hours: 2 },
      { geoid: GEOID_B, name: "Oakland", hours: REPORT_VOLUNTEER_HOURS },
    ])
    expect(await repo.totalHoursFor(HOST)).toBe(2.1)
  })
})
