import { afterEach, describe, it, expect } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import {
  makeVolunteerHoursService,
  type CleanupHoursLookup,
  type CleanupHoursView,
  type HoursModerationSink,
  type VolunteerHoursService,
} from "../../src/services/volunteer-hours-service.js"
import { InMemoryVolunteerHoursRepository } from "../helpers/volunteer-hours-repository.memory.js"
import type { InsightsInvalidator } from "../../src/services/host/host-analytics-cache.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import { makeServer } from "../../src/server.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"

const HOST = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"
const DAVE = "44444444-4444-4444-4444-444444444444"
const REPORT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const CLEANUP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const SCHEDULED_AT = new Date("2026-07-04T08:00:00.000Z")
const COMPLETED_AT = new Date("2026-07-05T07:00:00.000Z")
const ENDS_AT = new Date("2026-07-04T12:00:00.000Z")
const FUTURE_SCHEDULED_AT = new Date(Date.now() + 7 * 86_400_000)

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
    roleOf: (_cleanupId: string, userId: string) => {
      if (view !== null && view.organizerUserId === userId)
        return Promise.resolve("organizer" as const)
      if (cohosts.includes(userId)) return Promise.resolve("cohost" as const)
      if (members.includes(userId)) return Promise.resolve("member" as const)
      return Promise.resolve(null)
    },
  }
}

interface RecordingNotifier extends Pick<NotificationService, "createNotification"> {
  sent: { userId: string; type: string; vars: Record<string, string | number> }[]
}

function makeNotifier(throwFor?: string): RecordingNotifier {
  const sent: RecordingNotifier["sent"] = []
  return {
    sent,
    createNotification: (userId, input) => {
      if (userId === throwFor) return Promise.reject(new Error("prefs row is broken"))
      sent.push({
        userId,
        type: input.type,
        vars: input.vars ?? {},
      })
      return Promise.resolve({} as Awaited<ReturnType<NotificationService["createNotification"]>>)
    },
  }
}

function makeService(opts: {
  repo: InMemoryVolunteerHoursRepository
  view: CleanupHoursView | null
  members?: string[]
  cohosts?: string[]
  notifier?: Pick<NotificationService, "createNotification">
  moderation?: HoursModerationSink
  weeklyFlagHours?: number
  insightsInvalidator?: InsightsInvalidator
  presignOrgLogo?: (key: string) => Promise<string>
}): VolunteerHoursService {
  return makeVolunteerHoursService({
    repo: opts.repo,
    cleanups: makeCleanups(opts.view, opts.members ?? [], opts.cohosts ?? []),
    ...(opts.notifier !== undefined ? { notifier: opts.notifier } : {}),
    ...(opts.moderation !== undefined ? { moderation: opts.moderation } : {}),
    ...(opts.weeklyFlagHours !== undefined ? { weeklyFlagHours: opts.weeklyFlagHours } : {}),
    ...(opts.insightsInvalidator !== undefined
      ? { insightsInvalidator: opts.insightsInvalidator }
      : {}),
    ...(opts.presignOrgLogo !== undefined ? { presignOrgLogo: opts.presignOrgLogo } : {}),
  })
}

function makeInvalidatorSpy(): InsightsInvalidator & { bumped: string[] } {
  const bumped: string[] = []
  return {
    bumped,
    bumpInsightsGeneration: (cleanupId: string) => {
      bumped.push(cleanupId)
      return Promise.resolve()
    },
  }
}

interface RecordingModeration extends HoursModerationSink {
  filed: Parameters<HoursModerationSink["flag"]>[0][]
}

function makeModerationSink(): RecordingModeration {
  const filed: RecordingModeration["filed"] = []
  return {
    filed,
    flag: (input) => {
      filed.push(input)
      return Promise.resolve()
    },
  }
}

function eventOfLength(hours: number): CleanupHoursView {
  return {
    organizerUserId: HOST,
    status: "done",
    visibility: "public",
    jurisdictionGeoid: GEOID_A,
    title: "Ocean Beach sweep",
    scheduledAt: SCHEDULED_AT,
    endsAt: ENDS_AT,
    completedAt: new Date(SCHEDULED_AT.getTime() + hours * 3_600_000),
    timezone: null,
  }
}

function flat(userIds: string[], hours: number): { userId: string; hours: number }[] {
  return userIds.map((userId) => ({ userId, hours }))
}

describe("volunteer hours: a report filing is not volunteer service", () => {
  it("the repository exposes NO way to credit a report", () => {
    const repo = new InMemoryVolunteerHoursRepository()
    expect("awardReportHours" in repo).toBe(false)
  })

  it("a pre-0065 report row is neither itemised to the owner nor printed on a transcript", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedLegacyReportEntry(HOST, REPORT, GEOID_A)
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [{ userId: HOST, hours: 2 }],
    })

    const page = await repo.listEntries({ userId: HOST, cursor: null, limit: 50 })
    expect(page.items.map((e) => e.source)).toEqual(["event"])

    const cert = await repo.entriesForCertificate({
      userId: HOST,
      geoid: null,
      from: null,
      to: null,
      limit: 50,
    })
    expect(cert.items.map((e) => e.source)).toEqual(["event"])
    expect(cert.totalHours).toBe(2)
    expect(cert.entryCount).toBe(1)
  })
})

describe("volunteer hours: logEventHours (service gating + crediting)", () => {
  const doneEvent: CleanupHoursView = {
    organizerUserId: HOST,
    status: "done",
    visibility: "public",
    jurisdictionGeoid: GEOID_A,
    title: "Ocean Beach sweep",
    scheduledAt: SCHEDULED_AT,
    endsAt: ENDS_AT,
    completedAt: COMPLETED_AT,
    timezone: null,
  }

  it("credits each listed attendee their OWN hours and reports the row count", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB, CAROL, DAVE] })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: DAVE, hours: 2 },
        { userId: BOB, hours: 4.5 },
        { userId: CAROL, hours: 1 },
      ],
    })
    expect(result.credited).toBe(3)

    expect((await repo.totalsFor(DAVE)).totalHours).toBe(2)
    expect((await repo.totalsFor(BOB)).totalHours).toBe(4.5)
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(1)
  })

  it("M21: refuses to credit the acting host themselves (403)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })

    await expect(
      service.logEventHours({
        cleanupId: CLEANUP,
        actorId: HOST,
        entries: [{ userId: HOST, hours: 8 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await repo.totalsFor(HOST)).totalHours).toBe(0)
  })

  it("M21: rejects the WHOLE request when the actor smuggles themselves into a valid batch", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB, CAROL] })

    await expect(
      service.logEventHours({
        cleanupId: CLEANUP,
        actorId: HOST,
        entries: [
          { userId: BOB, hours: 2 },
          { userId: HOST, hours: 8 },
        ],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await repo.totalsFor(HOST)).totalHours).toBe(0)
    expect((await repo.totalsFor(BOB)).totalHours).toBe(0)
  })

  it("M21: a DIFFERENT host may still credit the organizer (the second-party path)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB],
      cohosts: [BOB],
    })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: BOB,
      entries: [{ userId: HOST, hours: 5 }],
    })
    expect(result.credited).toBe(1)
    expect((await repo.totalsFor(HOST)).totalHours).toBe(5)
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
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB, CAROL] })

    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: flat([CAROL, BOB], 2),
    })
    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [{ userId: BOB, hours: 3 }],
    })

    expect((await repo.totalsFor(BOB)).totalHours).toBe(3)
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(2)
  })

  it("a cohost can log hours (D4: the actor gate is organizer|cohost standing, nothing else)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB, CAROL],
      cohosts: [BOB],
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

  it("0.43.0: identity verification is retired, so a plain cohost credits without one", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB],
      cohosts: [BOB],
    })
    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: BOB,
      entries: flat([HOST], 1),
    })
    expect(result.credited).toBe(1)
    expect((await repo.totalsFor(HOST)).totalHours).toBe(1)
  })

  it("rejects the organizer crediting themselves (403)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST] })
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
          { userId: CAROL, hours: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
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

  it("F069: 422s a sub-centihour credit that would round to 0.00 and trip the numeric(6,2) CHECK", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({ repo, view: doneEvent, members: [HOST, BOB] })
    await expect(
      service.logEventHours({
        cleanupId: CLEANUP,
        actorId: HOST,
        entries: [{ userId: BOB, hours: 0.001 }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [{ userId: BOB, hours: 3.14159 }],
    })
    const page = await repo.entriesForCertificate({
      userId: BOB,
      geoid: null,
      from: null,
      to: null,
      limit: 10,
    })
    expect(page.items[0]?.hours).toBe(3.14)
  })

  it("rejects an event that has not ended yet (409)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const service = makeService({
      repo,
      view: {
        organizerUserId: HOST,
        status: "upcoming",
        visibility: "public",
        jurisdictionGeoid: GEOID_A,
        title: "Ocean Beach sweep",
        scheduledAt: FUTURE_SCHEDULED_AT,
        endsAt: new Date(FUTURE_SCHEDULED_AT.getTime() + 4 * 3_600_000),
        completedAt: null,
        timezone: null,
      },
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

describe("H9: volunteer hours cannot be minted faster than events actually run", () => {
  function seedEvent(
    repo: InMemoryVolunteerHoursRepository,
    cleanupId: string,
    at: Date,
    timezone: string | null = null,
  ): void {
    repo.seedCleanup(cleanupId, { title: "Sweep", referenceCode: null, scheduledAt: at, timezone })
  }

  it("a: caps a per-attendee credit at the event's own window plus one hour of grace", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const service = makeService({ repo, view: eventOfLength(2), members: [HOST, BOB] })

    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 3.5) }),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 3) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(3)
  })

  it("a: with no completion stamp the cap falls back to the scheduled window (DECISIONS §41)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    // ENDS_AT is scheduledAt + 4 h, so the cap is 4 h + 1 h of grace.
    const noStamp: CleanupHoursView = { ...eventOfLength(2), completedAt: null }
    const service = makeService({ repo, view: noStamp, members: [HOST, BOB] })

    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 5.5) }),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 5) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(5)
  })

  it("e: refuses hours for an event that ran for less than the minimum duration", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const service = makeService({ repo, view: eventOfLength(0.2), members: [HOST, BOB] })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 0.1) }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("b: caps one attendee at 24 h per EVENT-ZONE day ACROSS events", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const morning = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    const evening = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    // Both instants are 2026-07-04 in America/Los_Angeles, the DEFAULT_EVENT_TIME_ZONE fallback.
    seedEvent(repo, morning, new Date("2026-07-04T15:00:00.000Z"))
    seedEvent(repo, evening, new Date("2026-07-05T01:00:00.000Z"))

    const first = makeService({
      repo,
      view: { ...eventOfLength(23), organizerUserId: HOST },
      members: [HOST, BOB],
    })
    await first.logEventHours({ cleanupId: morning, actorId: HOST, entries: flat([BOB], 20) })

    await expect(
      first.logEventHours({ cleanupId: evening, actorId: HOST, entries: flat([BOB], 5) }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    await first.logEventHours({ cleanupId: evening, actorId: HOST, entries: flat([BOB], 4) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(24)
  })

  it("b: the same-day cap does not leak across event-zone days", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const day1 = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    const day2 = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    seedEvent(repo, day1, new Date("2026-07-04T15:00:00.000Z"))
    seedEvent(repo, day2, new Date("2026-07-05T15:00:00.000Z"))
    const service = makeService({ repo, view: eventOfLength(23), members: [HOST, BOB] })
    await service.logEventHours({ cleanupId: day1, actorId: HOST, entries: flat([BOB], 20) })
    await service.logEventHours({ cleanupId: day2, actorId: HOST, entries: flat([BOB], 20) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(40)
  })

  it("b: two events on the same UTC day but different EVENT-ZONE days do not share the cap", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const laNight = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    const laMorning = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    // Both 2026-07-04 in UTC; 2026-07-03 and 2026-07-04 in America/Los_Angeles.
    seedEvent(repo, laNight, new Date("2026-07-04T06:00:00.000Z"))
    seedEvent(repo, laMorning, new Date("2026-07-04T18:00:00.000Z"))
    const service = makeService({ repo, view: eventOfLength(23), members: [HOST, BOB] })

    await service.logEventHours({ cleanupId: laNight, actorId: HOST, entries: flat([BOB], 20) })
    await service.logEventHours({ cleanupId: laMorning, actorId: HOST, entries: flat([BOB], 20) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(40)
  })

  it("c: blocks reciprocal crediting inside one event, in both directions", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const view = eventOfLength(23)
    const asHost = makeService({ repo, view, members: [HOST, BOB], cohosts: [BOB] })

    await asHost.logEventHours({ cleanupId: CLEANUP, actorId: BOB, entries: flat([HOST], 4) })

    await expect(
      asHost.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 4) }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    const withCarol = makeService({
      repo,
      view,
      members: [HOST, BOB, CAROL],
      cohosts: [BOB],
    })
    await withCarol.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([CAROL], 4) })
    expect((await repo.totalsFor(CAROL)).totalHours).toBe(4)
  })

  it("c: the reciprocity refusal holds when the ORGANIZER credits first", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const service = makeService({
      repo,
      view: eventOfLength(23),
      members: [HOST, BOB],
      cohosts: [BOB],
    })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 4) })
    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: BOB, entries: flat([HOST], 4) }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await repo.totalsFor(HOST)).totalHours).toBe(0)
  })

  it("d: files a moderation item when a ledger crosses the rolling 7-day threshold", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const moderation = makeModerationSink()
    const service = makeService({
      repo,
      view: eventOfLength(23),
      members: [HOST, BOB],
      moderation,
      weeklyFlagHours: 5,
    })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 4) })
    expect(moderation.filed).toHaveLength(0)

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 9) })
    expect(moderation.filed).toEqual([
      { userId: BOB, cleanupId: CLEANUP, kind: "weekly_hours", counterpartUserId: null, hours: 9 },
    ])
  })

  it("d: files a moderation item for a reciprocal swap across two events", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const first = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    const second = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    seedEvent(repo, first, new Date("2026-07-04T06:00:00.000Z"))
    seedEvent(repo, second, new Date("2026-07-06T06:00:00.000Z"))
    const moderation = makeModerationSink()
    const service = makeService({
      repo,
      view: eventOfLength(23),
      members: [HOST, BOB],
      cohosts: [BOB],
      moderation,
    })

    await service.logEventHours({ cleanupId: first, actorId: BOB, entries: flat([HOST], 6) })
    await service.logEventHours({ cleanupId: second, actorId: HOST, entries: flat([BOB], 6) })

    expect(moderation.filed).toEqual([
      {
        userId: BOB,
        cleanupId: second,
        kind: "reciprocal_credit",
        counterpartUserId: HOST,
        hours: null,
      },
    ])
  })

  it("d: a moderation outage never undoes the credit that produced the signal", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedEvent(repo, CLEANUP, SCHEDULED_AT)
    const service = makeService({
      repo,
      view: eventOfLength(23),
      members: [HOST, BOB],
      moderation: { flag: () => Promise.reject(new Error("moderation is down")) },
      weeklyFlagHours: 1,
    })
    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 6) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(6)
  })
})

describe("volunteer hours: leaderboard", () => {
  it("ranks users by hours desc with correct rank numbers", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: "ann", avatarUrl: null })
    repo.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null })
    repo.seedUser(CAROL, { name: "Carol", handle: null, avatarUrl: null })

    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: flat([HOST, BOB, CAROL], 1),
    })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      geoid: GEOID_A,
      entries: flat([BOB], 0.1),
    })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      geoid: GEOID_A,
      entries: flat([CAROL], 5),
    })

    const service = makeService({ repo, view: null })
    const page = await service.leaderboard(GEOID_A, { geoid: GEOID_A })

    expect(page.geoid).toBe(GEOID_A)
    expect(page.jurisdictionName).toBe("San Francisco")
    expect(page.nextOffset).toBeNull()
    expect(page.entries.map((e) => [e.rank, e.userId, e.hours])).toEqual([
      [1, CAROL, 6],
      [2, BOB, 1.1],
      [3, HOST, 1],
    ])
    expect(page.entries[1]?.handle).toBe("bob")
  })

  it("paginates via limit/offset and reports the next offset", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: null, avatarUrl: null })
    repo.seedUser(BOB, { name: "Bob", handle: null, avatarUrl: null })
    repo.seedUser(CAROL, { name: "Carol", handle: null, avatarUrl: null })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: flat([HOST, BOB, CAROL], 3),
    })

    const service = makeService({ repo, view: null })
    const first = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 2, offset: 0 })
    expect(first.entries).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    expect(first.entries.map((e) => e.rank)).toEqual([1, 2])

    const second = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 2, offset: 2 })
    expect(second.entries).toHaveLength(1)
    expect(second.nextOffset).toBeNull()
    expect(second.entries[0]?.rank).toBe(3)
  })

  it("C18: excludes an explicit opt-OUT and keeps a never-chosen (NULL) user on the board", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: null, avatarUrl: null })
    repo.seedUser(BOB, {
      name: "Bob",
      handle: null,
      avatarUrl: null,
      showVolunteerHours: true,
    })
    repo.seedUser(CAROL, {
      name: "Carol",
      handle: null,
      avatarUrl: null,
      showVolunteerHours: false,
    })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [
        { userId: HOST, hours: 3 },
        { userId: BOB, hours: 2 },
        { userId: CAROL, hours: 9 },
      ],
    })

    const service = makeService({ repo, view: null })
    const page = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 25 })
    expect(page.entries.map((e) => e.userId)).toEqual([HOST, BOB])
    expect(page.entries.map((e) => e.rank)).toEqual([1, 2])
    expect(page.participantCount).toBe(2)
  })

  it("B48: viewerRank/viewerHours/participantCount only on the full page, count only at offset 0", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    for (const [id, name] of [
      [HOST, "Ann"],
      [BOB, "Bob"],
      [CAROL, "Carol"],
    ] as const) {
      repo.seedUser(id, { name, handle: null, avatarUrl: null })
    }
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [
        { userId: HOST, hours: 5 },
        { userId: BOB, hours: 3 },
        { userId: CAROL, hours: 1 },
      ],
    })
    const service = makeService({ repo, view: null })

    const full = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 25 }, BOB)
    expect(full.participantCount).toBe(3)
    expect(full.viewerRank).toBe(2)
    expect(full.viewerHours).toBe(3)

    const deep = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 25, offset: 25 }, BOB)
    expect(deep.participantCount).toBeUndefined()
    expect(deep.viewerRank).toBe(2)

    const anon = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 25 })
    expect(anon.participantCount).toBe(3)
    expect(anon.viewerRank).toBeUndefined()
    expect(anon.viewerHours).toBeUndefined()

    const stranger = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 25 }, DAVE)
    expect(stranger.viewerRank).toBeNull()
    expect(stranger.viewerHours).toBeNull()
  })

  it("the 3-row Discovery preview pays for NO extras (limit below the threshold)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    repo.seedUser(HOST, { name: "Ann", handle: null, avatarUrl: null })
    await repo.logEventHours({
      actorId: BOB,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [{ userId: HOST, hours: 4 }],
    })
    const service = makeService({ repo, view: null })
    const preview = await service.leaderboard(GEOID_A, { geoid: GEOID_A, limit: 3 }, HOST)
    expect(preview.entries).toHaveLength(1)
    expect(preview.participantCount).toBeUndefined()
    expect(preview.viewerRank).toBeUndefined()
    expect(preview.viewerHours).toBeUndefined()
  })

  it("B48: an OMITTED limit is the full board and still pays for the extras", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    for (const [id, name] of [
      [HOST, "Ann"],
      [BOB, "Bob"],
      [CAROL, "Carol"],
    ] as const) {
      repo.seedUser(id, { name, handle: null, avatarUrl: null })
    }
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [
        { userId: HOST, hours: 5 },
        { userId: BOB, hours: 3 },
        { userId: CAROL, hours: 1 },
      ],
    })
    const service = makeService({ repo, view: null })

    const board = await service.leaderboard(GEOID_A, { geoid: GEOID_A }, BOB)
    expect(board.participantCount).toBe(3)
    expect(board.viewerRank).toBe(2)
    expect(board.viewerHours).toBe(3)

    const anon = await service.leaderboard(GEOID_A, { geoid: GEOID_A })
    expect(anon.participantCount).toBe(3)
    expect(anon.viewerRank).toBeUndefined()
    expect(anon.viewerHours).toBeUndefined()
  })
})

describe("volunteer hours: hours_logged notifications", () => {
  const doneEvent: CleanupHoursView = {
    organizerUserId: HOST,
    status: "done",
    visibility: "public",
    jurisdictionGeoid: GEOID_A,
    title: "Ocean Beach sweep",
    scheduledAt: SCHEDULED_AT,
    endsAt: ENDS_AT,
    completedAt: COMPLETED_AT,
    timezone: null,
  }

  it("the repo returns the changed[] pre-image (null previous = a first credit)", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const first = await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [
        { userId: BOB, hours: 2 },
        { userId: CAROL, hours: 1 },
      ],
    })
    expect(first.credited).toBe(2)
    expect(first.changed).toEqual([
      { userId: BOB, hours: 2, previousHours: null },
      { userId: CAROL, hours: 1, previousHours: null },
    ])

    const second = await repo.logEventHours({
      actorId: HOST,
      cleanupId: CLEANUP,
      geoid: GEOID_A,
      entries: [{ userId: BOB, hours: 5 }],
    })
    expect(second.changed).toEqual([{ userId: BOB, hours: 5, previousHours: 2 }])
  })

  it("rings every newly-credited attendee, with the hours and the event title", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const notifier = makeNotifier()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB, CAROL],
      notifier,
    })
    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: BOB, hours: 2 },
        { userId: CAROL, hours: 1.5 },
      ],
    })
    expect(notifier.sent.map((s) => s.userId).sort()).toEqual([BOB, CAROL].sort())
    expect(notifier.sent.every((s) => s.type === "hours_logged")).toBe(true)
    expect(notifier.sent.find((s) => s.userId === CAROL)?.vars).toEqual({
      hours: 1.5,
      title: "Ocean Beach sweep",
    })
  })

  it("does NOT ring on an unchanged re-log or on a downward correction", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const notifier = makeNotifier()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB, CAROL],
      notifier,
    })
    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: BOB, hours: 4 },
        { userId: CAROL, hours: 4 },
      ],
    })
    expect(notifier.sent).toHaveLength(2)
    notifier.sent.length = 0

    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: BOB, hours: 4 },
        { userId: CAROL, hours: 2 },
      ],
    })
    expect(notifier.sent).toEqual([])

    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: BOB, hours: 4 },
        { userId: CAROL, hours: 6 },
      ],
    })
    expect(notifier.sent.map((s) => s.userId)).toEqual([CAROL])
  })

  it("is best-effort PER RECIPIENT: one failure does not abandon the others", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const notifier = makeNotifier(BOB)
    const warnings: unknown[] = []
    const service = makeVolunteerHoursService({
      repo,
      cleanups: makeCleanups(doneEvent, [HOST, BOB, CAROL, DAVE]),
      notifier,
      logger: { warn: (obj) => warnings.push(obj) },
    })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: [
        { userId: BOB, hours: 1 },
        { userId: CAROL, hours: 1 },
        { userId: DAVE, hours: 1 },
      ],
    })
    expect(result.credited).toBe(3)
    expect(notifier.sent.map((s) => s.userId).sort()).toEqual([CAROL, DAVE].sort())
    expect(warnings).toHaveLength(1)
  })

  it("never rings the acting host", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    const notifier = makeNotifier()
    const service = makeService({
      repo,
      view: doneEvent,
      members: [HOST, BOB],
      cohosts: [BOB],
      notifier,
    })
    await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: BOB,
      entries: [{ userId: HOST, hours: 3 }],
    })
    expect(notifier.sent.map((s) => s.userId)).toEqual([HOST])
  })
})

describe("volunteer hours routes: leaderboard T1/T4 tripwires", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function makeApp(): Promise<{ app: FastifyInstance; token: string; userId: string }> {
    const env = loadEnv({ NODE_ENV: "test", WEB_ORIGINS: "https://civfix.org" })
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const mailer = new FakeMailer()
    const authServices = makeAuthServices({
      stores,
      cache,
      mailer,
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedJurisdiction(GEOID_A, "San Francisco")
    const built = await makeServer({
      env,
      container: makeContainer(env),
      authServices,
      volunteerOverrides: { repo },
    })
    app = built

    const email = "leaderboard-viewer@example.com"
    await built.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
    const verify = await built.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { "x-client": "mobile" },
      payload: { email, code: mailer.lastOtpFor(email)! },
    })
    const body = verify.json<{ token: string; user: { id: string } }>()
    return { app: built, token: body.token, userId: body.user.id }
  }

  it("T1: an EMPTY query string returns 200, not 422", async () => {
    const { app: built } = await makeApp()
    const res = await built.inject({
      method: "GET",
      url: `/v1/jurisdictions/${GEOID_A}/leaderboard`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ geoid: string; entries: unknown[] }>()
    expect(body.geoid).toBe(GEOID_A)
    expect(body.entries).toEqual([])
  })

  it("T4: anon gets a SHARED cache TTL and authed gets no-store; both carrying Vary", async () => {
    const { app: built, token } = await makeApp()

    const anon = await built.inject({
      method: "GET",
      url: `/v1/jurisdictions/${GEOID_A}/leaderboard`,
    })
    expect(anon.statusCode).toBe(200)
    expect(anon.headers["cache-control"]).toBe("public, max-age=60")
    expect(anon.headers["vary"]).toContain("Cookie")
    expect(anon.headers["vary"]).toContain("Authorization")

    const authed = await built.inject({
      method: "GET",
      url: `/v1/jurisdictions/${GEOID_A}/leaderboard`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authed.statusCode).toBe(200)
    expect(authed.headers["cache-control"]).toBe("private, max-age=0, no-store")
    expect(authed.headers["vary"]).toContain("Cookie")
    expect(authed.headers["vary"]).toContain("Authorization")
  })

  it("T4: the Vary the route adds MERGES with the Origin @fastify/cors already set", async () => {
    const { app: built } = await makeApp()
    const res = await built.inject({
      method: "GET",
      url: `/v1/jurisdictions/${GEOID_A}/leaderboard`,
      headers: { origin: "https://civfix.org" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["vary"]).toBe("Origin, Cookie, Authorization")
  })

  it("T4: getPublicVolunteerHours splits its cache the same way the leaderboard does", async () => {
    const { app: built, token } = await makeApp()

    const anon = await built.inject({
      method: "GET",
      url: `/v1/people/${HOST}/volunteer-hours`,
    })
    expect(anon.statusCode).toBe(200)
    expect(anon.headers["cache-control"]).toBe("public, max-age=60")
    expect(anon.headers["vary"]).toContain("Cookie")
    expect(anon.headers["vary"]).toContain("Authorization")

    const authed = await built.inject({
      method: "GET",
      url: `/v1/people/${HOST}/volunteer-hours`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authed.statusCode).toBe(200)
    expect(authed.headers["cache-control"]).toBe("private, max-age=0, no-store")
    expect(authed.headers["vary"]).toContain("Cookie")
    expect(authed.headers["vary"]).toContain("Authorization")
  })

  it("T4: getPublicVolunteerHours also MERGES its Vary with the CORS Origin", async () => {
    const { app: built } = await makeApp()
    const res = await built.inject({
      method: "GET",
      url: `/v1/people/${HOST}/volunteer-hours`,
      headers: { origin: "https://civfix.org" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["vary"]).toBe("Origin, Cookie, Authorization")
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
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      geoid: GEOID_B,
      entries: flat([HOST], 0.1),
    })

    const totals = await repo.totalsFor(HOST)
    expect(totals.totalHours).toBe(2.1)
    expect(totals.byJurisdiction).toEqual([
      { geoid: GEOID_A, name: "San Francisco", hours: 2 },
      { geoid: GEOID_B, name: "Oakland", hours: 0.1 },
    ])
    expect(await repo.totalHoursFor(HOST)).toBe(2.1)
  })
})

describe("#110: hours grouped by the organization that hosted the event", () => {
  const ORG_A = "cccccccc-cccc-cccc-cccc-cccccccccc01"
  const ORG_B = "cccccccc-cccc-cccc-cccc-cccccccccc02"
  const CLEANUP_A1 = "dddddddd-dddd-dddd-dddd-dddddddddd01"
  const CLEANUP_A2 = "dddddddd-dddd-dddd-dddd-dddddddddd02"
  const CLEANUP_B1 = "dddddddd-dddd-dddd-dddd-dddddddddd03"
  const CLEANUP_SOLO = "dddddddd-dddd-dddd-dddd-dddddddddd04"

  function seedPortfolio(repo: InMemoryVolunteerHoursRepository): void {
    repo.seedOrganization({ id: ORG_A, slug: "coast-guard", name: "Coast Guard", verified: true })
    repo.seedOrganization({ id: ORG_B, slug: "river-keepers", name: "River Keepers" })
    for (const [cleanupId, organizationId] of [
      [CLEANUP_A1, ORG_A],
      [CLEANUP_A2, ORG_A],
      [CLEANUP_B1, ORG_B],
      [CLEANUP_SOLO, null],
    ] as const) {
      repo.seedCleanup(cleanupId, {
        title: "Sweep",
        referenceCode: null,
        scheduledAt: SCHEDULED_AT,
        organizationId,
      })
    }
  }

  async function credit(
    repo: InMemoryVolunteerHoursRepository,
    cleanupId: string,
    hours: number,
  ): Promise<void> {
    await repo.logEventHours({
      actorId: HOST,
      cleanupId,
      geoid: GEOID_A,
      entries: [{ userId: BOB, hours }],
    })
  }

  it("groups every credited event under its host org, hours descending", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedPortfolio(repo)
    await credit(repo, CLEANUP_B1, 5)
    await credit(repo, CLEANUP_A1, 4)
    await credit(repo, CLEANUP_A2, 3)

    const hours = await makeService({ repo, view: null }).getMyHours(BOB)
    expect(hours.byOrganization.map((row) => [row.organization.slug, row.hours])).toEqual([
      ["coast-guard", 7],
      ["river-keepers", 5],
    ])
    expect(hours.byOrganization[0]?.organization.verified).toBe(true)
    expect(hours.byOrganization[1]?.organization.verified).toBe(false)
  })

  it("keeps an event with no host org out of the chips while counting it in the total", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedPortfolio(repo)
    await credit(repo, CLEANUP_A1, 2)
    await credit(repo, CLEANUP_SOLO, 6)

    const hours = await makeService({ repo, view: null }).getMyHours(BOB)
    expect(hours.totalHours).toBe(8)
    expect(hours.byOrganization.map((row) => row.organization.id)).toEqual([ORG_A])
    expect(hours.byOrganization[0]?.hours).toBe(2)
  })

  it("drops an organization once its only credited entry is voided", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedPortfolio(repo)
    await credit(repo, CLEANUP_A1, 2)
    await credit(repo, CLEANUP_B1, 3)
    const page = await repo.listEntries({ userId: BOB, cursor: null, limit: 50 })
    const orgAEntry = page.items.find((item) => item.cleanupId === CLEANUP_A1)
    expect(orgAEntry).toBeDefined()
    repo.voidEntry(orgAEntry!.id)

    const hours = await makeService({ repo, view: null }).getMyHours(BOB)
    expect(hours.byOrganization.map((row) => row.organization.id)).toEqual([ORG_B])
  })

  it("hides a soft-deleted or suspended organization without changing the total", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedOrganization({ id: ORG_A, slug: "coast-guard", name: "Coast Guard", deleted: true })
    repo.seedOrganization({
      id: ORG_B,
      slug: "river-keepers",
      name: "River Keepers",
      suspended: true,
    })
    repo.seedCleanup(CLEANUP_A1, {
      title: "Sweep",
      referenceCode: null,
      scheduledAt: SCHEDULED_AT,
      organizationId: ORG_A,
    })
    repo.seedCleanup(CLEANUP_B1, {
      title: "Sweep",
      referenceCode: null,
      scheduledAt: SCHEDULED_AT,
      organizationId: ORG_B,
    })
    await credit(repo, CLEANUP_A1, 2)
    await credit(repo, CLEANUP_B1, 3)

    const hours = await makeService({ repo, view: null }).getMyHours(BOB)
    expect(hours.totalHours).toBe(5)
    expect(hours.byOrganization).toEqual([])
  })

  it("presigns the org logo once per key and leaves a logo-less org null", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedOrganization({
      id: ORG_A,
      slug: "coast-guard",
      name: "Coast Guard",
      logoKey: "media/coast-guard.png",
    })
    repo.seedOrganization({ id: ORG_B, slug: "river-keepers", name: "River Keepers" })
    repo.seedCleanup(CLEANUP_A1, {
      title: "Sweep",
      referenceCode: null,
      scheduledAt: SCHEDULED_AT,
      organizationId: ORG_A,
    })
    repo.seedCleanup(CLEANUP_A2, {
      title: "Sweep",
      referenceCode: null,
      scheduledAt: SCHEDULED_AT,
      organizationId: ORG_A,
    })
    repo.seedCleanup(CLEANUP_B1, {
      title: "Sweep",
      referenceCode: null,
      scheduledAt: SCHEDULED_AT,
      organizationId: ORG_B,
    })
    await credit(repo, CLEANUP_A1, 4)
    await credit(repo, CLEANUP_A2, 4)
    await credit(repo, CLEANUP_B1, 1)

    const asked: string[] = []
    const service = makeService({
      repo,
      view: null,
      presignOrgLogo: (key) => {
        asked.push(key)
        return Promise.resolve(`https://cdn.example/${key}`)
      },
    })
    const hours = await service.getMyHours(BOB)

    expect(asked).toEqual(["media/coast-guard.png"])
    expect(hours.byOrganization[0]?.organization.logoUrl).toBe(
      "https://cdn.example/media/coast-guard.png",
    )
    expect(hours.byOrganization[1]?.organization.logoUrl).toBeNull()
  })

  it("serves the chips on a public profile whose owner never chose a visibility", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedPortfolio(repo)
    repo.seedUser(BOB, { name: "Bob", handle: null, avatarUrl: null })
    await credit(repo, CLEANUP_A1, 4)

    const service = makeService({ repo, view: null })
    const own = await service.getMyHours(BOB)
    const publicView = await service.getPublicHours({ id: BOB }, CAROL)

    expect(publicView.visible).toBe(true)
    expect(publicView.byOrganization).toEqual(own.byOrganization)
  })

  it("publishes no organization at all for a profile opted out of public hours", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    seedPortfolio(repo)
    repo.seedUser(BOB, {
      name: "Bob",
      handle: null,
      avatarUrl: null,
      showVolunteerHours: false,
    })
    await credit(repo, CLEANUP_A1, 4)

    const publicView = await makeService({ repo, view: null }).getPublicHours({ id: BOB }, CAROL)
    expect(publicView.totalHours).toBe(0)
    expect(publicView.byOrganization).toEqual([])
  })
})

describe("#110: logging hours refreshes the host console", () => {
  it("bumps the insights generation for that event exactly once, after the ledger write", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedCleanup(CLEANUP, { title: "Sweep", referenceCode: null, scheduledAt: SCHEDULED_AT })
    const invalidator = makeInvalidatorSpy()
    const service = makeService({
      repo,
      view: eventOfLength(4),
      members: [HOST, BOB],
      insightsInvalidator: invalidator,
    })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 2) })

    expect(invalidator.bumped).toEqual([CLEANUP])
    expect((await repo.totalsFor(BOB)).totalHours).toBe(2)
  })

  it("still credits the ledger when no invalidator is wired", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedCleanup(CLEANUP, { title: "Sweep", referenceCode: null, scheduledAt: SCHEDULED_AT })
    const service = makeService({ repo, view: eventOfLength(4), members: [HOST, BOB] })

    const result = await service.logEventHours({
      cleanupId: CLEANUP,
      actorId: HOST,
      entries: flat([BOB], 2),
    })
    expect(result.credited).toBe(1)
  })

  it("caps an attendee who worked one shift by the whole event window, not the shift", async () => {
    const repo = new InMemoryVolunteerHoursRepository()
    repo.seedCleanup(CLEANUP, { title: "Sweep", referenceCode: null, scheduledAt: SCHEDULED_AT })
    const service = makeService({ repo, view: eventOfLength(6), members: [HOST, BOB] })

    await service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 7) })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(7)

    await expect(
      service.logEventHours({ cleanupId: CLEANUP, actorId: HOST, entries: flat([BOB], 7.5) }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})
