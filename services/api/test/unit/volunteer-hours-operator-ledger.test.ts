import { describe, expect, it } from "vitest"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { parseTimeCursor } from "../../src/db/cursor-helpers.js"
import { buildTranscriptModel } from "../../src/services/certificate-model.js"
import { InMemoryCertificateRepository } from "../../src/services/certificate-repository.memory.js"
import { InMemoryVolunteerHoursRepository } from "../../src/services/volunteer-hours-repository.memory.js"
import {
  DAILY_HOURS_CAP,
  MANUAL_CREDIT_REPEAT_WINDOW_MS,
} from "../../src/services/volunteer-hours-service.js"

const HOST = "11111111-1111-1111-1111-111111111111"
const BOB = "22222222-2222-2222-2222-222222222222"
const CAROL = "33333333-3333-3333-3333-333333333333"
const OPERATOR = "99999999-9999-4999-8999-999999999999"
const OTHER_OPERATOR = "88888888-8888-4888-8888-888888888888"
const EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
const SAME_DAY_EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const REPORT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const GEOID = "0644000"
const EVENT_DAY = "2026-07-04"
const SCHEDULED_AT = new Date(`${EVENT_DAY}T08:00:00.000Z`)

function makeClock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let at = Date.parse(start)
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms
    },
  }
}

function makeRepo(clock = makeClock("2026-07-06T10:00:00.000Z")): {
  repo: InMemoryVolunteerHoursRepository
  clock: ReturnType<typeof makeClock>
} {
  let n = 0
  const repo = new InMemoryVolunteerHoursRepository({
    now: clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  })
  repo.seedJurisdiction(GEOID, "Los Angeles")
  repo.seedUser(HOST, { name: "Hana Host", handle: "hana", avatarUrl: null })
  repo.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null })
  repo.seedUser(OPERATOR, { name: "Olive Operator", handle: "olive", avatarUrl: null })
  repo.seedUser(CIVFIX_OFFICIAL_USER_ID, { name: "CivFix", handle: "civfix", avatarUrl: null })
  repo.seedOrganization({ id: ORG, slug: "beach-crew", name: "Beach Crew" })
  repo.seedCleanup(EVENT, {
    title: "Ocean Beach sweep",
    referenceCode: "EV-1",
    scheduledAt: SCHEDULED_AT,
    timezone: null,
    organizationId: ORG,
  })
  repo.seedCleanup(SAME_DAY_EVENT, {
    title: "Afternoon sweep",
    referenceCode: "EV-2",
    scheduledAt: new Date(`${EVENT_DAY}T15:00:00.000Z`),
    timezone: null,
  })
  return { repo, clock }
}

function eventCredit(hours: number, overrides: { userId?: string; reason?: string } = {}) {
  return {
    operatorId: OPERATOR,
    userId: overrides.userId ?? BOB,
    cleanupId: EVENT,
    geoid: GEOID,
    hours,
    reason: overrides.reason ?? "Attended before signing up",
  }
}

function manualCredit(hours: number, serviceDate = "2026-07-05", operatorId = OPERATOR) {
  return {
    operatorId,
    userId: BOB,
    hours,
    serviceDate,
    reason: "Tabling at the library fair",
  }
}

describe("operator event credit", () => {
  it("writes a real event row attributed to CivFix that counts everywhere an event credit does", async () => {
    const { repo } = makeRepo()

    const { entryId } = await repo.creditEventAsOperator(eventCredit(3))

    const totals = await repo.totalsFor(BOB)
    expect(totals.totalHours).toBe(3)
    expect(totals.byJurisdiction).toEqual([{ geoid: GEOID, name: "Los Angeles", hours: 3 }])
    expect(totals.byOrganization.map((o) => [o.organizationId, o.hours])).toEqual([[ORG, 3]])

    const board = await repo.leaderboard(GEOID, 10, 0, null, false)
    expect(board.entries.map((e) => [e.userId, e.hours])).toEqual([[BOB, 3]])

    const publicList = await repo.listEntries({
      userId: BOB,
      cursor: null,
      limit: 10,
      sources: ["event"],
    })
    expect(publicList.items.map((e) => [e.id, e.cleanupId, e.creditedBy?.id])).toEqual([
      [entryId, EVENT, CIVFIX_OFFICIAL_USER_ID],
    ])

    const hostView = await repo.listEventHours(EVENT, null)
    expect(hostView.entries).toEqual([
      expect.objectContaining({ userId: BOB, hours: 3, creditedByOfficial: true }),
    ])
  })

  it("journals and audits the human operator, not the official account", async () => {
    const { repo } = makeRepo()

    const { entryId } = await repo.creditEventAsOperator(eventCredit(2.5))

    expect(repo.journal).toEqual([
      { cleanupId: EVENT, userId: BOB, actorUserId: OPERATOR, previousHours: null, newHours: 2.5 },
    ])
    expect(repo.audits).toEqual([
      {
        actorId: OPERATOR,
        action: "user.hours_credited",
        target: `user:${BOB}`,
        meta: {
          entryId,
          source: "event",
          cleanupId: EVENT,
          hours: 2.5,
          reason: "Attended before signing up",
        },
      },
    ])
  })

  it("refuses a second credit while the attendee holds a live row for the event", async () => {
    const { repo } = makeRepo()
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 3 }],
    })

    await expect(repo.creditEventAsOperator(eventCredit(2))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already holds 3 h for this event; void that entry first"),
    })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(3)
    expect(repo.audits).toEqual([])
  })

  it("holds the daily cap across events and manual adjustments on the event's local date", async () => {
    const { repo } = makeRepo()
    await repo.creditManual(manualCredit(20, EVENT_DAY))

    await expect(repo.creditEventAsOperator(eventCredit(5))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(
        `already holds 20 h on this date; the daily limit is ${DAILY_HOURS_CAP} h`,
      ),
    })
    await repo.creditEventAsOperator(eventCredit(4))
    expect((await repo.totalsFor(BOB)).totalHours).toBe(24)
  })

  it("applies the same combined cap to a host's credit", async () => {
    const { repo } = makeRepo()
    await repo.creditManual(manualCredit(22, EVENT_DAY))

    await expect(
      repo.logEventHours({
        actorId: HOST,
        cleanupId: SAME_DAY_EVENT,
        geoid: GEOID,
        entries: [{ userId: BOB, hours: 3 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: SAME_DAY_EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 2 }],
    })
  })

  it("revives a voided row in place: same id, exact rollup, new timestamp and attribution", async () => {
    const { repo, clock } = makeRepo()
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 3 }],
    })
    const [hostRow] = (await repo.listEntries({ userId: BOB, cursor: null, limit: 10 })).items
    await repo.voidEntry({
      operatorId: OTHER_OPERATOR,
      userId: BOB,
      entryId: hostRow!.id,
      reason: "Wrong person",
    })
    clock.advance(3_600_000)

    const { entryId } = await repo.creditEventAsOperator(eventCredit(2))

    expect(entryId).toBe(hostRow!.id)
    const totals = await repo.totalsFor(BOB)
    expect(totals.totalHours).toBe(2)
    expect(totals.byJurisdiction).toEqual([{ geoid: GEOID, name: "Los Angeles", hours: 2 }])
    expect(repo.ledgerRow(entryId)).toMatchObject({
      hours: 2,
      createdAt: clock.now(),
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      creditedByOperatorId: OPERATOR,
      note: "Attended before signing up",
      voidedByOperatorId: null,
      voidReason: null,
    })
    expect(repo.ledgerRow(entryId)?.voidedAt).toBeUndefined()
    expect(repo.journal.map((j) => [j.actorUserId, j.previousHours, j.newHours])).toEqual([
      [HOST, null, 3],
      [OTHER_OPERATOR, 3, 0],
      [OPERATOR, 0, 2],
    ])
  })
})

describe("host writes over an operator credit", () => {
  it("an unchanged host re-save keeps the operator's attribution", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditEventAsOperator(eventCredit(3))

    const result = await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 3 }],
    })

    expect(result.changed).toEqual([])
    expect(repo.ledgerRow(entryId)).toMatchObject({
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      creditedByOperatorId: OPERATOR,
    })
  })

  it("a host change takes the row over: the operator and the reason no longer describe it", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditEventAsOperator(eventCredit(3))

    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 2 }],
    })

    expect(repo.ledgerRow(entryId)).toMatchObject({
      hours: 2,
      loggedByUserId: HOST,
      creditedByOperatorId: null,
      note: null,
    })
    expect((await repo.listEventHours(EVENT, null)).entries[0]!.creditedByOfficial).toBe(false)
  })

  it("a host may re-credit an attendee whose entry an operator voided", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditEventAsOperator(eventCredit(3))
    await repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId, reason: "Duplicate" })

    const result = await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 3 }],
    })

    expect(result.changed).toEqual([{ userId: BOB, hours: 3, previousHours: 0 }])
    expect(repo.ledgerRow(entryId)).toMatchObject({
      voidedByOperatorId: null,
      voidReason: null,
      creditedByOperatorId: null,
    })
    expect(repo.ledgerRow(entryId)?.voidedAt).toBeUndefined()
    expect((await repo.totalsFor(BOB)).byJurisdiction).toEqual([
      { geoid: GEOID, name: "Los Angeles", hours: 3 },
    ])
  })
})

describe("operator manual credit", () => {
  it("has no jurisdiction, counts in the total only, and is dated by its service date", async () => {
    const { repo } = makeRepo()

    const { entryId } = await repo.creditManual(manualCredit(1.5, "2026-06-30"))

    const totals = await repo.totalsFor(BOB)
    expect(totals.totalHours).toBe(1.5)
    expect(totals.byJurisdiction).toEqual([])
    expect((await repo.leaderboard(GEOID, 10, 0, null, false)).entries).toEqual([])

    const serviceNoon = new Date("2026-06-30T12:00:00.000Z")
    const [listed] = (await repo.listEntries({ userId: BOB, cursor: null, limit: 10 })).items
    expect(listed).toMatchObject({ id: entryId, source: "manual", jurisdictionGeoid: null })
    expect(listed!.occurredAt).toEqual(serviceNoon)
    const transcript = await repo.entriesForCertificate({
      userId: BOB,
      geoid: null,
      from: null,
      to: null,
      limit: 10,
    })
    expect(transcript.items.map((i) => [i.id, i.occurredAt])).toEqual([[entryId, serviceNoon]])

    expect(repo.audits).toEqual([
      {
        actorId: OPERATOR,
        action: "user.hours_credited",
        target: `user:${BOB}`,
        meta: {
          entryId,
          source: "manual",
          hours: 1.5,
          serviceDate: "2026-06-30",
          reason: "Tabling at the library fair",
        },
      },
    ])
    expect(repo.journal).toEqual([])
  })

  it("refuses the same adjustment from the same operator inside the double-submit window", async () => {
    const { repo, clock } = makeRepo()
    await repo.creditManual(manualCredit(2))

    await expect(repo.creditManual(manualCredit(2))).rejects.toMatchObject({ code: "CONFLICT" })
    await repo.creditManual(manualCredit(2.5))
    await repo.creditManual(manualCredit(2, "2026-07-01"))
    await repo.creditManual(manualCredit(2, "2026-07-05", OTHER_OPERATOR))

    clock.advance(MANUAL_CREDIT_REPEAT_WINDOW_MS)
    await repo.creditManual(manualCredit(2))
    expect((await repo.totalsFor(BOB)).totalHours).toBe(10.5)
  })

  it("caps the service date across manual rows and event rows dated that day", async () => {
    const { repo } = makeRepo()
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 10 }],
    })
    await repo.creditManual(manualCredit(10, EVENT_DAY))

    await expect(repo.creditManual(manualCredit(4.5, EVENT_DAY))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already holds 20 h on this date"),
    })
    await repo.creditManual(manualCredit(4, EVENT_DAY))
    await repo.creditManual(manualCredit(20, "2026-07-05"))
  })
})

describe("operator void", () => {
  it("voids an event row: out of the rollup, journaled (h, 0), audited with the reason", async () => {
    const { repo } = makeRepo()
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 3 }],
    })
    const [row] = (await repo.listEntries({ userId: BOB, cursor: null, limit: 10 })).items

    const voided = await repo.voidEntry({
      operatorId: OPERATOR,
      userId: BOB,
      entryId: row!.id,
      reason: "Did not attend",
    })

    expect(voided).toEqual({ id: row!.id, source: "event", cleanupId: EVENT, hours: 3 })
    const totals = await repo.totalsFor(BOB)
    expect(totals.totalHours).toBe(0)
    expect(totals.byJurisdiction).toEqual([])
    expect((await repo.listEventHours(EVENT, null)).entries).toEqual([])
    expect(repo.journal.at(-1)).toEqual({
      cleanupId: EVENT,
      userId: BOB,
      actorUserId: OPERATOR,
      previousHours: 3,
      newHours: 0,
    })
    expect(repo.audits.at(-1)).toEqual({
      actorId: OPERATOR,
      action: "user.hours_voided",
      target: `user:${BOB}`,
      meta: {
        entryId: row!.id,
        source: "event",
        cleanupId: EVENT,
        hours: 3,
        reason: "Did not attend",
      },
    })
  })

  it("voids a manual row without journaling it", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditManual(manualCredit(2))

    const voided = await repo.voidEntry({
      operatorId: OPERATOR,
      userId: BOB,
      entryId,
      reason: "Typo",
    })

    expect(voided).toEqual({ id: entryId, source: "manual", cleanupId: null, hours: 2 })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(0)
    expect(repo.journal).toEqual([])
  })

  it("answers NOT_FOUND for an unknown entry and for another user's entry", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditManual(manualCredit(2))

    await expect(
      repo.voidEntry({ operatorId: OPERATOR, userId: CAROL, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId: EVENT, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await repo.totalsFor(BOB)).totalHours).toBe(2)
  })

  it("refuses a second void and a retired report credit as CONFLICT", async () => {
    const { repo } = makeRepo()
    const { entryId } = await repo.creditManual(manualCredit(2))
    await repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId, reason: "Typo" })
    const reportRow = repo.seedLegacyReportEntry(BOB, REPORT, GEOID)
    repo.markVoided(reportRow)

    await expect(
      repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId, reason: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already void") })
    await expect(
      repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId: reportRow, reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(repo.audits.filter((a) => a.action === "user.hours_voided")).toHaveLength(1)
  })

  it("refuses to void a live report credit", async () => {
    const { repo } = makeRepo()
    const reportRow = repo.seedLegacyReportEntry(BOB, REPORT, GEOID)

    await expect(
      repo.voidEntry({ operatorId: OPERATOR, userId: BOB, entryId: reportRow, reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("retired") })
  })
})

describe("operator ledger read", () => {
  it("lists voided rows too, newest first, keyset-paged, with the admin-plane attribution", async () => {
    const { repo, clock } = makeRepo()
    await repo.logEventHours({
      actorId: HOST,
      cleanupId: SAME_DAY_EVENT,
      geoid: GEOID,
      entries: [{ userId: BOB, hours: 1 }],
    })
    clock.advance(1_000)
    const event = await repo.creditEventAsOperator(eventCredit(3))
    clock.advance(1_000)
    const manual = await repo.creditManual(manualCredit(2))
    clock.advance(1_000)
    await repo.voidEntry({
      operatorId: OTHER_OPERATOR,
      userId: BOB,
      entryId: manual.entryId,
      reason: "Typo",
    })

    const first = await repo.listOperatorLedger({ userId: BOB, cursor: null, limit: 2 })
    expect(first.items.map((i) => i.id)).toEqual([manual.entryId, event.entryId])
    expect(first.items[0]).toMatchObject({
      source: "manual",
      serviceDate: "2026-07-05",
      event: null,
      jurisdiction: null,
      creditedBy: { id: CIVFIX_OFFICIAL_USER_ID, name: "CivFix", handle: "civfix", official: true },
      operator: { id: OPERATOR, name: "Olive Operator" },
      note: "Tabling at the library fair",
      voidedBy: { id: OTHER_OPERATOR, name: "" },
      voidReason: "Typo",
    })
    expect(first.items[0]!.voidedAt).toBeInstanceOf(Date)
    expect(first.items[1]).toMatchObject({
      event: { id: EVENT, title: "Ocean Beach sweep", referenceCode: "EV-1" },
      jurisdiction: { geoid: GEOID, name: "Los Angeles" },
      occurredAt: SCHEDULED_AT,
      voidedAt: null,
    })
    expect(first.nextCursor).not.toBeNull()

    const second = await repo.listOperatorLedger({
      userId: BOB,
      cursor: parseTimeCursor(first.nextCursor!),
      limit: 2,
    })
    expect(second.items.map((i) => [i.source, i.creditedBy?.id, i.operator])).toEqual([
      ["event", HOST, null],
    ])
    expect(second.nextCursor).toBeNull()
  })

  it("never returns more than the ledger page cap", async () => {
    const { repo, clock } = makeRepo()
    for (let day = 1; day <= 60; day++) {
      await repo.creditManual(
        manualCredit(0.25, `2026-05-${String((day % 28) + 1).padStart(2, "0")}`),
      )
      clock.advance(MANUAL_CREDIT_REPEAT_WINDOW_MS)
    }

    const page = await repo.listOperatorLedger({ userId: BOB, cursor: null, limit: 500 })
    expect(page.items).toHaveLength(50)
    expect(page.nextCursor).not.toBeNull()
  })

  it("totals match the profile total and count live and voided entries", async () => {
    const { repo } = makeRepo()
    await repo.creditEventAsOperator(eventCredit(3))
    const manual = await repo.creditManual(manualCredit(2))
    await repo.creditManual(manualCredit(1, "2026-07-01"))
    await repo.voidEntry({
      operatorId: OPERATOR,
      userId: BOB,
      entryId: manual.entryId,
      reason: "Typo",
    })

    const totals = await repo.operatorLedgerTotals(BOB)
    expect(totals).toEqual({ totalHours: 4, liveEntries: 2, voidedEntries: 1 })
    expect(totals.totalHours).toBe((await repo.totalsFor(BOB)).totalHours)
  })
})

describe("certificates listing a ledger entry", () => {
  function certificate(
    certs: InMemoryCertificateRepository,
    input: { userId: string; code: string; entryIds: string[]; issuedAt: string },
  ) {
    const snapshot = buildTranscriptModel({
      holder: { userId: input.userId, displayName: "Bob", handle: "bob" },
      rows: input.entryIds.map((id) => ({
        id,
        source: "event" as const,
        hours: 1,
        occurredAt: SCHEDULED_AT,
      })),
      locale: "en",
    })
    return certs.insert({
      id: `${input.code}-id`,
      userId: input.userId,
      code: input.code,
      locale: "en",
      holderName: "Bob",
      holderHandle: "bob",
      holderVerified: false,
      totalHours: input.entryIds.length,
      entryCount: input.entryIds.length,
      periodStart: null,
      periodEnd: null,
      ledgerFingerprint: `fp-${input.code}`,
      snapshot,
      r2Key: `certs/${input.code}.pdf`,
      documentSha256: "0".repeat(64),
      byteSize: 1,
      issuedAt: new Date(input.issuedAt),
    })
  }

  it("names only the holder's live certificates whose snapshot itemised the entry, newest first", async () => {
    const certs = new InMemoryCertificateRepository()
    const entry = "00000000-0000-4000-8000-0000000000e1"
    await certificate(certs, {
      userId: BOB,
      code: "OLD",
      entryIds: [entry],
      issuedAt: "2026-07-01T00:00:00Z",
    })
    await certificate(certs, {
      userId: BOB,
      code: "NEW",
      entryIds: ["x", entry],
      issuedAt: "2026-07-03T00:00:00Z",
    })
    await certificate(certs, {
      userId: BOB,
      code: "GONE",
      entryIds: [entry],
      issuedAt: "2026-07-02T00:00:00Z",
    })
    await certificate(certs, {
      userId: BOB,
      code: "OTHER",
      entryIds: ["x"],
      issuedAt: "2026-07-04T00:00:00Z",
    })
    await certificate(certs, {
      userId: CAROL,
      code: "CAROL",
      entryIds: [entry],
      issuedAt: "2026-07-05T00:00:00Z",
    })
    await certs.revoke(BOB, "GONE", "holder", new Date("2026-07-06T00:00:00Z"))

    expect(await certs.liveCodesListingEntry(BOB, entry)).toEqual([
      { code: "NEW", issuedAt: new Date("2026-07-03T00:00:00Z") },
      { code: "OLD", issuedAt: new Date("2026-07-01T00:00:00Z") },
    ])
  })
})
