import { describe, expect, it } from "vitest"
import { AdminUserHoursResponseSchema, type AdminCreditUserHoursRequest } from "@civfix/shared"
import { CIVFIX_OFFICIAL_USER_ID } from "../../src/auth/official-account.js"
import { InMemoryAdminUserRepository } from "../helpers/admin/admin-user-repository.memory.js"
import {
  HOURS_CREDIT_NOTICE_LINK,
  makeAdminUserHoursService,
  type AdminUserHoursService,
} from "../../src/services/admin/admin-user-hours-service.js"
import { buildTranscriptModel } from "../../src/services/certificate-model.js"
import { InMemoryCertificateRepository } from "../helpers/certificate-repository.memory.js"
import type { NotificationService } from "../../src/services/notification-service.js"
import { InMemoryVolunteerHoursRepository } from "../helpers/volunteer-hours-repository.memory.js"
import type { CleanupHoursView } from "../../src/services/volunteer-hours-service.js"

const HOST = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const OPERATOR = "99999999-9999-4999-8999-999999999999"
const OTHER_OPERATOR = "88888888-8888-4888-8888-888888888888"
const UNKNOWN = "77777777-7777-4777-8777-777777777777"
const EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
const REPORT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const GEOID = "0644000"
const SCHEDULED_AT = new Date("2026-07-04T08:00:00.000Z")
const NOW = "2026-07-06T10:00:00.000Z"

function endedEvent(patch: Partial<CleanupHoursView> = {}): CleanupHoursView {
  return {
    organizerUserId: HOST,
    status: "done",
    visibility: "public",
    jurisdictionGeoid: GEOID,
    title: "Ocean Beach sweep",
    scheduledAt: SCHEDULED_AT,
    endsAt: new Date("2026-07-04T12:00:00.000Z"),
    completedAt: null,
    timezone: null,
    ...patch,
  }
}

interface SentNotice {
  userId: string
  type: string
  titleKey: string | undefined
  bodyKey: string | undefined
  vars: Record<string, unknown>
  link: string | undefined
}

interface Harness {
  svc: AdminUserHoursService
  hours: InMemoryVolunteerHoursRepository
  accounts: InMemoryAdminUserRepository
  certificates: InMemoryCertificateRepository
  sent: SentNotice[]
  bumps: string[]
  warnings: unknown[]
  setEvent(view: CleanupHoursView | null): void
  setNow(iso: string): void
}

function harness(opts: { notifierFails?: boolean } = {}): Harness {
  let at = Date.parse(NOW)
  const now = () => new Date(at)
  let n = 0
  const hours = new InMemoryVolunteerHoursRepository({
    now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  })
  hours.seedJurisdiction(GEOID, "Los Angeles")
  hours.seedUser(HOST, { name: "Hana Host", handle: "hana", avatarUrl: null })
  hours.seedUser(BOB, { name: "Bob", handle: "bob", avatarUrl: null })
  hours.seedUser(OPERATOR, { name: "Olive Operator", handle: "olive", avatarUrl: null })
  hours.seedUser(CIVFIX_OFFICIAL_USER_ID, { name: "CivFix", handle: "civfix", avatarUrl: null })
  hours.seedCleanup(EVENT, {
    title: "Ocean Beach sweep",
    referenceCode: "EV-1",
    scheduledAt: SCHEDULED_AT,
    timezone: null,
  })

  const accounts = new InMemoryAdminUserRepository()
  accounts.seedUser({ id: BOB, name: "Bob", handle: "bob" })
  accounts.seedUser({ id: HOST, name: "Hana Host", handle: "hana" })
  accounts.seedUser({ id: OPERATOR, name: "Olive Operator", role: "operator" })
  accounts.seedUser({ id: OTHER_OPERATOR, name: "Otto Operator", role: "operator" })
  accounts.seedUser({ id: CIVFIX_OFFICIAL_USER_ID, name: "CivFix", handle: "civfix" })

  const certificates = new InMemoryCertificateRepository()
  const sent: SentNotice[] = []
  const bumps: string[] = []
  const warnings: unknown[] = []
  let event: CleanupHoursView | null = endedEvent()

  const notifier: Pick<NotificationService, "createNotification"> = {
    createNotification: (userId, input) => {
      if (opts.notifierFails === true) return Promise.reject(new Error("push outage"))
      sent.push({
        userId,
        type: input.type,
        titleKey: input.titleKey,
        bodyKey: input.bodyKey,
        vars: input.vars ?? {},
        link: input.link ?? undefined,
      })
      return Promise.resolve({} as Awaited<ReturnType<NotificationService["createNotification"]>>)
    },
  }

  const svc = makeAdminUserHoursService({
    hours,
    certificates,
    accounts,
    events: { load: () => Promise.resolve(event) },
    insightsInvalidator: {
      bumpInsightsGeneration: (cleanupId) => {
        bumps.push(cleanupId)
        return Promise.resolve()
      },
    },
    notifier,
    logger: { warn: (obj) => warnings.push(obj) },
    now,
  })
  return {
    svc,
    hours,
    accounts,
    certificates,
    sent,
    bumps,
    warnings,
    setEvent: (view) => {
      event = view
    },
    setNow: (iso) => {
      at = Date.parse(iso)
    },
  }
}

function eventCredit(
  hours: number,
  patch: Partial<Extract<AdminCreditUserHoursRequest, { kind: "event" }>> = {},
): AdminCreditUserHoursRequest {
  return {
    id: BOB,
    kind: "event",
    eventId: EVENT,
    hours,
    reason: "Signed up at the event",
    ...patch,
  }
}

function manualCredit(
  hours: number,
  serviceDate = "2026-07-05",
  patch: Partial<Extract<AdminCreditUserHoursRequest, { kind: "manual" }>> = {},
): AdminCreditUserHoursRequest {
  return {
    id: BOB,
    kind: "manual",
    hours,
    serviceDate,
    reason: "Tabling at the library fair",
    ...patch,
  }
}

describe("getUserHours", () => {
  it("lists every row, voided and retired ones included, with nulls present rather than omitted", async () => {
    const h = harness()
    h.hours.seedLegacyReportEntry(BOB, REPORT, GEOID, 0.1)
    const event = await h.svc.creditUserHours(OPERATOR, eventCredit(3))
    const manual = await h.svc.creditUserHours(OPERATOR, manualCredit(2))
    await h.svc.voidUserHours(OTHER_OPERATOR, { id: BOB, entryId: manual.entryId, reason: "Typo" })

    const res = await h.svc.getUserHours({ id: BOB })

    expect(AdminUserHoursResponseSchema.parse(res)).toEqual(res)
    expect(res.totals).toEqual({ totalHours: 3.1, liveEntries: 2, voidedEntries: 1 })
    expect(res.nextCursor).toBeNull()
    const [voidedManual, eventRow, reportRow] = res.items
    expect(voidedManual).toEqual({
      id: manual.entryId,
      source: "manual",
      hours: 2,
      occurredAt: "2026-07-05T12:00:00.000Z",
      creditedAt: NOW,
      serviceDate: "2026-07-05",
      event: null,
      jurisdiction: null,
      creditedBy: {
        id: CIVFIX_OFFICIAL_USER_ID,
        name: "CivFix",
        handle: "civfix",
        official: true,
      },
      operator: { id: OPERATOR, name: "Olive Operator" },
      note: "Tabling at the library fair",
      voidedAt: NOW,
      voidedBy: { id: OTHER_OPERATOR, name: "" },
      voidReason: "Typo",
      voidable: false,
    })
    expect(eventRow).toMatchObject({
      id: event.entryId,
      source: "event",
      serviceDate: null,
      event: { id: EVENT, title: "Ocean Beach sweep", referenceCode: "EV-1" },
      jurisdiction: { geoid: GEOID, name: "Los Angeles" },
      occurredAt: SCHEDULED_AT.toISOString(),
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      voidable: true,
    })
    expect(reportRow).toMatchObject({
      source: "report",
      creditedBy: null,
      operator: null,
      note: null,
      voidable: false,
    })
  })

  it("marks no entry voidable on an account the void path refuses", async () => {
    const h = harness()
    await h.hours.creditManual({
      operatorId: OTHER_OPERATOR,
      userId: OPERATOR,
      hours: 1,
      serviceDate: "2026-07-01",
      reason: "Seeded before the operator role was granted",
    })

    const res = await h.svc.getUserHours({ id: OPERATOR })
    expect(res.items).toHaveLength(1)
    expect(res.items[0]?.voidable).toBe(false)
  })

  it("pages with the requested limit and a cursor", async () => {
    const h = harness()
    await h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-01"))
    await h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-02"))
    await h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-03"))

    const first = await h.svc.getUserHours({ id: BOB, limit: 2 })
    expect(first.items.map((i) => i.serviceDate)).toEqual(["2026-07-03", "2026-07-02"])
    const second = await h.svc.getUserHours({ id: BOB, limit: 2, cursor: first.nextCursor! })
    expect(second.items.map((i) => i.serviceDate)).toEqual(["2026-07-01"])
    expect(second.nextCursor).toBeNull()
  })

  it("is NOT_FOUND for an unknown account", async () => {
    const h = harness()
    await expect(h.svc.getUserHours({ id: UNKNOWN })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("creditUserHours: event credit", () => {
  it("credits a non-member as CivFix, bells them with the event title and bumps the event's insights", async () => {
    const h = harness()

    const res = await h.svc.creditUserHours(OPERATOR, eventCredit(3.333))

    expect(res).toEqual({ entryId: expect.any(String), totalHours: 3.33 })
    expect(h.hours.ledgerRow(res.entryId)).toMatchObject({
      source: "event",
      hours: 3.33,
      geoid: GEOID,
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      creditedByOperatorId: OPERATOR,
      note: "Signed up at the event",
    })
    expect(h.hours.audits).toEqual([
      expect.objectContaining({ actorId: OPERATOR, action: "user.hours_credited" }),
    ])
    expect(h.bumps).toEqual([EVENT])
    expect(h.sent).toEqual([
      {
        userId: BOB,
        type: "hours_logged",
        titleKey: "notification.hours_logged.title",
        bodyKey: "notification.hours_logged.body",
        vars: { hours: 3.33, title: "Ocean Beach sweep" },
        link: HOURS_CREDIT_NOTICE_LINK,
      },
    ])
    expect(HOURS_CREDIT_NOTICE_LINK).toBe("/profile")
  })

  it("is NOT_FOUND for an unknown event", async () => {
    const h = harness()
    h.setEvent(null)
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(1))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("refuses a cancelled event, an event that has not ended and one that ran under 15 minutes", async () => {
    const h = harness()
    h.setEvent(endedEvent({ status: "cancelled" }))
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(1))).rejects.toMatchObject({
      code: "CONFLICT",
    })

    h.setEvent(endedEvent({ endsAt: new Date("2026-07-06T12:00:00.000Z") }))
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(1))).rejects.toMatchObject({
      code: "CONFLICT",
    })

    h.setEvent(endedEvent({ endsAt: new Date("2026-07-04T08:10:00.000Z") }))
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(0.1))).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(h.sent).toEqual([])
    expect(h.bumps).toEqual([])
  })

  it("names the exact window cap on the hours field", async () => {
    const h = harness()
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(5.5))).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { hours: "this event ran for 4 h, so at most 5 h may be credited per attendee" },
    })
  })

  it("is a CONFLICT while the user already holds a live row for the event", async () => {
    const h = harness()
    await h.svc.creditUserHours(OPERATOR, eventCredit(2))
    await expect(h.svc.creditUserHours(OPERATOR, eventCredit(1))).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(h.sent).toHaveLength(1)
  })
})

describe("creditUserHours: manual credit", () => {
  it("credits a dated adjustment with no jurisdiction, bells with the adjustment keys and bumps nothing", async () => {
    const h = harness()

    const res = await h.svc.creditUserHours(OPERATOR, manualCredit(1.5))

    expect(res.totalHours).toBe(1.5)
    expect(h.hours.ledgerRow(res.entryId)).toMatchObject({
      source: "manual",
      geoid: null,
      serviceDate: "2026-07-05",
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      creditedByOperatorId: OPERATOR,
    })
    expect(h.bumps).toEqual([])
    expect(h.sent).toEqual([
      {
        userId: BOB,
        type: "hours_logged",
        titleKey: "notification.hours_adjusted.title",
        bodyKey: "notification.hours_adjusted.body",
        vars: { hours: 1.5 },
        link: "/profile",
      },
    ])
  })

  it("refuses a service date after today in the default event time zone", async () => {
    const h = harness()
    h.setNow("2026-07-07T03:00:00.000Z")

    await expect(
      h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-07")),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { serviceDate: "The service date can't be in the future." },
    })
    const today = await h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-06"))
    expect(h.hours.ledgerRow(today.entryId)?.serviceDate).toBe("2026-07-06")
  })

  it("keeps the credit when the bell fails, and logs the failure", async () => {
    const h = harness({ notifierFails: true })
    const res = await h.svc.creditUserHours(OPERATOR, manualCredit(1))
    expect(h.hours.ledgerRow(res.entryId)).not.toBeNull()
    expect(h.warnings).toHaveLength(1)
  })
})

describe("creditUserHours: target guards", () => {
  it("refuses the official account, an operator account and the operator themselves", async () => {
    const h = harness()
    await expect(
      h.svc.creditUserHours(
        OPERATOR,
        manualCredit(1, "2026-07-05", { id: CIVFIX_OFFICIAL_USER_ID }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-05", { id: OTHER_OPERATOR })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-05", { id: OPERATOR })),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You can't credit volunteer hours to yourself.",
    })
  })

  it("is NOT_FOUND for an unknown account and a CONFLICT for a deleted one", async () => {
    const h = harness()
    await expect(
      h.svc.creditUserHours(OPERATOR, eventCredit(1, { id: UNKNOWN })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    h.accounts.seedUser({ id: UNKNOWN, deletedAt: new Date("2026-07-01T00:00:00.000Z") })
    await expect(
      h.svc.creditUserHours(OPERATOR, eventCredit(1, { id: UNKNOWN })),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(h.hours.audits).toEqual([])
  })

  it("credits a suspended or banned account", async () => {
    const h = harness()
    h.accounts.seedUser({ id: BOB, accountStatus: "banned" })
    const res = await h.svc.creditUserHours(OPERATOR, manualCredit(1))
    expect(res.totalHours).toBe(1)

    h.accounts.seedUser({ id: HOST, accountStatus: "suspended" })
    const host = await h.svc.creditUserHours(OPERATOR, manualCredit(1, "2026-07-05", { id: HOST }))
    expect(host.totalHours).toBe(1)
  })
})

describe("voidUserHours", () => {
  it("voids an event row without a bell, bumps the event's insights and lists the live certificates that itemised it", async () => {
    const h = harness()
    const { entryId } = await h.svc.creditUserHours(OPERATOR, eventCredit(3))
    const snapshot = buildTranscriptModel({
      holder: { userId: BOB, displayName: "Bob", handle: "bob" },
      rows: [{ id: entryId, source: "event" as const, hours: 3, occurredAt: SCHEDULED_AT }],
      locale: "en",
    })
    await h.certificates.insert({
      id: "cert-1",
      userId: BOB,
      code: "ABCD2345",
      locale: "en",
      holderName: "Bob",
      holderHandle: "bob",
      holderVerified: false,
      totalHours: 3,
      entryCount: 1,
      periodStart: null,
      periodEnd: null,
      ledgerFingerprint: "fp-1",
      snapshot,
      r2Key: "certs/ABCD2345.pdf",
      documentSha256: "0".repeat(64),
      byteSize: 1,
      issuedAt: new Date("2026-07-05T09:00:00.000Z"),
    })
    h.sent.length = 0
    h.bumps.length = 0

    const res = await h.svc.voidUserHours(OPERATOR, { id: BOB, entryId, reason: "Wrong person" })

    expect(res).toEqual({
      ok: true,
      affectedCertificates: [{ code: "ABCD2345", issuedAt: "2026-07-05T09:00:00.000Z" }],
    })
    expect(h.sent).toEqual([])
    expect(h.bumps).toEqual([EVENT])
    expect((await h.svc.getUserHours({ id: BOB })).totals.totalHours).toBe(0)
    expect(h.hours.audits.map((a) => a.action)).toEqual([
      "user.hours_credited",
      "user.hours_voided",
    ])
  })

  it("does not bump any event's insights for a manual row and returns no certificates when none listed it", async () => {
    const h = harness()
    const { entryId } = await h.svc.creditUserHours(OPERATOR, manualCredit(2))
    h.sent.length = 0

    const res = await h.svc.voidUserHours(OPERATOR, { id: BOB, entryId, reason: "Duplicate" })

    expect(res).toEqual({ ok: true, affectedCertificates: [] })
    expect(h.bumps).toEqual([])
    expect(h.sent).toEqual([])
  })

  it("voids on a deleted account but never on an operator or the official account", async () => {
    const h = harness()
    const { entryId } = await h.svc.creditUserHours(OPERATOR, manualCredit(2))
    h.accounts.seedUser({ id: BOB, deletedAt: new Date("2026-07-06T09:00:00.000Z") })

    await expect(
      h.svc.voidUserHours(OPERATOR, { id: BOB, entryId, reason: "Bad credit" }),
    ).resolves.toMatchObject({ ok: true })

    await expect(
      h.svc.voidUserHours(OPERATOR, { id: OTHER_OPERATOR, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.svc.voidUserHours(OPERATOR, { id: CIVFIX_OFFICIAL_USER_ID, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.svc.voidUserHours(OPERATOR, { id: UNKNOWN, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("scopes the entry to the account named in the path and refuses a second void", async () => {
    const h = harness()
    const { entryId } = await h.svc.creditUserHours(OPERATOR, manualCredit(2))

    await expect(
      h.svc.voidUserHours(OPERATOR, { id: HOST, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.svc.voidUserHours(OPERATOR, { id: BOB, entryId, reason: "x" })
    await expect(
      h.svc.voidUserHours(OPERATOR, { id: BOB, entryId, reason: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })
})
